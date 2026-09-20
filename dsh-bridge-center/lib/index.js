// dsh-bridge-center — the plugin-center MASTER (management bridge) for dsh web.
//
// This plugin turns any dsh web backend into a remotely manageable plugin
// center. It is the always-on, protected "management bridge": it owns the
// plugin inventory & lifecycle (plugins.*) and capability/sub-plugin probing
// (center.describe / center.catalog) — all over the standard dsh unary envelope
// (POST /api/<method>, client-request / server-response with rpcId echo), so
// any dsh client — including the AiChatbox Android app — works with zero
// client-protocol changes.
//
// MCP server management is NOT part of the master: it is a sub-plugin
// (dsh-mcp-admin) that the master can enable, disable and remove like any
// normal plugin. center.catalog reports which official sub-plugins are
// present so clients can offer "quick install".
//
// Mechanics:
//   * plugins.setEnabled / plugins.remove operate on patch-layer rows
//     (cordis.patch.yml) at text level and drive the live loader — hot, no
//     restart for already-loaded packages.
//   * Optional bearer-style token (config.token or DSH_PLUGIN_CENTER_TOKEN
//     env): when set, every request must carry x-dsh-bridge-center-token.
//     When unset, only loopback/same-origin callers pass (CSRF gate).
//
// Build note: plain ESM JS, ZERO runtime dependencies (pure text patch ops —
// no YAML needed). Protected: the master refuses to disable/remove itself or
// official @deepseek-ai/* system core.

import {
  closeSync,
  existsSync,
  lstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL, URL } from 'node:url';

const PLUGIN_ID = 'dsh-bridge-center';

/**
 * dsh 的用户目录。重启助手与它的日志都落在这里 —— 这个操作一旦失手就是
 * 「后端没了」，事后必须留下可查的证据。
 * 认 DSH_HOME 环境变量，与 dsh 自身的约定保持一致。
 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const MAX_BODY = 1024 * 1024; // 1 MiB — the API has no legitimate large payloads.

/**
 * 安装端点的请求上限，单独放宽。
 *
 * 其余方法保持 1 MiB 不变 —— 安装是唯一有合理大 payload 的操作。实测最大的包
 * （dsh-mcp-admin，32 个文件 249 KB）base64 加 JSON 包装后约 334 KB，离这里还很远；
 * 放宽是为了以后加了稍大的依赖不至于撞墙。
 *
 * 安全性：readBody 是**流式计数**，超限即停止累积（超限后每次 data 都在 push 之前
 * return），所以放宽上限不会带来无界缓冲。
 */
const INSTALL_MAX_BODY = 8 * 1024 * 1024; // 8 MiB

/**
 * `center.restart` 的**兜底**退出延迟。
 *
 * 正常路径不是靠等：重启意图登记在 `pendingRestart` 里，HTTP handler 写完响应后
 * 挂到 `res` 的 finish/close 事件上，**响应真 flush 出去才退出**。
 * 这个常量只在 finish/close 都没来（socket 卡死、客户端异常）时兜底 ——
 * 「请求了重启却永远不重启」同样不可接受。
 *
 * 实测教训：最初写死 300ms，响应耗时 307ms，客户端拿到的是空 body
 * （`{"raw":""}`）—— App 会显示「重启失败」，但其实重启成功了。
 */
const RESTART_FALLBACK_MS = 5000;


/** 官方子插件目录（挂在插件中心之上的可管理插件）。 */
const SUBPLUGIN_CATALOG = [
  {
    package: 'dsh-mcp-admin',
    role: 'mcp',
    title: 'MCP 管理',
    description: 'MCP 服务器管理:增删改查、启停、重启',
  },
  {
    package: 'dsh-file-transfer',
    role: 'transfer',
    title: '文件传输',
    description: '文件传输:把手机上的文件写入后端文件系统',
  },
  {
    package: 'dsh-ssh-link',
    role: 'ssh',
    title: 'SSH 桥',
    description: 'SSH 桥:把远端机器当本机用 —— 跑命令、把远端 dsh 注册成 subagent 后端',
  },
];

/** 允许远程安装的包名白名单（复用子插件目录，避免第二份清单漂移）。 */
const CATALOG_PACKAGES = new Set(SUBPLUGIN_CATALOG.map((item) => item.package));

// ---------------------------------------------------------------------------
// Profile patch-layer filesystem access.
// ---------------------------------------------------------------------------

function profileDirFor(profileName) {
  return join(DSH_HOME, 'profiles', profileName);
}

function patchFilePath(profileName) {
  return join(profileDirFor(profileName), 'cordis.patch.yml');
}

/**
 * Read the patch layer.
 *
 * Only a genuinely missing file counts as "empty". Every other failure (EACCES,
 * EISDIR, EMFILE, ELOOP, ...) is rethrown: silently treating an unreadable file
 * as empty would let the next write replace the user's real patch layer with a
 * file containing only our new row — a permission problem turning into silent
 * data loss.
 */
