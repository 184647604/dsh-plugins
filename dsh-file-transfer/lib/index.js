// dsh-file-transfer — raw-byte file upload endpoint for dsh web.
//
// ## Why this plugin exists
//
// dsh already ships `POST /api/session/uploadFileBinary`, but it stores bytes
// through the attachment service (`ctx.attachments.saveFileStream`). That
// service proves durability by walking EVERY ancestor directory of DSH_HOME up
// to the filesystem root and fsync-ing each one:
//
//   ensureDurableHome(home) → ensureDurableDirectory(home, parse(home).root)
//
// On Termux the ancestor chain is
//   /data/data/com.termux/files/home/.dsh → … → /data/data → /data → /
// and `open("/data/data", O_RDONLY)` fails because /data/data is not readable by
// the Termux app. Every upload therefore dies with:
//
//   EACCES: permission denied, open '/data/data'
//
// There is no configuration to bound that walk, and ~/.dsh/attachments is never
// created — so on Termux *no* upload has ever succeeded through the official
// endpoint (the Web UI's own file picker included). This plugin sidesteps the
// attachment store entirely: it streams raw bytes straight to a caller-chosen
// path on disk.
//
// ## Surface
//
//   POST /api/transfer.write?path=<absolute dir>&name=<file name>
//        Content-Type: application/octet-stream, body = raw bytes.
//        → 200 {"ok":true,"value":{"path":"…","name":"…","bytes":N}}
//
//   POST /api/transfer.describe       (standard unary client-request envelope)
//        → {"type":"server-response","rpcId":…,"result":{"ok":true,"value":{…}}}
//
//   POST /api/transfer.list           payload {"path":"<absolute dir>","limit"?:N}
//        → {"type":"server-response","rpcId":…,"result":{"ok":true,"value":{
//             "defaultRoot":…, "capabilities":[…],
//             "path":…, "entries":[{"name":…,"type":"file|directory|other","size"?:N}],
//             "truncated":false}}}
//
// `list` exists because the official workspaceFiles namespace is ASYMMETRIC:
// `list` calls confine() and refuses anything outside the session workspace, while
// `readBytes`/`stat` go through locateFile() with NO containment check (the upstream
// doc comment says outright "files outside it are allowed"). So an absolute path
// outside the workspace is readable but not enumerable — you can fetch a file you
// already know, yet you can never discover one. This endpoint supplies the missing
// half so the App can browse the backend like a file manager.
//
// Being a plugin-center SUB-plugin (like dsh-mcp-admin), it is not protected:
// the center can enable, disable and remove it freely.

import {
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';
import { createGzip } from 'node:zlib';

const PLUGIN_ID = 'dsh-file-transfer';
const VERSION = '0.2.1';

/** 8 GiB — a safety rail, not a product limit; override with config.maxBytes. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/** 一次列举最多返回多少条；超出用 truncated 标记。 */
const MAX_ENTRIES = 2000;

/** dsh 的 loopback 判定（与 dsh-bridge-center / dsh-mcp-admin 一致）。 */
function isLoopbackHost(value) {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(value ?? '');
}

/**
 * CSRF 门禁：浏览器跨站请求会被 Origin 校验挡下；非浏览器客户端（Android App、
 * curl、脚本）不带 Origin，直接放行。
 */
function sameOrigin(req) {
  const origin = req.headers['origin'];
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const hostHdr = req.headers['host'] || '';
    return isLoopbackHost(u.hostname) || u.host === hostHdr;
  } catch {
    return false;
  }
}

/**
 * 只接受纯文件名：丢掉任何目录成分，拒绝 `.`/`..` 与路径分隔符。
 * 否则 `name=../../etc/passwd` 就能逃出调用方选定的目录。
 */
function safeFileName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return name;
}