function readPatchText(profileName) {
  try {
    return readFileSync(patchFilePath(profileName), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Atomically replace the patch layer.
 *
 * `writeFileSync(target)` on an existing file is O_TRUNC + incremental writes, so
 * a crash / OOM-kill / ENOSPC mid-write leaves a half-written file. That file is a
 * *required* input for the profile boot, so the damage is permanent: every later
 * `dsh web` start fails to parse the tree. Write to a temp file in the same
 * directory, flush it with fsync, then rename over the target — rename(2) is
 * atomic within a filesystem, so concurrent readers see either the old or the new
 * content and never a truncated blend.
 */
function writePatchText(profileName, text) {
  const target = patchFilePath(profileName);
  mkdirSync(profileDirFor(profileName), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  let fd;
  try {
    fd = openSync(tmp, 'w', 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(tmp); } catch { /* temp file never created */ }
    throw error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 剥离 patch 行 id 两侧的 YAML 引号('name' / "name" → name)。 */
function stripIdQuotes(value) {
  return typeof value === 'string' ? value.replace(/^(['"])(.*?)\1$/, '$2') : value;
}

/**
 * 去掉行尾注释（`[]   # comment` → `[]`），用于判断"空基准"标记行。
 * 用非捕获组而非 lookbehind，避免依赖较新的正则引擎特性。
 */
function stripTrailingComment(line) {
  return line.replace(/\s+#.*$/, '').trim();
}

// ---------------------------------------------------------------------------
// Generic plugin patch operations (text-level; never touches managed blocks).
// ---------------------------------------------------------------------------

/**
 * Locate a plugin entry in the patch layer.
 * Returns line ranges (start inclusive, end exclusive) for the top-level
 * `- insert:` block carrying `id`, and for a top-level `- id: <id>` disabled
 * marker. -1 means absent.
 */
function findPluginBlock(text, id) {
  const lines = text.split('\n');
  let insertStart = -1, insertEnd = -1;
  let disabledStart = -1, disabledEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s*insert:\s*$/.test(line)) {
      const ids = [];
      let j = i + 1;
      while (j < lines.length && /^\s{2}/.test(lines[j])) {
        const idm = /^\s+-\s*id:\s*([^\s]+)/.exec(lines[j]);
        if (idm) ids.push(stripIdQuotes(idm[1]));
        j++;
      }
      if (ids.includes(id)) {
        insertStart = i;
        insertEnd = j;
      }
      i = j - 1;
    } else if (/^-\s*id:\s*\S+/.test(line)) {
      const idm = /^-\s*id:\s*([^\s]+)/.exec(line);
      if (idm && stripIdQuotes(idm[1]) === id) {
        disabledStart = i;
        disabledEnd = i + 1;
        if (i + 1 < lines.length && /^\s{2}disabled:/.test(lines[i + 1])) disabledEnd = i + 2;
      }
    }
  }
  return { insertStart, insertEnd, disabledStart, disabledEnd };
}

/**
 * Enable/disable a plugin entry (patch OR bundle layer) by managing its
 * top-level `- id: <id> / disabled: true` marker in the patch file.
 * Patch rows keep their insert block; bundle entries get the official disable
 * marker appended (cordis applies `disabled` overrides by insert id), so a
 * toggle survives restarts for both install styles.
 */
/**
 * 判断 patch 文本是否只有注释、空行，以及空序列标记（`[]` / `---`）——
 * 即"还没有任何真实条目"。
 *
 * 这个判断必须先去注释再比对，不能只按行首 `#` 过滤后 `trim()`：真实 profile 的
 * cordis.patch.yml 基准正是"注释 + 一行 `[]`"（见模板），那一行不是注释。
 */
function isEmptyBaseline(text) {
  const effective = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const dense = effective.replace(/\s+/g, '');
  return dense === '' || dense === '[]' || dense === '---';
}

/** 去掉空序列标记行（`[]` / `---`），保留注释与缩进不变。 */
function dropEmptyBaselineMarkers(lines) {
  return lines.filter((line) => !/^\s*(\[\s*\]|---)\s*$/.test(stripTrailingComment(line)));
}

function setPluginEnabled(text, id, enabled) {
  const found = findPluginBlock(text, id);
  let lines = text.split('\n');
  if (found.disabledStart !== -1) {
    lines.splice(found.disabledStart, found.disabledEnd - found.disabledStart);
  }
  if (!enabled) {
    // If the base holds no real entries yet (only comments plus an empty-flow
    // marker `[]` or `---`), drop the marker line first.
    //
    // The previous filter was `!/^\s*#/.test(l) || !l.trim().startsWith('[')`,
    // which keeps a line when it is not a comment — so the real scaffold line
    // `[]` (no leading `#`) survived, and appending `- id: ...` after it produced
    // two YAML documents' worth of scalars:
    //
    //     []
    //     - id: some-plugin
    //       disabled: true
    //
    // which does not parse ("end of the stream or a document separator is
    // expected"). A fresh or cleared profile would then fail to boot.
    if (isEmptyBaseline(lines.join('\n'))) lines = dropEmptyBaselineMarkers(lines);
    let out = lines.join('\n').replace(/\n+$/, '');
    out = `${out ? `${out}\n` : ''}- id: ${id}\n  disabled: true\n`;
    return out;
  }
  // 重新启用：移除 disabled 标记后若已无任何真实条目，归一为显式空序列 `[]`。
  // cordis 把 patch 层当序列加载，只留注释的文件会解析成 undefined。
  let out = lines.join('\n');
  if (isEmptyBaseline(out)) {
    const comments = lines.filter((line) => /^\s*#/.test(line));
    return comments.length ? `${comments.join('\n').replace(/\n+$/, '')}\n[]\n` : '[]\n';
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

/** Remove a patch-layer plugin entry (insert block + disabled marker). */
function removePluginEntry(text, id) {
  const found = findPluginBlock(text, id);
  if (found.insertStart === -1 && found.disabledStart === -1) return text;
  const lines = text.split('\n');
  if (found.disabledStart !== -1) {
    lines.splice(found.disabledStart, found.disabledEnd - found.disabledStart);
  }
  if (found.insertStart !== -1) {
    lines.splice(found.insertStart, found.insertEnd - found.insertStart);
  }
  const out = lines.join('\n');
  if (isEmptyBaseline(out)) {
    const comments = lines.filter((line) => /^\s*#/.test(line));
    return comments.length ? `${comments.join('\n').replace(/\n+$/, '')}\n[]\n` : '[]\n';
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

// ---------------------------------------------------------------------------
// Request guarding (CSRF / token).
// ---------------------------------------------------------------------------

function isLoopbackHost(value) {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(value ?? '');
}

function sameOrigin(req) {
  const origin = req.headers['origin'];
  if (!origin) return true; // non-browser client (Android app, curl, scripts)
  try {
    const u = new URL(origin);
    const hostHdr = req.headers['host'] || '';
    return isLoopbackHost(u.hostname) || u.host === hostHdr;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plugin.
// ---------------------------------------------------------------------------

/** Profile this host process actually booted (--profile <name>). */
function argvProfile() {
  const argv = process.argv;
  const flag = argv.indexOf('--profile');
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1];
  return undefined;
}

/** Plugin version from the sibling package.json (fallback 0.0.0). */
function readPluginVersion() {
  try {
    const url = new URL('../package.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// 远程安装:路径校验与 patch 行插入
// ---------------------------------------------------------------------------

/**
 * 把包内声明的相对路径解析成 rootDir 下的绝对路径；任何可疑写法一律返回 null。
 *
 * **这是整条安装链路里唯一一处写错就是安全漏洞的代码。** 它守的是「一个构造的包
 * 能把文件写到目标目录之外」这条攻击路径。
 *
 * 采用**双重校验**，两道都必须要：
 *   1. 逐段检查 —— 挡住 `..`、绝对路径、盘符这些显式写法
 *   2. 解析后终检 —— 算出真实绝对路径，断言仍在 rootDir 内
 * 只靠 (1) 会被各种编码/分隔符技巧绕过；只靠 (2) 则对 `..` 的中间形态过于宽容。
 * 两道理性上都成立，是因为这条路径只走一次、代价可以忽略。
 */
function safeTargetPath(rootDir, relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  // NUL 截断:底层 C 字符串处理会在此截断,`a\0/../../x` 这类写法的常用载体。
  if (relPath.includes('\0')) return null;
  // 反斜杠:Windows 的分隔符。POSIX 上它是合法文件名字符,放行就等于留一条
  // 「同一份包换个平台就变成穿越」的路 —— 而这条路的目标机可能是 Windows。
  if (relPath.includes('\\')) return null;
  // 绝对路径。
  if (relPath.startsWith('/')) return null;
  // 盘符(C:...)。
  if (/^[a-zA-Z]:/.test(relPath)) return null;
  const segments = relPath.split('/');
  for (const seg of segments) {
    // 空段(`a//b`)会让规范化结果与直觉不符;`.` 无意义;`..` 就是穿越本身。
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  // 终检:真正解析出来的绝对路径必须落在 rootDir 之内。
  const target = resolve(rootDir, ...segments);
  const prefix = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  if (!target.startsWith(prefix)) return null;
  return target;
}

/**
 * 往 patch 层插入一条插件挂载行（幂等：已有该 id 的 insert 块则原样返回）。
 *
 * 生成的形状与 App 的本机安装脚本一致：
 *
 *     - insert:
 *         - id: <pkg>
 *           name: <pkg>
 *
 * 缩进是 4 空格的 `- id:`（顶格 `- insert:` 下一层）—— findPluginBlock 正是按
 * 「顶格 `- insert:` + 后续缩进 2 格内的 `- id:`」来识别的，缩进错了它就找不到。
 */
function upsertPluginInsert(text, id) {
  if (findPluginBlock(text, id).insertStart !== -1) return text;
  // 基准为空(注释 + `[]`/`---`)时必须先摘掉那个空序列标记，否则会拼出两个 YAML
  // 文档：`[]` 后面跟 `- insert:` 解析不了，profile 直接起不来。
  let lines = text.split('\n');
  if (isEmptyBaseline(text)) lines = dropEmptyBaselineMarkers(lines);
  const out = lines.join('\n').replace(/\n+$/, '');
  return `${out ? `${out}\n` : ''}- insert:\n    - id: ${id}\n      name: ${id}\n`;
}

// 纯文本 patch 操作的命名导出:仅用于行为级回归测试(见 test/patch-ops.test.mjs)。
// 均为纯函数,不接触 loader/HTTP,导出不影响 default 插件的形状。
// safeTargetPath / upsertPluginInsert 同理 —— 前者是安全关键代码,必须能单独测。
export { findPluginBlock, removePluginEntry, setPluginEnabled, safeTargetPath, upsertPluginInsert };

/**
 * 落盘后校验：这个包真的能 import，且导出形状像个插件。
 *
 * 为什么必须做：校验不过的包若被写进 cordis.patch.yml，下次 dsh web 启动时 loader
 * 会加载失败 —— 一个坏包能把整个后端搞到起不来。所以宁可装不上，也不能装上。
 *
 * 用带时间戳的查询串强制绕开 ESM 的 **URL 缓存**：不带的话，覆盖安装会 import 到
 * 内存里的旧模块，「校验通过」实际是在校验旧代码 —— 那比不校验更糟，因为它给了
 * 一个虚假的通过。
 */
async function verifyPluginDir(dir, expectedName) {
  const entry = pathToFileURL(join(dir, "lib", "index.js")).href;
  let mod;
  try {
    mod = await import(`${entry}?verify=${Date.now().toString(36)}`);
  } catch (error) {
    const wrapped = new Error(`import failed: ${error instanceof Error ? error.message : String(error)}`);
    wrapped.code = "VERIFY_FAILED";
    throw wrapped;
  }
  const plugin = mod?.default;
  // 与 App 本机安装脚本的校验条件保持一致（TermuxCommands.kt 里那段 import 校验）。
  if (!plugin || plugin.name !== expectedName || typeof plugin.apply !== "function") {
    const wrapped = new Error(
      `default export is not a plugin (name=${JSON.stringify(plugin?.name)}, apply=${typeof plugin?.apply})`
    );
    wrapped.code = "VERIFY_FAILED";
    throw wrapped;
  }
}

export default {
  name: PLUGIN_ID,
  // connection 是认证的唯一来源 —— 缺了它本插件的路由就是裸奔的，见 gate() 的长注释。
  // 声明成硬依赖（而不是 ctx.get 后判空）是为了**失败即不可用**：宁可插件不挂载，
  // 也不能在没有认证层的情况下把 /api 端点暴露出去。
  inject: ['webServer', 'loader', 'skills', 'connection'],

  apply(ctx, config = {}) {
    const webServer = ctx.webServer;
    const loader = ctx.loader;
    const connection = ctx.connection;

    const TOKEN = String(config.token || process.env.DSH_PLUGIN_CENTER_TOKEN || process.env.DSH_MCP_ADMIN_TOKEN || '').trim();
    // 显式 config.profile 优先;否则用启动 --profile;最后回退 web。
    const PROFILE = String(config.profile || argvProfile() || 'web').trim();

    // 远程安装开关。**默认关闭** —— 「装上主插件」与「允许远程往这台机器装代码」
    // 是两个独立决定，不该由前者自动带出后者。
    const ALLOW_REMOTE_INSTALL =
      config.allowRemoteInstall === true || process.env.DSH_PLUGIN_CENTER_ALLOW_INSTALL === '1';

    const json = (res, status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    };

    const ok = (rpcId, value) => ({
      type: 'server-response',
      rpcId,
      result: { ok: true, value },
    });
    const err = (rpcId, code, message) => ({
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code, message } },
    });

    /** Decode the client-request envelope; null on malformed. */
    const decodeEnvelope = (bodyText) => {
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        return null;
      }
      if (!body || body.type !== 'client-request') return null;
      const { rpcId, method, payload } = body;
      if (typeof rpcId !== 'string' || !rpcId) return null;
      if (typeof method !== 'string' || !method) return null;
      return { rpcId, method, payload: payload ?? {} };
    };

    /**
     * 读请求体。limit 默认 1 MiB；只有安装端点会传更大的值。
     *
     * 注意这里是**流式计数**：超限后每次 data 都在 push 之前 return，所以即便放宽
     * limit 也不会无界缓冲 —— 这正是放宽安装上限的前提。
     *
     * 另注：size 数的是**字符数**（String(c).length），不是字节数。安装 payload 用
     * base64 是纯 ASCII，两者相等；若改成直接发原始字节，多字节 UTF-8 既会让这个
     * 计数偏小，也会被逐块 String() 解码切坏。
     */
    const readBody = (req, limit = MAX_BODY) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
          const s = String(c);
          size += s.length;
          if (size > limit) {
            reject(new Error('request body too large'));
            return;
          }
          chunks.push(s);
        });
        req.on('end', () => resolve(chunks.join('')));
        req.on('error', reject);
      });

    /**
     * 待执行的重启动作（null = 没有）。
     *
     * 为什么不在 op 里直接 `process.exit`：那样会在响应写完之前就把进程带走，
     * 客户端收到空 body、误判成失败（实测 307ms vs 300ms 的竞态）。
     * 由 handler 在响应 flush 之后统一收尾，见 drainRestart。
     */
    let pendingRestart = null;

    /**
     * 响应写完后执行登记的重启。
     *
     * 优先等 finish（成功写完）或 close（连接断了也算写过），两个都挂但只生效一次；
     * 都没等到就靠 RESTART_FALLBACK_MS 兜底 —— 卡住的 socket 不该阻止重启。
     */
    const drainRestart = (res) => {
      const action = pendingRestart;
      if (!action) return;
      pendingRestart = null;
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        action();
      };
      const timer = setTimeout(run, RESTART_FALLBACK_MS);
      timer.unref?.();
      const onDone = () => {
        clearTimeout(timer);
        run();
      };
      res.once('finish', onDone);
      res.once('close', onDone);
    };

    const gate = (req, res) => {
      if (String(req.method || 'POST').toUpperCase() !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' });
        return false;
      }

      // ---------- 认证：必须显式做，且必须用官方那一套 ----------
      //
      // 下面挂路由的地方（"HTTP mount" 段）用 kind:'exact' 注册 /api/<method>。
      // dsh 的认证不在路由框架里，而是挂在 client-connection 注册的 kind:'prefix'
      // /api 路由的 handler 第一行（`connection.requestRejection(req)`）。
      // **exact 先于 prefix 匹配**，那条 prefix 路由根本轮不到执行 —— 本插件
      // 之前那行注释把这件事写成了「win without touching the connection layer」，
      // 机制说对了，没意识到「不碰 connection 层」= 连认证一起跳过。
      //
      // 实测后果（修复前）：不带任何 cookie 直接 POST /api/center.supervisor
      // 就能**明文拿到 supervisor token**，进而控制 dsh web 的启停；
      // /api/plugins.install 等同理（装包会跑 pnpm 生命周期脚本）。全程无需凭据。
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
          error: rejection === 401 ? 'authentication required' : 'forbidden',
        });
        return false;
      }

      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: 'untrusted origin' });
        return false;
      }
      if (TOKEN) {
        const got = String(req.headers['x-dsh-bridge-center-token'] || req.headers['x-dsh-mcp-token'] || '').trim();
        if (got !== TOKEN) {
          json(res, 403, { ok: false, error: 'invalid token' });
          return false;
        }
      }
      return true;
    };

    // ---------- plugins.* — 插件中心清单与生命周期 ----------

    /** Cordis Fiber 状态编号 → 可读阶段名（同官方 dsh-host-plugin-inventory）。 */
    const FIBER_PHASE = {
      0: 'pending',
      1: 'loading',
      2: 'active',
      3: 'failed',
      4: null,
      5: 'unloading',
    };

    // 插件保护规则:管理桥本身(本插件)与官方系统核心不可停用/卸载(否则 dsh web 自毁)。
    // 官方子插件(dsh-mcp-admin)不在保护名单内 —— 它应当能被插件中心正常安装/启停/卸载。
    const SYSTEM_PLUGIN_PREFIX = '@deepseek-ai/';
    const BRIDGE_IDS = new Set([PLUGIN_ID]);
    const isBridgePlugin = (entry) =>
      BRIDGE_IDS.has(entry.id) || (entry.options && BRIDGE_IDS.has(entry.options.name));

    /**
     * 插件的**名称标签**，取自插件包 package.json 的 `dsh.title`（如「文件传输」「MCP 管理」）。
     *
     * 为什么不用 npm 的 `description`：那是给人读的一句话说明，不是名字。
     * 名称标签要的是「一眼认出这是什么插件」，两件事，不该共用一个字段。
     *
     * 从 profile 的 node_modules 读，而不是在插件里再维护一份表 —— 两份必然漂移，
     * 而且改个名字得改两个仓库。只对非系统插件读：系统核心有一百多个，挨个读文件
     * 纯属浪费，App 也不显示它们。读不到回 null，App 退回显示包名即可。
     * 结果按包名缓存 —— 名称在进程生命周期内不会变。
     */
    const pluginTitleCache = new Map();
    const readPluginTitle = (name) => {
      if (!name || name.startsWith(SYSTEM_PLUGIN_PREFIX)) return null;
      if (pluginTitleCache.has(name)) return pluginTitleCache.get(name);
      let out = null;
      try {
        const pkgPath = join(profileDirFor(PROFILE), 'node_modules', name, 'package.json');
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const title = parsed.dsh && typeof parsed.dsh.title === 'string'
          ? parsed.dsh.title.trim()
          : '';
        out = title || null;
      } catch {
        out = null;
      }
      pluginTitleCache.set(name, out);
      return out;
    };

    const opPluginList = async () => {
      const entries = [];
      for (const entry of loader.entries()) {
        if (entry.options && entry.options.group) continue;
        const name = (entry.options && entry.options.name) || entry.id;
        // loader 内置容器（cordis:include 之类）不是插件：它是 loader.builtins 里的
        // 挂载点，没有包名、没有名称标签、也不能启停/卸载。留着它 App 的用户插件
        // 列表里就会多一行「cordis:include」，用户完全看不懂。
        // 官方 plugin-package-inventory 也用同一个前缀判定「不是可解析的包」。
        if (name.startsWith('cordis:')) continue;
        const bridge = isBridgePlugin(entry);
        entries.push({
          id: entry.id,
          name,
          enabled: !entry.disabled,
          fiberPhase: entry.fiber === void 0 ? null : FIBER_PHASE[entry.fiber.state],
          // 系统核心(官方 @deepseek-ai/*)与管理桥受保护,App 端据此禁用操作。
          system: name.startsWith(SYSTEM_PLUGIN_PREFIX) && !bridge,
          protected: bridge || name.startsWith(SYSTEM_PLUGIN_PREFIX),
          // 名称标签,取自插件包的 dsh.title。App 拿它当列表主标题 ——
          // 包名(dsh-file-transfer)对用户没有意义,「文件传输」才有。
          title: readPluginTitle(name),
        });
      }
      return { ok: true, value: { plugins: entries } };
    };

    /** 从 loader 找 entry(接受 loader id、去 include: 前缀后的 id 或插件名);不存在返回 null。 */
    const findLoaderEntry = (id) => {
      const plain = String(id).replace(/^include:/, '');
      for (const entry of loader.entries()) {
        const entryPlain = String(entry.id).replace(/^include:/, '');
        const name = (entry.options && entry.options.name) || '';
        if (entry.id === id || entryPlain === plain || name === plain || name === id) return entry;
      }
      return null;
    };

    /** patch 行使用的条目 id(loader id 去掉 include: 前缀)。 */
    const patchIdOf = (id) => String(id).replace(/^include:/, '');

    const opPluginSetEnabled = async (payload) => {
      const id = String(payload.id || '');
      if (!id) return { ok: false, error: { code: 'invalid-request', message: 'missing id' } };
      if (typeof payload.enabled !== 'boolean') {
        return { ok: false, error: { code: 'invalid-request', message: 'enabled must be a boolean' } };
      }
      const entry = findLoaderEntry(id);
      if (!entry) return { ok: false, error: { code: 'not-found', message: `not loaded: ${id}` } };
      if (isBridgePlugin(entry)) {
        return { ok: false, error: { code: 'protected', message: 'dsh-bridge-center is the management bridge' } };
      }
      if ((entry.options && entry.options.name || '').startsWith(SYSTEM_PLUGIN_PREFIX)) {
        return { ok: false, error: { code: 'protected', message: 'system plugin cannot be toggled' } };
      }
      const disabled = !payload.enabled;
      try {
        await loader.update(entry.id, { disabled });
      } catch (error) {
        return {
          ok: false,
          error: { code: 'update-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      try {
        const text = readPatchText(PROFILE);
        writePatchText(PROFILE, setPluginEnabled(text, patchIdOf(id), payload.enabled));
      } catch (error) {
        return {
          ok: false,
          error: { code: 'persist-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      return { ok: true, value: { id, enabled: payload.enabled } };
    };

    const opPluginRemove = async (payload) => {
      const id = String(payload.id || '');
      if (!id) return { ok: false, error: { code: 'invalid-request', message: 'missing id' } };
      const entry = findLoaderEntry(id);
      if (!entry) return { ok: false, error: { code: 'not-found', message: `not loaded: ${id}` } };
      if (isBridgePlugin(entry)) {
        return { ok: false, error: { code: 'protected', message: 'dsh-bridge-center is the management bridge' } };
      }
      if ((entry.options && entry.options.name || '').startsWith(SYSTEM_PLUGIN_PREFIX)) {
        return { ok: false, error: { code: 'protected', message: 'system plugin cannot be removed' } };
      }
      // 区分安装层:bundle 层(来自 dsh plugin add / dsh.profile.bundles)的插件行
      // 不在 patch 文件里,运行时无法真正卸载(重启会被 bundle 重新挂载);
      // patch 层(热装:文件 + cordis.patch.yml 挂载行)则可运行时移除。
      const plainId = patchIdOf(id);
      const text = readPatchText(PROFILE);
      if (findPluginBlock(text, plainId).insertStart === -1) {
        return {
          ok: false,
          error: {
            code: 'bundle-managed',
            message: `${plainId} is bundle-installed (dsh plugin add): remove it with 'dsh plugin remove ${plainId}' (needs a dsh web restart). Runtime removal applies to patch/hot-installed plugins.`,
          },
        };
      }
      try {
        await loader.remove(entry.id);
      } catch (error) {
        return {
          ok: false,
          error: { code: 'deactivation-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      try {
        writePatchText(PROFILE, removePluginEntry(text, plainId));
      } catch (error) {
        return {
          ok: false,
          error: { code: 'persist-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      return { ok: true, value: { id } };
    };

    // ---------- plugins.install — 接收手机推来的子插件包 ----------

    /**
     * 安装一个由客户端推来的子插件包。
     *
     * 包格式是**一个 JSON 文件列表**，不是 tgz —— 见 plugins/方案-子插件远程安装.md。
     * 要点是插件侧完全不需要解析 tar：没有 tar 头就没有 tar 头解析，
     * 也就没有「用构造的 header 逃出目标目录」这一整类问题。
     *
     * 落盘策略：先在 .staging-* 里写全、校验通过，再 rename 就位。
     * 直接往目标目录写的话，中途失败会留下**半个包** —— 而半个包会被 loader 当成
     * 坏插件加载，把一个失败请求变成「后端起不来」。
     *
     * 这个操作等于在目标机上开放远程代码执行，比 setEnabled/remove 危险一个量级：
     * 那两个受 protected 规则约束，而「装一个新包」天然绕开所有既有约束。
     * 所以默认关闭、包名白名单、路径双重校验、落盘后强制校验，一道都不省。
     */
    const opPluginInstall = async (payload, req) => {
      if (!ALLOW_REMOTE_INSTALL) {
        return {
          ok: false,
          error: {
            code: 'install-disabled',
            message:
              'remote install is disabled. Enable it with config.allowRemoteInstall = true ' +
              'or env DSH_PLUGIN_CENTER_ALLOW_INSTALL=1, then restart dsh web.',
          },
        };
      }

      // 白名单：挡掉「用这条路由装任意包」。顺带也挡掉了主插件自己 ——
      // SUBPLUGIN_CATALOG 里不含 dsh-bridge-center，不允许远程替换管理桥。
      const name = String(payload?.name ?? '').trim();
      if (!CATALOG_PACKAGES.has(name)) {
        return {
          ok: false,
          error: { code: 'not-in-catalog', message: `not a known sub-plugin: ${name || '(empty)'}` },
        };
      }
      const requestedVersion = String(payload?.version ?? '').trim();
      const files = Array.isArray(payload?.files) ? payload.files : null;
      if (!files || files.length === 0) {
        return { ok: false, error: { code: 'bad-payload', message: 'files must be a non-empty array' } };
      }

      const nodeModules = join(profileDirFor(PROFILE), 'node_modules');
      const targetDir = join(nodeModules, name);
      // 这个包**是否已经被 loader 加载**，决定装完要不要重启：
      //   · 新装（还没加载）→ patch 文件被监听，约 2 秒热加载，**不用重启**
      //   · 覆盖已加载的 → HMR 不会重新导入源码，旧模块留在 Node 模块缓存里，**要重启**
      // 两者都是实测结论（见本包 README「免重启热装」与紧随其后的警告）。
      const alreadyLoaded = findLoaderEntry(name) !== null;

      // ── 全部先解码并校验完，再动任何文件系统 ──
      const decoded = [];
      const seen = new Set();
      let totalBytes = 0;
      for (const item of files) {
        const rel = item?.path;
        const b64 = item?.data;
        if (typeof rel !== 'string' || typeof b64 !== 'string') {
          return {
            ok: false,
            error: { code: 'bad-payload', message: 'each file needs a string path and a string data' },
          };
        }
        if (seen.has(rel)) {
          return { ok: false, error: { code: 'bad-payload', message: `duplicate path: ${rel}` } };
        }
        seen.add(rel);
        // 路径校验（安全关键）。落盘时会对 staging 目录再算一次绝对路径。
        if (safeTargetPath(targetDir, rel) === null) {
          return {
            ok: false,
            error: { code: 'invalid-path', message: `unsafe path rejected: ${JSON.stringify(rel)}` },
          };
        }
        // 严格 base64 校验。Buffer.from(x, 'base64') **会静默丢弃非法字符**，
        // 不自己验的话，一个残缺/被篡改的 payload 会被解成一段看似正常的字节。
        if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
          return { ok: false, error: { code: 'bad-payload', message: `not valid base64: ${rel}` } };
        }
        const buf = Buffer.from(b64, 'base64');
        totalBytes += buf.length;
        decoded.push({ rel, buf });
      }

      // ── 包内容自洽 ──
      const manifest = decoded.find((f) => f.rel === 'package.json');
      if (!manifest) {
        return { ok: false, error: { code: 'incomplete-package', message: 'package.json is missing' } };
      }
      if (!decoded.some((f) => f.rel === 'lib/index.js')) {
        return { ok: false, error: { code: 'incomplete-package', message: 'lib/index.js is missing' } };
      }
      let meta;
      try {
        meta = JSON.parse(manifest.buf.toString('utf8'));
      } catch {
        return { ok: false, error: { code: 'bad-payload', message: 'package.json is not valid JSON' } };
      }
      // 名字/版本必须与请求一致 —— 挡掉「名字对、内容是别的东西」。
      if (meta?.name !== name) {
        return {
          ok: false,
          error: {
            code: 'name-mismatch',
            message: `package.json declares name=${JSON.stringify(meta?.name)}, request says ${name}`,
          },
        };
      }
      if (requestedVersion && meta?.version !== requestedVersion) {
        return {
          ok: false,
          error: {
            code: 'name-mismatch',
            message: `package.json declares version=${JSON.stringify(meta?.version)}, request says ${requestedVersion}`,
          },
        };
      }

      // ── 原子落盘 ──
      mkdirSync(nodeModules, { recursive: true });
      const stamp = `${process.pid}-${Date.now().toString(36)}`;
      const stagingDir = join(nodeModules, `.staging-${name}-${stamp}`);
      const backupDir = join(nodeModules, `.backup-${name}-${stamp}`);
      let displaced = false;
      try {
        for (const f of decoded) {
          const abs = safeTargetPath(stagingDir, f.rel);
          if (abs === null) throw new Error(`unsafe path: ${f.rel}`); // 前面已验，这里只是防御
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, f.buf);
        }
        await verifyPluginDir(stagingDir, name);
        // 就位。已有旧版本先挪到一边，失败时还原 —— 覆盖安装失败不能把能用的旧版弄没。
        if (existsSync(targetDir)) {
          renameSync(targetDir, backupDir);
          displaced = true;
        }
        renameSync(stagingDir, targetDir);
      } catch (error) {
        rmSync(stagingDir, { recursive: true, force: true });
        if (displaced) {
          try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* 可能没建成 */ }
          try { renameSync(backupDir, targetDir); } catch { /* 尽力还原 */ }
        }
        const code = error?.code === 'VERIFY_FAILED' ? 'verify-failed' : 'write-failed';
        return {
          ok: false,
          error: { code, message: error instanceof Error ? error.message : String(error) },
        };
      }
      rmSync(backupDir, { recursive: true, force: true });

      // ── 挂进 patch 层 ──
      // 写进 patch 之后：**新装**的包会被监听 patch 文件的 dsh web 在约 2 秒内热加载
      // （实测），所以不用重启；**覆盖已加载**的包则不会 —— HMR 不重新导入源码，
      // 旧模块仍在 Node 的模块缓存里，必须重启才生效。
      // restartRequired 就是按这个区别回报的（见上面 alreadyLoaded 的计算）。
      let enabled = false;
      let patchError = null;
      if (payload?.enable !== false) {
        try {
          writePatchText(PROFILE, upsertPluginInsert(readPatchText(PROFILE), name));
          enabled = true;
        } catch (error) {
          patchError = error instanceof Error ? error.message : String(error);
        }
      }

      // 审计日志：这类操作事后要能查。
      ctx.logger?.info?.(
        '[dsh-bridge-center] install from %s: %s@%s %d files %d B -> %s',
        String(req?.socket?.remoteAddress || '?'),
        name,
        meta?.version ?? requestedVersion ?? '?',
        decoded.length,
        totalBytes,
        patchError
          ? `patched FAILED: ${patchError}`
          : enabled
            ? alreadyLoaded
              ? 'patched (already loaded -> restart needed)'
              : 'patched (hot-loads)'
            : 'written only'
      );

      return {
        ok: true,
        value: {
          id: name,
          version: meta?.version ?? requestedVersion ?? null,
          files: decoded.length,
          bytes: totalBytes,
          enabled,
          patchError,
          restartRequired: alreadyLoaded,
        },
      };
    };

    // ---------- center.* — 插件中心总操作 ----------

    const opCenterDescribe = async () => ({
      ok: true,
      value: {
        id: PLUGIN_ID,
        name: 'dsh-bridge-center',
        version: readPluginVersion(),
        kind: 'master',
        profile: PROFILE,
        tokenAuth: TOKEN.length > 0,
        capabilities: [
          'plugins.list', 'plugins.setEnabled', 'plugins.remove',
          'plugins.install', 'center.describe', 'center.catalog',
          'skills.managed', 'skills.read', 'skills.save', 'skills.setEnabled', 'skills.remove',
          'center.restart',
        'center.supervisor',
        ],
        // 客户端据此决定给不给「推送到此安装」入口。能力在列表里不等于能用 ——
        // 开关关着时调用会拿到 install-disabled，所以这里单独回报开关状态。
        remoteInstall: ALLOW_REMOTE_INSTALL,
      },
    });

    /** 官方子插件目录：report installed/enabled state from the live loader. */
    const opCenterCatalog = async () => {
      const entries = [...loader.entries()];
      const subplugins = SUBPLUGIN_CATALOG.map((item) => {
        const hit = entries.find(
          (e) =>
            (e.options && e.options.name === item.package) ||
            e.id === item.package ||
            e.id === `include:${item.package}`
        );
        return {
          package: item.package,
          role: item.role,
          title: item.title,
          description: item.description,
          installed: hit !== void 0,
          enabled: hit ? !hit.disabled : false,
          fiberPhase: hit && hit.fiber !== void 0 ? FIBER_PHASE[hit.fiber.state] : null,
        };
      });
      return { ok: true, value: { subplugins } };
    };

    // ---------- center.restart — 进程级重启 ----------

    /**
     * 判断当前进程是否被守护进程托管。
     *
     * 先看环境变量：各家守护进程都会在自己的子进程里留下痕迹，比解析进程树可靠
     * 得多，也跨平台。都查不到再退回 POSIX 的「被 init 收养」（ppid===1）。
     *
     * Windows 上 ppid 没有 1 这个语义（父进程是 cmd.exe / explorer.exe），那里
     * 只能靠环境变量判断 —— 结论通常是「没有守护进程」，正是我们要的。
     */
    const detectSupervisor = () => {
      const env = process.env || {};
      if (env.pm_id !== void 0 || env.PM2_HOME) return 'pm2';
      if (env.INVOCATION_ID || env.JOURNAL_STREAM) return 'systemd';
      if (env.NSSM_EXE || env.NSSM_CONFIGURATION || env.NSSM_SERVICE_NAME) return 'nssm';
      if (env.SUPERVISOR_ENABLED || env.SUPERVISOR_PROCESS_NAME) return 'supervisor';
      if (env.DSH_SUPERVISOR) return String(env.DSH_SUPERVISOR);

      // ppid===1 只在**真有 init 会重启服务**的平台上才成立。
      //
      // Termux 上这条是**错的**:Android 的 PID 1 是 `/system/bin/init`(second_stage),
      // 它根本不认识 `dsh web`,更不会把它拉回来。实测本机后端 ppid 就是 1。
      // 于是 center.restart 会走 supervisor-exit 分支 → process.exit(0) →
      // **后端永久消失**,而且用户拿到的提示是"约 10 秒后自动重连"。
      //
      // 判据用 `process.platform !== 'win32'` 挡不住这个:Android 报的是 `android`。
      // 所以显式排除,让 Termux 落到 self-reexec(那条会真的把新进程拉起来)。
      const isTermux = Boolean(env.TERMUX_VERSION) || env.PREFIX?.includes?.('com.termux') ||
        process.platform === 'android';
      if (isTermux) return env.DSH_SUPERVISOR ? String(env.DSH_SUPERVISOR) : null;

      if (process.platform !== 'win32' && process.ppid === 1) return 'init';
      return null;
    };

    /** 本次进程的完整启动命令行 —— 见 opCenterRestart 注释里为什么必须拼 execArgv。 */
    const launchArgv = () => [...process.execArgv, ...process.argv.slice(1)];

    /** 逐个试候选的 PowerShell；Windows 上 powershell.exe 必定存在，pwsh 是加分项。 */
    const resolvePowerShell = () => {
      const candidates = ['powershell.exe', 'pwsh.exe', 'powershell', 'pwsh'];
      for (const c of candidates) {
        try {
          const r = spawnSync(c, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 8000,
          });
          if (r && r.status === 0) return c;
        } catch { /* 试下一个 */ }
      }
      return null;
    };

    /**
     * 经 WMI 创建助手进程，返回它的 pid。
     *
     * **为什么不能直接 spawn**：dsh 用 Windows Job Object 管理子进程，并设了
     * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（见 @deepseek-ai/dsh-win32-process）。
     * 子进程**继承 Job 成员身份**，而 `spawn({detached:true})` 在 Windows 上只等于
     * `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`，**逃不出 Job** —— Job 关闭时
     * 一起被杀。实测：从工具子进程里拉起的重启助手确实走到了 spawn 那步，但新起的
     * dsh web 仍随 Job 一起死掉，后端整整 502 了 3 分半，只能人工重启。
     *
     * `Win32_Process.Create` 由 WMI 服务（WmiPrvSE.exe）代为创建，父级是 WmiPrvSE，
     * **天然在 Job 之外**。实测探针在被创建 40s 后仍存活（此时工具子进程早已结束、
     * Job 早已关闭），父进程正是 WmiPrvSE.exe。
     *
     * 用 `-EncodedCommand`（UTF-16LE + base64）传脚本，彻底绕开 Windows 命令行
     * 的引号地狱。**必须等到 pid 回来才算成功** —— 拿不到 pid 就不能退出，否则
     * dsh web 直接没了。
     */
    const launchViaWmi = (helperPath) =>
      new Promise((resolve, reject) => {
        const ps = resolvePowerShell();
        if (!ps) return reject(new Error('找不到 PowerShell，无法在 Windows 上逃出 Job Object'));
        const commandLine = `"${process.execPath}" "${helperPath}"`;
        const script =
          '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ' +
          "-Arguments @{ CommandLine = '" + commandLine.replace(/'/g, "''") + "' }; " +
          'Write-Output ("DSHPID=" + $r.ProcessId)';
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        let settled = false;
        const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill(); } catch { /* 已经退出 */ }
          reject(new Error('WMI 创建助手超时（15s）'));
        }, 15000);
        child.stdout?.on('data', (d) => { out += String(d); });
        child.stderr?.on('data', (d) => { out += String(d); });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const m = /DSHPID=(\d+)/.exec(out);
          const pid = m ? Number(m[1]) : 0;
          if (pid > 0) resolve(pid);
          else reject(new Error('WMI 创建助手失败：' + out.trim().slice(0, 200)));
        });
      });

    /**
     * 生成重启助手源码。
     *
     * 助手的职责：**等本进程真正退出、端口释放之后**，再用同一个命令行把 dsh web
     * 拉起来。先起新进程会和旧进程抢同一个端口，先杀旧的又可能在新进程绑定前留出
     * 空窗 —— 所以顺序必须是「父进程先死 → 再拉起」。
     *
     * 所有参数**内联进源码**（不靠 argv）：Windows 上经 WMI 传参要穿两层命令行
     * 解析，内联可以完全避开引号与转义问题。扩展名用 `.cjs` —— 它是 CommonJS
     * 的硬保证，不受所在目录 package.json 的 `type` 影响。
     *
     * 助手写日志到 ~/.dsh/restart.log：这个操作一旦出错就是「后端没了」，事后能
     * 留下证据比什么都重要。
     */
    const buildHelperSource = (plan) => {
      const p = JSON.stringify(plan);
      return [
        "'use strict';",
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        'const PLAN = ' + p + ';',
        'const log = (m) => { try { fs.appendFileSync(PLAN.logPath, new Date().toISOString() + " [helper] " + m + "\\n"); } catch {} };',
        'const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };',
        'log("start pid=" + process.pid + " waiting for parent " + PLAN.parentPid);',
        'const t0 = Date.now();',
        'const go = () => {',
        '  if (alive(PLAN.parentPid) && Date.now() - t0 < PLAN.maxWaitMs) return setTimeout(go, 250);',
        '  log("parent gone after " + (Date.now() - t0) + "ms; relaunching");',
        '  try {',
        '    const child = spawn(PLAN.execPath, PLAN.argv, { detached: true, stdio: "ignore", cwd: PLAN.cwd, env: process.env, windowsHide: true });',
        '    child.unref();',
        '    log("relaunched pid=" + child.pid);',
        '  } catch (error) { log("relaunch FAILED: " + (error && error.message)); }',
        '  process.exit(0);',
        '};',
        'go();',
        '',
      ].join('\n');
    };

    /**
     * `center.restart` —— 重启承载本插件的 dsh web 进程。
     *
     * **为什么需要它**：Node 的 ESM 模块缓存不会失效 —— `import()` 同一个路径永远
     * 拿到第一次的模块实例；而 cordis 的 HMR 只在 node 带 `--expose-internals`
     * 启动时才被加载。官方 npm 包靠 shebang 提供该参数，Windows 上 shebang 不生效
     * （npm 生成的 dsh.cmd 直接跑 `node lib/bin.js`），实测 PC 端
     * `cordis-plugin-hmr` 恒为 enabled=false / fiberPhase=null。
     * 结论：装或更新插件之后**必须重启进程**才会生效，这个端点把那一步自动化。
     *
     * **策略按证据分流，不猜**：
     *  1. 有守护进程托管 → `process.exit(0)` 交给它拉起。自己再 spawn 会与守护
     *     进程抢同一个端口，反而更糟。
     *  2. 没有（手动终端 / Windows 启动文件夹 / tmux）→ 派一个 detached 助手，
     *     等本进程真正退出、端口释放之后，再用**同一个命令行**把 dsh web 拉起来。
     *     Windows 上助手经 WMI 创建（逃出 Job Object，见 launchViaWmi）；
     *     其余平台直接 `spawn(detached)`。
     *
     * **命令行必须拼 `[...process.execArgv, ...process.argv.slice(1)]`**：
     * `argv.slice(1)` 只有 [scriptPath, ...args]，丢掉由 shebang 提供的
     * `--expose-internals`。本地实测：只带 argv.slice(1) 时新进程能绑上端口，
     * 但所有 /api 返回 404、插件一个都没加载 —— 极难定位。
     * `process.execArgv` 才是 node 实际收到的参数。
     *
     * payload:
     *   - `dryRun` (boolean)：只回报将要执行的动作，不真的做。
     */
    const opCenterRestart = async (payload) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      const dryRun = p.dryRun === true;
      const supervisor = detectSupervisor();
      const args = launchArgv();
      const mode = supervisor ? 'supervisor-exit' : 'self-reexec';

      const plan = {
        mode,
        supervisor: supervisor || null,
        pid: process.pid,
        ppid: process.ppid,
        platform: process.platform,
        execPath: process.execPath,
        execArgv: [...process.execArgv],
        argv: args,
        cwd: process.cwd(),
        logPath: join(DSH_HOME, 'restart.log'),
      };

      if (dryRun) return { ok: true, value: { scheduled: false, dryRun: true, plan } };

      if (mode === 'supervisor-exit') {
        pendingRestart = () => {
          try {
            ctx.logger?.info?.('[dsh-bridge-center] center.restart: exiting for supervisor %s', supervisor);
          } catch { /* 日志失败不影响重启 */ }
          process.exit(0);
        };
        return { ok: true, value: { scheduled: true, dryRun: false, plan } };
      }

      // 无守护进程：先落助手文件，再按平台派发。**任何一步失败都不能退出**。
      let helperPath;
      try {
        mkdirSync(DSH_HOME, { recursive: true });
        helperPath = join(DSH_HOME, 'restart-helper-' + process.pid + '-' + Date.now() + '.cjs');
        writeFileSync(helperPath, buildHelperSource({ ...plan, parentPid: process.pid, maxWaitMs: 60000 }));
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'restart-helper-unwritable',
            message: '无法写入重启助手：' + (error instanceof Error ? error.message : String(error)),
          },
        };
      }

      const helperPlan = { ...plan, helperPath };
      try {
        if (process.platform === 'win32') {
          helperPlan.helperPid = await launchViaWmi(helperPath);
        } else {
          const child = spawn(process.execPath, [helperPath], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
            cwd: process.cwd(),
          });
          child.unref();
          helperPlan.helperPid = child.pid ?? 0;
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'restart-spawn-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      // 助手已确认创建 → 现在可以安全退出了。
      // 但**不能立刻退**：响应还没写完。登记意图，交给 handler 在 res 真正
      // flush 之后执行（见 mount 循环里的 drainRestart）。
      pendingRestart = () => process.exit(0);
      return { ok: true, value: { scheduled: true, dryRun: false, plan: helperPlan } };
    };

    /**
     * 报告 PC 端 supervisor（远程唤醒守护进程）的配置，供手机端引导用。
     *
     * **为什么需要这个端点**：App 要在 dsh web 挂掉时直接找 supervisor 说话，
     * 而那时本插件也没了 —— 所以它充其量只能在**连通时**把 supervisor 的地址和
     * token 交给 App，让 App 缓存下来备用。没有这一步，用户就得手动把 token 抄进
     * 手机，而那串东西又长又没法记。
     *
     * 只读不写。token 确实敏感，但这个端点只有已认证的 dsh 客户端能访问，
     * 而 dsh web 本身在同一个 tailnet 上、暴露面比 supervisor 大得多。
     */
    const opCenterSupervisor = async (payload) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      const configPath = join(DSH_HOME, 'supervisor', 'dsh-supervisor.config.json');
      let cfg = null;
      try {
        // 和 supervisor 一样剥 BOM：PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM
        cfg = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
      } catch { /* 没装 supervisor 就走下面的 installed:false */ }

      if (!cfg || !cfg.token) {
        return { ok: true, value: { installed: false, configPath } };
      }

      const port = Number(cfg.port) || 3099;
      const host = cfg.host || '127.0.0.1';
      const dshWebPort = (cfg.dsh && Number(cfg.dsh.port)) || 3080;

      // 顺手探一下是否真的在监听：配置在但进程没起来是很常见的情况
      // （比如用户删过进程、或首次安装后还没启动）。
      let alive = false;
      if (p.probe !== false) {
        alive = await new Promise((resolvePromise) => {
          const socket = createConnection({ host, port });
          let settled = false;
          const done = (v) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolvePromise(v);
          };
          socket.setTimeout(1200);
          socket.once('connect', () => done(true));
          socket.once('error', () => done(false));
          socket.once('timeout', () => done(false));
        });
      }

      return {
        ok: true,
        value: {
          installed: true,
          alive,
          configPath,
          host,
          port,
          dshWebPort,
          // App 用它拼 https://<host>/super
          path: '/super',
          token: cfg.token,
        },
      };
    };
    // ---------- skills.* — 工作目录下技能文件的读写（列表走官方 skills/list） ----------

    /**
     * **列表不需要这里做**：官方已有 `skills/list`（@deepseek-ai/dsh-api-session-controller 的
     * sessionSkillCatalog 服务），按 sessionId 解析出 agent scope，返回真实的合并目录
     * { name, description, whenToUse?, modelInvocable }。客户端应该用它 —— 跨后端可用，
     * 也不依赖本插件。
     *
     * 这里**刻意不提供** list/get：技能目录是按 scope 分层的（ctx.skills 内部的
     * ScopedLayers），不带 scope 调用得到的是空列表 —— 插件手里没有 agent，也就没有 scope，
     * 硬做只会得到一个永远返回空的端点。这个坑值得写下来，别再踩。
     *
     * 插件负责的是另一件事：**受管技能文件的读写**。技能是文件，写和删没有官方路由，
     * 只能落在文件系统上。范围严格限定在 <cwd>/.dsh/skills/ 之内：
     *   · 用户全局根（$DSH_HOME/skills、~/.agents/skills）和内置根一律只读
     *   · 删除只删这一个受管目录，绝不碰其它根
     * 历史的坑：客户端曾有过一段「同步时删掉所有不在本地列表里的技能目录」的逻辑，
     * 那会把手工创建和 AI 现场创建的技能一并清掉 —— 所以这里只按名字删单个目录。
     */
    const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    /** 请求里的 cwd；缺省退回进程 cwd（远程调用必须显式带，否则会写到后端自己的工作目录）。 */
    const skillCwd = (payload) => {
      const raw = payload && typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
      return raw.length > 0 ? resolve(raw) : process.cwd();
    };

    /** App 唯一被允许读写的技能根。 */
    /**
     * 项目根 = 从 cwd 往上找最近的含 `.git` 的祖先，找不到就回退 cwd。
     *
     * **必须和官方 @deepseek-ai/dsh-skill-filesystem 的 findProjectRoot 完全一致**：
     * 技能目录是 `<projectRoot>/.dsh/skills`，**不是** `<cwd>/.dsh/skills`。
     *
     * 这里踩过一个很难查的坑：PC 上某个祖先目录有 `.git`，于是 projectRoot 解析到了
     * 那个祖先；技能写在 cwd 下就永远发现不了 —— 症状是「skills.save 报成功、managed
     * 也列得出来，但列表里没有」。而往 `~/.dsh/skills` 写反而立刻可见（因为那恰好等于
     * 该 projectRoot 的 `.dsh/skills`）。Android 侧没有 `.git`，会回退到 cwd，所以本地
     * 一直是好的 —— 这也是这个坑只在 PC 上暴露的原因。
     */
    const findProjectRootSync = (cwd) => {
      const start = resolve(cwd);
      let current = start;
      for (;;) {
        if (existsSync(join(current, '.git'))) return current;
        const parent = dirname(current);
        if (parent === current) return start;
        current = parent;
      }
    };
    const managedSkillRoot = (cwd) => join(findProjectRootSync(cwd), '.dsh', 'skills');

    const skillMissing = (name) => ({
      ok: false,
      error: { code: 'skills/not-found', message: '找不到技能「' + name + '」' },
    });

    /** 受管技能文件路径；名字不合法直接返回 null。 */
    const managedSkillFile = (cwd, name) => {
      if (!SKILL_NAME.test(name)) return null;
      return join(managedSkillRoot(cwd), name, 'SKILL.md');
    };

    const opSkillsRead = async (payload) => {
      const cwd = skillCwd(payload);
      const name = String((payload && payload.name) || '').trim();
      const file = managedSkillFile(cwd, name);
      if (file === null) return skillMissing(name);
      if (!existsSync(file)) return skillMissing(name);
      const text = readFileSync(file, 'utf8');
      return { ok: true, value: { name, file, dir: dirname(file), editable: true, text } };
    };

    const opSkillsSave = async (payload) => {
      const cwd = skillCwd(payload);
      const name = String((payload && payload.name) || '').trim();
      const description = String((payload && payload.description) || '').trim();
      const content = String((payload && payload.content) || '');
      const whenToUse = String((payload && payload.whenToUse) || '').trim();
      if (!SKILL_NAME.test(name)) {
        return {
          ok: false,
          error: {
            code: 'skills/invalid-name',
            message: '技能名只能用小写字母、数字和连字符（如 dsh-upgrade-triage）',
          },
        };
      }
      if (description.length === 0) {
        // 描述决定模型何时调用这个技能，空描述等于技能永远不生效 —— 宁可报错也别写个废技能。
        return {
          ok: false,
          error: { code: 'skills/invalid-description', message: '描述不能为空：模型靠它判断何时使用该技能' },
        };
      }
      const dir = join(managedSkillRoot(cwd), name);
      const file = join(dir, 'SKILL.md');
      const lines = ['---', 'name: ' + name, 'description: ' + description.replace(/\r?\n/g, ' ')];
      if (whenToUse.length > 0) lines.push('whenToUse: ' + whenToUse.replace(/\r?\n/g, ' '));
      // 保存时保留「已禁用」状态，否则编辑一次就把开关重置了。
      if (payload && payload.disabled === true) lines.push('disable-model-invocation: true');
      lines.push('---');
      const body = content.trim();
      const text = body.length > 0 ? lines.join('\n') + '\n\n' + body + '\n' : lines.join('\n') + '\n';
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text, 'utf8');
      // 目录缓存必须显式失效：文件监听是异步的，紧接着 list 会拿到旧快照。
      ctx.skills.invalidateCache?.();
      return { ok: true, value: { name, dir, file, editable: true } };
    };

    /** 受管根里现有哪些技能 —— 客户端据此标出「可编辑」，其余显示为只读。 */
    const opSkillsManaged = async (payload) => {
      const cwd = skillCwd(payload);
      const root = managedSkillRoot(cwd);
      let names = [];
      if (existsSync(root)) {
        try {
          names = readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory() && SKILL_NAME.test(e.name))
            .map((e) => e.name)
            .sort();
        } catch {
          names = [];
        }
      }
      return { ok: true, value: { cwd, root, names } };
    };

    /**
     * 启用/禁用 = 在 frontmatter 里加/去 `disable-model-invocation: true`。
     *
     * 刻意用**调用策略**而不是改名或搬走文件：技能仍在目录里、仍会出现在目录列表中并带
     * modelInvocable=false，用户看得见"我禁用了它"；改名藏起来会让人以为技能丢了。
     * 这个键名是 dsh 的规范名（parseInvocationPolicy 明确拒绝旧的
     * disableModelInvocation / modelInvocable 写法）。
     */
    const opSkillsSetEnabled = async (payload) => {
      const cwd = skillCwd(payload);
      const name = String((payload && payload.name) || '').trim();
      const enabled = !payload || payload.enabled !== false;
      const file = managedSkillFile(cwd, name);
      if (file === null) return skillMissing(name);
      if (!existsSync(file)) return skillMissing(name);
      const lines = readFileSync(file, 'utf8').split('\n');
      if (lines.length === 0 || lines[0].trim() !== '---') {
        return { ok: false, error: { code: 'skills/no-frontmatter', message: 'SKILL.md 开头没有 frontmatter' } };
      }
      let end = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') { end = i; break; }
      }
      if (end < 0) {
        return { ok: false, error: { code: 'skills/no-frontmatter', message: 'frontmatter 缺少结束的 ---' } };
      }
      // 先摘掉已有的同名键（避免重复），再按需追加。
      const head = lines.slice(1, end).filter((l) => !/^\s*disable-model-invocation\s*:/.test(l));
      if (!enabled) head.push('disable-model-invocation: true');
      const next = ['---'].concat(head, ['---']).concat(lines.slice(end + 1)).join('\n');
      writeFileSync(file, next, 'utf8');
      ctx.skills.invalidateCache?.();
      return { ok: true, value: { name, file, enabled } };
    };

    const opSkillsRemove = async (payload) => {
      const cwd = skillCwd(payload);
      const name = String((payload && payload.name) || '').trim();
      if (!SKILL_NAME.test(name)) {
        return { ok: false, error: { code: 'skills/invalid-name', message: '技能名不合法' } };
      }
      const dir = join(managedSkillRoot(cwd), name);
      if (!existsSync(dir)) return { ok: true, value: { removed: false, dir, reason: '目录不存在' } };
      // 兜底：确认目标就是 <cwd>/.dsh/skills/<name>，绝不越界删。
      if (dirname(resolve(dir)) !== managedSkillRoot(cwd)) {
        return { ok: false, error: { code: 'skills/out-of-scope', message: '只允许删除工作目录下的技能' } };
      }
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink()) {
        // 是链接就只解链，绝不递归跟进到别处。
        unlinkSync(dir);
        ctx.skills.invalidateCache?.();
        return { ok: true, value: { removed: true, dir, symlink: true } };
      }
      if (!stat.isDirectory()) {
        return { ok: false, error: { code: 'skills/not-a-directory', message: dir + ' 不是目录' } };
      }
      rmSync(dir, { recursive: true, force: true });
      ctx.skills.invalidateCache?.();
      return { ok: true, value: { removed: true, dir } };
    };

    const OPERATIONS = {
      'plugins.list': opPluginList,
      'skills.managed': opSkillsManaged,
      'skills.read': opSkillsRead,
      'skills.setEnabled': opSkillsSetEnabled,
      'skills.save': opSkillsSave,
      'skills.remove': opSkillsRemove,
      'plugins.setEnabled': opPluginSetEnabled,
      'plugins.remove': opPluginRemove,
      'plugins.install': opPluginInstall,
      'center.describe': opCenterDescribe,
      'center.catalog': opCenterCatalog,
      'center.restart': opCenterRestart,
      'center.supervisor': opCenterSupervisor,
    };

    /**
     * 每个方法的请求体上限。只有安装端点放宽 —— readBody 默认仍是 1 MiB。
     * 见 INSTALL_MAX_BODY 上的注释。
     */
    const BODY_LIMITS = { 'plugins.install': INSTALL_MAX_BODY };

    // ---------- HTTP mount ----------

    // Register one exact route per method. Exact routes are matched before the
    // official /api prefix channel, so these endpoints win without touching
    // the connection layer; the envelope/rpcId discipline mirrors the official
    // unary carrier so clients need no adaptation.
    //
    // ⚠️ 「不碰 connection 层」有个必须自己补上的代价：官方那层的认证也一起跳过了。
    // 所以下面每个 handler 的第一件事都是 `gate()`，而 gate() 里显式调用了
    // `connection.requestRejection()`。**改这里时必须保证 gate() 仍是第一步**，
    // 且新增端点也要走 gate —— 漏一个就是无认证端点。
    for (const [method, operation] of Object.entries(OPERATIONS)) {
      const path = `/api/${method}`;
      ctx.effect(
        () =>
          webServer.register({
            kind: 'exact',
            path,
            handler: async (req, res) => {
              if (!gate(req, res)) return;
              let bodyText;
              try {
                bodyText = await readBody(req, BODY_LIMITS[method] ?? MAX_BODY);
              } catch {
                json(res, 413, { ok: false, error: 'request body too large' });
                return;
              }
              const env = decodeEnvelope(bodyText);
              if (!env) {
                json(res, 400, { ok: false, error: 'malformed client-request envelope' });
                return;
              }
              if (env.method !== method) {
                json(res, 400, {
                  ok: false,
                  error: `method mismatch: expected ${method}, got ${env.method}`,
                });
                return;
              }
              let result;
              try {
                result = await operation(env.payload, req);
              } catch (error) {
                result = {
                  ok: false,
                  error: {
                    code: 'internal',
                    message: error instanceof Error ? error.message : String(error),
                  },
                };
              }
              json(res, 200, { type: 'server-response', rpcId: env.rpcId, result });
              drainRestart(res);
            },
          }),
        `${PLUGIN_ID}: ${path} route`
      );
    }

    ctx.logger?.info?.('[dsh-bridge-center] mounted %d endpoints (profile=%s, token=%s)', Object.keys(OPERATIONS).length, PROFILE, TOKEN ? 'on' : 'off');
  },
};