/** `child` 是否就是 `root` 或位于其下（按路径分量比较，避免 /a/bc 匹配 /a/b）。 */
function within(child, root) {
  if (child === root) return true;
  return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** `/proc/mounts` 里的挂载点；macOS / Windows 没有这个文件，返回空数组。 */
function mountPoints() {
  try {
    return readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' ')[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 目录真能列出来才算数。
 *
 * 只判断"存在"是不够的：Android 上 `/` 与 `/data/data` 都存在，但一列就是 EACCES。
 * 推荐一个点进去就报错的入口，比不推荐更糟。
 */
function readableDir(path) {
  try {
    if (!statSync(path).isDirectory()) return null;
    readdirSync(path); // 真正的可读性判据
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** 读一个目录里的条目名，失败就给空数组。 */
function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 发现「全盘」浏览的入口列表。
 *
 * 不能写死一个根 —— 后端可能是四种完全不同的系统：
 *
 *   Windows   盘符 C:/D:/…（A:、B: 是软驱，跳过）
 *   Android   `/` 是 EACCES；SD 卡挂在 /storage/<UUID>；内外存储是 /storage/emulated/0
 *   Linux     /mnt/*、/media/<user>/*、/
 *   macOS     /Volumes/*、/
 *
 * 所以逐个探测、**实际列一次**，只回报真的进得去的目录，并按用途排好顺序。
 * 外置 SD 卡从 /proc/mounts 里认（/storage 自身 EACCES，列不出来）。
 */
/**
 * 按平台生成候选入口。
 *
 * 拆成纯函数是为了**在没有该平台的机器上也能测** —— Windows 分支没法在 Android 上跑，
 * 但盘符清单和路径分隔符这类东西恰恰最需要测（`C:\` 写成 `C:/` 就是坏的）。
 */
function placeCandidates(platform, isTermux, mounts = [], cwd = process.cwd()) {
  const candidates = []; // [label, path]，顺序即下拉列表顺序

  // 排第一：**dsh 服务进程的工作目录**。
  //
  // 这是"用户平时在哪儿干活"最可靠的信号 —— 它就是把 dsh web 起在那个目录的结果。
  // 盘符根（C:\）虽然更"根"，但几乎没人真的直接在盘根里建项目；而 places[0] 同时
  // 就是 defaultRoot，所以浏览器的默认落点会直接落在项目目录上。
  //
  // 不可读时由 discoverPlaces 的 readableDir 筛掉，自动退到下一个候选。
  if (typeof cwd === 'string' && cwd.trim()) {
    candidates.push(['dsh 工作目录', resolve(cwd)]);
  }

  if (platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      candidates.push([`${letter} 盘`, `${letter}:\\`]);
    }
    candidates.push(['用户目录', homedir()]);
  } else if (platform === 'android' || isTermux) {
    candidates.push(['内部存储', '/storage/emulated/0']);
    for (const mp of mounts) {
      // /storage/1234-ABCD 这种才是真的外置卡；/storage/emulated 是本机存储，已单独加过
      if (/^\/storage\/[^/]+$/.test(mp) && !mp.startsWith('/storage/emulated')) {
        candidates.push([`SD 卡 ${basename(mp)}`, mp]);
      }
    }
    candidates.push(['主目录', homedir()]);
  } else {
    candidates.push(['根目录', '/']);
    for (const name of safeReaddir('/mnt')) candidates.push([name, join('/mnt', name)]);
    for (const user of safeReaddir('/media')) {
      // Linux 是 /media/<user>/<卷>；有些发行版直接是 /media/<卷>
      const nested = safeReaddir(join('/media', user));
      if (nested.length === 0) candidates.push([user, join('/media', user)]);
      for (const vol of nested) candidates.push([vol, join('/media', user, vol)]);
    }
    for (const vol of safeReaddir('/Volumes')) candidates.push([vol, join('/Volumes', vol)]);
    candidates.push(['主目录', homedir()]);
  }

  return candidates;
}

/**
 * 发现「全盘」浏览的入口列表：生成候选，再逐个**实际列一次**筛掉进不去的。
 */
function discoverPlaces(
  platform = process.platform,
  isTermux = /com\.termux/.test(process.env.PREFIX || '')
) {
  const places = [];
  const seen = new Set();
  for (const [label, path] of placeCandidates(platform, isTermux, mountPoints())) {
    const real = readableDir(path);
    if (real === null || seen.has(real)) continue; // 不可读，或和前面某个是同一个地方
    seen.add(real);
    places.push({ label, path });
  }
  return places;
}

/** tar 的一切都按 512 字节块对齐。 */
const TAR_BLOCK = 512;

/** ustar 单个文件的八进制上限：11 位八进制 = 8 GiB - 1。 */
const TAR_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024 - 1;

/** 递归深度上限：防符号链接环与病态深树把后端拖死。 */
const TAR_MAX_DEPTH = 32;

/** 条目数上限：一次打包不该无界。 */
const TAR_MAX_ENTRIES = 20000;

/** 把数字写成 n 位八进制并补 NUL —— tar 的数值字段就是这个格式。 */
function octalField(value, digits) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  return n.toString(8).padStart(digits, '0').slice(-digits) + '\0';
}

/**
 * 把相对路径拆成 ustar 的 name(100) + prefix(155)。
 *
 * ustar 没有 GNU LongLink 之外的扩展，但 prefix 字段能表达绝大多数深层路径，
 * 而且不需要接收端额外支持 —— 拆不出来才返回 null（调用方计为跳过）。
 */
function splitUstarName(rel) {
  if (Buffer.byteLength(rel, 'utf8') <= 100) return { name: rel, prefix: '' };
  let cut = rel.length;
  while (cut > 0) {
    cut = rel.lastIndexOf('/', cut - 1);
    if (cut <= 0) return null;
    const prefix = rel.slice(0, cut);
    const name = rel.slice(cut + 1);
    if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
      return { name, prefix };
    }
  }
  return null;
}

/** 构造一个 512 字节的 ustar 头；名字无法表达时返回 null。 */
function buildUstarHeader(entry) {
  const split = splitUstarName(entry.rel);
  if (split === null) return null;
  const buf = Buffer.alloc(TAR_BLOCK);
  buf.write(split.name, 0, 100, 'utf8');
  buf.write(octalField(entry.mode ?? 0o644, 7), 100, 8, 'ascii');
  buf.write(octalField(0, 7), 108, 8, 'ascii'); // uid
  buf.write(octalField(0, 7), 116, 8, 'ascii'); // gid
  buf.write(octalField(entry.size, 11), 124, 12, 'ascii');
  buf.write(octalField(Math.floor((entry.mtimeMs ?? Date.now()) / 1000), 11), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // 校验和先填 8 个空格
  buf.write(entry.typeflag, 156, 1, 'ascii');
  buf.write('ustar', 257, 5, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write('root', 265, 4, 'ascii');
  buf.write('root', 297, 4, 'ascii');
  buf.write(split.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(octalField(sum, 6) + ' ', 148, 8, 'ascii');
  return buf;
}

/**
 * 深度优先收集要打包的条目。
 *
 * **符号链接一律跳过**：跟随它们可能成环，原样打包到 Android 侧又建不出来
 * （SAF 根本不支持建符号链接），两头都不讨好。跳过数会回报给客户端。
 */
async function walkTree(root, wrapName) {
  const entries = [];
  let totalBytes = 0;
  let skipped = 0;
  let truncated = false;

  const walk = async (absDir, relDir, depth) => {
    if (truncated) return;
    if (depth > TAR_MAX_DEPTH) {
      skipped += 1;
      return;
    }
    let dirents;
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      skipped += 1; // 读不动的目录（Android 上 /data/data 那种）跳过，不中断整包
      return;
    }
    // 根目录本身不打包：wrap=false 时 relDir 是空串，会写出一个**空名字**的条目，
    // 而且子条目会带上前导 "/"（解包器会当成绝对路径 / 路径穿越）。
    if (relDir) entries.push({ rel: relDir, abs: absDir, typeflag: '5', size: 0, mode: 0o755 });
    dirents.sort((a, b) => a.name.localeCompare(b.name)); // 稳定顺序，产物可复现
    for (const d of dirents) {
      if (truncated) return;
      if (d.isSymbolicLink() || (!d.isDirectory() && !d.isFile())) {
        skipped += 1;
        continue;
      }
      const abs = join(absDir, d.name);
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isDirectory()) {
        await walk(abs, rel, depth + 1);
        continue;
      }
      if (entries.length >= TAR_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const info = await stat(abs).catch(() => null);
      if (info === null || !info.isFile()) {
        skipped += 1;
        continue;
      }
      if (info.size > TAR_MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      entries.push({
        rel,
        abs,
        typeflag: '0',
        size: info.size,
        mode: info.mode,
        mtimeMs: info.mtimeMs,
      });
      totalBytes += info.size;
    }
  };

  await walk(root, wrapName, 0);
  return { entries, totalBytes, skipped, truncated };
}

/**
 * 把条目流式吐成 tar。
 *
 * 关键点：**每个文件严格按头部声明的大小输出**。若文件在打包途中被改写、长度对不上，
 * 就补零或截断到声明值 —— 少一个字节后面全部错位，整包作废。
 */
async function* tarStream(entries) {
  for (const entry of entries) {
    const header = buildUstarHeader(entry);
    if (header === null) continue; // 路径长到 ustar 表达不了
    yield header;
    if (entry.typeflag !== '0') continue;
    let written = 0;
    try {
      for await (const chunk of createReadStream(entry.abs)) {
        const room = entry.size - written;
        if (room <= 0) break;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        written += piece.length;
        yield piece;
      }
    } catch {
      // 读不出来也要把声明的大小补满，否则后面全部错位
    }
    if (written < entry.size) yield Buffer.alloc(entry.size - written);
    const pad = (TAR_BLOCK - (entry.size % TAR_BLOCK)) % TAR_BLOCK;
    if (pad > 0) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(TAR_BLOCK * 2); // 归档结束：两个全零块
}
export { discoverPlaces, placeCandidates };

export default {
  name: PLUGIN_ID,
  // connection 是认证的唯一来源 —— 缺了它本插件的路由就是裸奔的，见 gate() 的长注释。
  // 声明成硬依赖（而不是 ctx.get 后判空）是为了**失败即不可用**：宁可插件不挂载，
  // 也不能在没有认证层的情况下把 /api 端点暴露出去。
  inject: ['webServer', 'connection'],

  apply(ctx, config = {}) {
    const webServer = ctx.webServer;
    const connection = ctx.connection;

    const TOKEN = String(
      config.token || process.env.DSH_FILE_TRANSFER_TOKEN || ''
    ).trim();
    const MAX_BYTES =
      Number(config.maxBytes) > 0 ? Number(config.maxBytes) : DEFAULT_MAX_BYTES;
    // 空 roots = 允许任意绝对路径。**能这么松的前提是 gate() 里那道认证真的生效** ——
    // 在加上认证之前，这里等于「任何能碰到端口的人都能往任意路径写文件」。
    // 需要进一步收紧时在 cordis.patch.yml 的 config.roots 里列白名单。
    const ROOTS = (Array.isArray(config.roots) ? config.roots : [])
      .filter((r) => typeof r === 'string' && r.trim())
      .map((r) => resolve(r));

    const json = (res, status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      });
      res.end(text);
    };

    const gate = (req, res) => {
      if (String(req.method || 'POST').toUpperCase() !== 'POST') {
        json(res, 405, { ok: false, error: { code: 'transfer/method', message: 'method not allowed' } });
        return false;
      }

      // ---------- 认证：必须显式做，且必须用官方那一套 ----------
      //
      // 本插件用 kind:'exact' 注册 /api/<method>。dsh 的认证并不在路由框架里，
      // 而是挂在 client-connection 注册的 kind:'prefix' /api 路由的 handler 第一行
      // （`connection.requestRejection(req)`）。**exact 先于 prefix 匹配**，所以那条
      // prefix 路由根本轮不到执行 —— 插件路由实际上是裸奔的。
      //
      // 这不是理论风险，是实测过的：不带任何 cookie 直接 POST /api/transfer.write
      // 会被正常受理，配上下面 ROOTS 为空（不限路径）就是**任意文件写入**；
      // 在 Windows 上写一个 Startup 目录里的文件即可获得持久化执行。
      //
      // 所以这里把官方的判定原样搬进来，判定范围与官方 /api 路由完全一致、不多不少：
      //   · Host/Origin 围栏不通过 → 403
      //   · 无有效 cookie 会话      → 401
      // 手机 App 走 OkHttp 的 CookieJar 自动带 cookie，不受影响。
      //
      // 下面那段 sameOrigin() 是**保留的纵深防御**，它单独并不构成认证：
      // 它只在请求带 Origin 头时才校验，curl / 脚本 / App 不带 Origin，一律放行。
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        json(res, rejection, {
          ok: false,
          error: {
            code: 'transfer/unauthorized',
            message: rejection === 401 ? 'authentication required' : 'forbidden',
          },
        });
        return false;
      }

      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: { code: 'transfer/origin', message: 'untrusted origin' } });
        return false;
      }
      if (TOKEN) {
        const got = String(req.headers['x-dsh-file-transfer-token'] || '').trim();
        if (got !== TOKEN) {
          json(res, 403, { ok: false, error: { code: 'transfer/token', message: 'invalid token' } });
          return false;
        }
      }
      return true;
    };

    /** 校验目标目录：必须是已存在的绝对目录，且在允许的根之内。 */
    const checkTargetDir = (raw) => {
      if (typeof raw !== 'string' || !raw.trim()) return { error: 'path is required' };
      if (!isAbsolute(raw)) return { error: 'path must be absolute' };
      const dir = resolve(raw);
      if (ROOTS.length > 0 && !ROOTS.some((r) => within(dir, r))) {
        return { error: `path is outside the allowed roots (${ROOTS.join(', ')})` };
      }
      let info;
      try {
        info = statSync(dir);
      } catch {
        return { error: `directory does not exist: ${dir}` };
      }
      if (!info.isDirectory()) return { error: `not a directory: ${dir}` };
      return { dir };
    };

    // ---------- POST /api/transfer.write ----------
    //
    // 边收边写、先写临时文件再 rename：上传中断不会留下一个「看起来完整」的
    // 同名文件，也不会覆盖掉旧文件。
    const handleWrite = (req, res) => {
      if (!gate(req, res)) return;

      const url = new URL(req.url || '/', 'http://dsh.internal');
      const target = checkTargetDir(url.searchParams.get('path'));
      if (target.error) {
        json(res, 400, { ok: false, error: { code: 'transfer/bad-path', message: target.error } });
        return;
      }
      const rawName = url.searchParams.get('name');
      const name = rawName === null ? `upload-${Date.now()}.bin` : safeFileName(rawName);
      if (!name) {
        json(res, 400, { ok: false, error: { code: 'transfer/bad-name', message: 'invalid file name' } });
        return;
      }

      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        json(res, 413, {
          ok: false,
          error: { code: 'transfer/too-large', message: `body exceeds ${MAX_BYTES} bytes` },
        });
        return;
      }

      const finalPath = join(target.dir, name);
      const tempPath = join(target.dir, `.${name}.${randomUUID()}.part`);
      const out = createWriteStream(tempPath, { flags: 'wx', mode: 0o644 });

      let bytes = 0;
      let settled = false;
      const discard = () => {
        try {
          unlinkSync(tempPath);
        } catch {
          /* 临时文件可能尚未创建；忽略 */
        }
      };

      req.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) {
          settled = true;
          req.unpipe(out);
          out.destroy();
          discard();
          json(res, 413, {
            ok: false,
            error: { code: 'transfer/too-large', message: `body exceeds ${MAX_BYTES} bytes` },
          });
          req.resume(); // 把剩余字节排掉，避免连接悬挂
        }
      });

      req.on('error', () => {
        if (settled) return;
        settled = true;
        out.destroy();
        discard();
      });

      out.on('error', (error) => {
        if (settled) return;
        settled = true;
        discard();
        json(res, 500, {
          ok: false,
          error: {
            code: 'transfer/write-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });

      out.on('finish', () => {
        if (settled) return;
        settled = true;
        // 先 fsync 文件本身，再 rename —— 崩溃后不会出现指向未落盘数据的目录项。
        try {
          const fd = openSync(tempPath, 'r');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } catch {
          /* fsync 失败不致命，继续 */
        }
        try {
          renameSync(tempPath, finalPath);
        } catch (error) {
          discard();
          json(res, 500, {
            ok: false,
            error: {
              code: 'transfer/rename-failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
          return;
        }
        ctx.logger?.info?.('[dsh-file-transfer] wrote %s (%d bytes)', finalPath, bytes);
        json(res, 200, { ok: true, value: { path: finalPath, name, bytes } });
      });

      req.pipe(out);
    };
  // ---------- POST /api/transfer.mkdir ----------
  //
  // 在已存在的目录下建一个**子目录**。
  //
  // 参数走**旧协议信封**（和 transfer.list 一样），不是 query string。
  // 这里踩过一次坑：照 transfer.write 写成了读 searchParams，但 write 之所以用 query
  // 是因为它的 body 被文件字节占满了、没有地方放 JSON。App 走的是 callPluginRoute，
  // 发的是 {type,rpcId,method,payload} 信封 —— 读 searchParams 只会永远拿到 path=null。
  // 响应同理必须是 {type:"server-response",rpcId,result}，否则客户端解不出 value。
  //
  // 刻意不用 recursive：父目录已由 checkTargetDir 验证过存在，多级创建只会把
  // “路径填错了”变成一个静默建出来的一串目录。
  //
  // 已存在时回 transfer/exists 而不是当成成功 —— 客户端要靠这个区分“刚建好”和
  // “本来就有一个”，否则用户会以为自己新建成功了，其实只是又打开了那个旧的同名目录。
  const handleMkdir = async (req, res) => {
    if (!gate(req, res)) return;
    const envelope = await readEnvelope(req);
    const payload = envelope?.payload ?? {};
    const rpcId = envelope?.rpcId ?? '';
    const reply = (result) => json(res, 200, { type: 'server-response', rpcId, result });

    const target = checkTargetDir(payload.path);
    if (target.error) {
      reply({ ok: false, error: { code: 'transfer/bad-path', message: target.error } });
      return;
    }
    // safeFileName 会挡掉空 / . / .. / 含路径分隔符 / 含 NUL 的名字
    const name = safeFileName(payload.name);
    if (!name) {
      reply({
        ok: false,
        error: { code: 'transfer/bad-name', message: 'invalid directory name' },
      });
      return;
    }

    const dir = join(target.dir, name);
    try {
      mkdirSync(dir);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        reply({
          ok: false,
          error: { code: 'transfer/exists', message: 'already exists: ' + dir },
        });
        return;
      }
      reply({
        ok: false,
        error: {
          code: 'transfer/mkdir-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    ctx.logger?.info?.('[dsh-file-transfer] made directory %s', dir);
    reply({ ok: true, value: { path: dir, name } });
  };


    /** 读掉请求体并解析出标准一元信封；非 JSON 或空体返回 null。 */
    const readEnvelope = async (req) => {
      let text = '';
      try {
        for await (const chunk of req) text += chunk;
      } catch {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    /** 只在允许的根之内解析绝对路径；这是 list/read 共用的边界。 */
    const checkAllowed = (raw) => {
      if (typeof raw !== 'string' || !raw.trim()) return { error: 'path is required' };
      if (!isAbsolute(raw)) return { error: 'path must be absolute' };
      const dir = resolve(raw);
      if (ROOTS.length > 0 && !ROOTS.some((r) => within(dir, r))) {
        return { error: `path is outside the allowed roots (${ROOTS.join(', ')})` };
      }
      return { dir };
    };

    // ---------- POST /api/transfer.list ----------
    //
    // 补上官方 workspaceFiles 缺的那一半：能列举工作区之外的目录。
    const handleList = async (req, res) => {
      if (!gate(req, res)) return;
      const envelope = await readEnvelope(req);
      const payload = envelope?.payload ?? {};
      const rpcId = envelope?.rpcId ?? '';
      const reply = (result) => json(res, 200, { type: 'server-response', rpcId, result });

      const target = checkAllowed(payload.path);
      if (target.error) {
        reply({ ok: false, error: { code: 'transfer/bad-path', message: target.error } });
        return;
      }
      const info = await stat(target.dir).catch(() => null);
      if (info === null) {
        reply({ ok: false, error: { code: 'transfer/not-found', message: `directory does not exist: ${target.dir}` } });
        return;
      }
      if (!info.isDirectory()) {
        reply({ ok: false, error: { code: 'transfer/not-a-directory', message: `not a directory: ${target.dir}` } });
        return;
      }

      const limit = Number(payload.limit) > 0 ? Math.min(Number(payload.limit), MAX_ENTRIES) : MAX_ENTRIES;
      let dirents;
      try {
        dirents = await readdir(target.dir, { withFileTypes: true });
      } catch (error) {
        reply({
          ok: false,
          error: {
            code: 'transfer/list-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }

      // 目录优先、再按名字排：与官方 list 的观感一致，也让 App 端不必再排一次。
      const truncated = dirents.length > limit;
      const visible = dirents.slice(0, limit);
      const entries = await Promise.all(
        visible.map(async (d) => {
          const full = join(target.dir, d.name);
          let isDir = d.isDirectory();
          let isFile = d.isFile();
          // 跟随符号链接再判类型：/sdcard 这类链接在真实系统里很常见，
          // 一律当成 other 会让用户根本进不去。
          if (d.isSymbolicLink()) {
            const t = await stat(full).catch(() => null);
            isDir = t !== null && t.isDirectory();
            isFile = t !== null && t.isFile();
          }
          let size;
          if (isFile) {
            const t = await stat(full).catch(() => null);
            if (t !== null) size = t.size;
          }
          return {
            name: d.name,
            type: isDir ? 'directory' : isFile ? 'file' : 'other',
            ...(size === undefined ? {} : { size }),
          };
        })
      );
      entries.sort((a, b) => {
        const da = a.type === 'directory' ? 0 : 1;
        const db = b.type === 'directory' ? 0 : 1;
        return da !== db ? da - db : a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });

      reply({ ok: true, value: { path: target.dir, entries, truncated } });
    };

    // ---------- POST /api/transfer.archive ----------
    //
    // 把一个目录流式打成 tar.gz 返回（application/gzip）。
    //
    // 为什么不用 zip：流式写 zip 需要数据描述符（CRC 要写在数据之后），而解析器是
    // 靠扫描本地头签名（PK\x03\x04）定位下一个条目的 —— 二进制内容里出现这四个字节
    // 就会误判。tar 的头里直接写着每个文件的大小，读多少算多少，没有这个歧义。
    // 再套一层 gzip 是为了拿到尾部 CRC32：传输被截断时客户端能立刻发现。
    const handleArchive = async (req, res) => {
      if (!gate(req, res)) return;
      const envelope = await readEnvelope(req);
      const payload = envelope?.payload ?? {};

      const target = checkAllowed(payload.path);
      if (target.error) {
        json(res, 400, { error: { code: 'transfer/bad-path', message: target.error } });
        return;
      }
      const info = await stat(target.dir).catch(() => null);
      if (info === null) {
        json(res, 404, {
          error: { code: 'transfer/not-found', message: `directory does not exist: ${target.dir}` },
        });
        return;
      }
      if (!info.isDirectory()) {
        json(res, 400, {
          error: { code: 'transfer/not-a-directory', message: `not a directory: ${target.dir}` },
        });
        return;
      }

      // 先走一遍拿清单：摘要要放进响应头，客户端也靠它画进度条。
      // wrap=false 时条目直接铺在归档根下，默认则套一层目录名（解包到手机时不会散开）。
      const wrapName = payload.wrap === false ? '' : basename(target.dir);
      const tree = await walkTree(target.dir, wrapName);
      if (tree.totalBytes > MAX_BYTES) {
        json(res, 413, {
          error: {
            code: 'transfer/too-large',
            message: `archive would be ${tree.totalBytes} bytes, over the ${MAX_BYTES} limit` ,
          },
        });
        return;
      }

      const label = (wrapName || basename(target.dir) || 'archive').replace(/[^\w.-]+/g, '_');
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${label}.tar.gz"`,
        'cache-control': 'no-store',
        'x-archive-files': String(tree.entries.filter((e) => e.typeflag === '0').length),
        'x-archive-dirs': String(tree.entries.filter((e) => e.typeflag === '5').length),
        'x-archive-bytes': String(tree.totalBytes),
        'x-archive-skipped': String(tree.skipped),
        'x-archive-truncated': tree.truncated ? '1' : '0',
      });

      try {
        await pipeline(
          Readable.from(tarStream(tree.entries)),
          // 手机上 CPU 比带宽金贵，压缩级别 1 足够，而且大部分内容本来就压过了。
          createGzip({ level: 1 }),
          res
        );
      } catch {
        // 响应头已经发出去了，改不成错误响应；直接断流。
        // 客户端会因为 gzip 尾部缺 CRC32 判定截断 —— 这正是套 gzip 的收益。
        res.destroy();
      }
    };
    // ---------- POST /api/transfer.describe ----------
    //
    // 标准一元信封，供客户端探测「这个后端有没有装文件传输插件」。
    const handleDescribe = async (req, res) => {
      if (!gate(req, res)) return;
      const envelope = await readEnvelope(req);
      const rpcId = envelope?.rpcId ?? '';
      json(res, 200, {
        type: 'server-response',
        rpcId,
        result: {
          ok: true,
          value: {
            plugin: PLUGIN_ID,
            version: VERSION,
            roots: ROOTS,
            maxBytes: MAX_BYTES,
            maxEntries: MAX_ENTRIES,
            capabilities: ['write', 'list', 'archive', 'mkdir'],
            // 列举的入口候选，已经过"真的能列出来"筛选，顺序即推荐顺序。
            // 客户端应当渲染成一个可选项列表：Windows 上是 C:/D: 盘，Android 上是
            // 内部存储/主目录，Linux 上是 /mnt/*、macOS 上是 /Volumes/*。
            places: discoverPlaces(),
            // 兼容字段：places[0] 就是推荐入口。
            defaultRoot: discoverPlaces()[0]?.path ?? null,
            tokenRequired: Boolean(TOKEN),
          },
        },
      });
    };

    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/api/transfer.write',
          handler: handleWrite,
        }),
      `${PLUGIN_ID}: /api/transfer.write route`
    );
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/api/transfer.mkdir',
          handler: handleMkdir,
        }),
      `${PLUGIN_ID}: /api/transfer.mkdir route`
    );
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/api/transfer.describe',
          handler: handleDescribe,
        }),
      `${PLUGIN_ID}: /api/transfer.describe route`
    );
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/api/transfer.list',
          handler: handleList,
        }),
      `${PLUGIN_ID}: /api/transfer.list route`
    );
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: '/api/transfer.archive',
          handler: handleArchive,
        }),
      `${PLUGIN_ID}: /api/transfer.archive route`
    );

    ctx.logger?.info?.(
      '[dsh-file-transfer] mounted write + describe + list + archive (roots=%s, token=%s)',
      ROOTS.length > 0 ? ROOTS.join(',') : '*',
      TOKEN ? 'on' : 'off'
    );
  },
};
