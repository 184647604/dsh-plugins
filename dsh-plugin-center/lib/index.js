// dsh-plugin-center — the plugin-center MASTER (management bridge) for dsh web.
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
//     env): when set, every request must carry x-dsh-plugin-center-token.
//     When unset, only loopback/same-origin callers pass (CSRF gate).
//
// Build note: plain ESM JS, ZERO runtime dependencies (pure text patch ops —
// no YAML needed). Protected: the master refuses to disable/remove itself or
// official @deepseek-ai/* system core.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

const PLUGIN_ID = 'dsh-plugin-center';
const MAX_BODY = 1024 * 1024; // 1 MiB — the API has no legitimate large payloads.

/** 官方子插件目录（挂在插件中心之上的可管理插件）。 */
const SUBPLUGIN_CATALOG = [
  {
    package: 'dsh-mcp-admin',
    role: 'mcp',
    title: 'MCP 服务器管理',
    description: 'MCP 服务器实例(mcp.*)子插件:增删改查/启停/重启,loader 热生效',
  },
  {
    package: 'dsh-file-transfer',
    role: 'transfer',
    title: '文件传输',
    description: '原始字节流式落盘端点(/api/transfer.write):把手机上的文件写进后端文件系统',
  },
];

// ---------------------------------------------------------------------------
// Profile patch-layer filesystem access.
// ---------------------------------------------------------------------------

function profileDirFor(profileName) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'profiles', profileName);
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

// 纯文本 patch 操作的命名导出:仅用于行为级回归测试(见 test/patch-ops.test.mjs)。
// 三者均为纯函数,不接触 loader/HTTP,导出不影响 default 插件的形状。
export { findPluginBlock, removePluginEntry, setPluginEnabled };

export default {
  name: PLUGIN_ID,
  inject: ['webServer', 'loader'],

  apply(ctx, config = {}) {
    const webServer = ctx.webServer;
    const loader = ctx.loader;

    const TOKEN = String(config.token || process.env.DSH_PLUGIN_CENTER_TOKEN || process.env.DSH_MCP_ADMIN_TOKEN || '').trim();
    // 显式 config.profile 优先;否则用启动 --profile;最后回退 web。
    const PROFILE = String(config.profile || argvProfile() || 'web').trim();

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

    const readBody = (req) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
          const s = String(c);
          size += s.length;
          if (size > MAX_BODY) {
            reject(new Error('request body too large'));
            return;
          }
          chunks.push(s);
        });
        req.on('end', () => resolve(chunks.join('')));
        req.on('error', reject);
      });

    const gate = (req, res) => {
      if (String(req.method || 'POST').toUpperCase() !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' });
        return false;
      }
      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: 'untrusted origin' });
        return false;
      }
      if (TOKEN) {
        const got = String(req.headers['x-dsh-plugin-center-token'] || req.headers['x-dsh-mcp-token'] || '').trim();
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

    const opPluginList = async () => {
      const entries = [];
      for (const entry of loader.entries()) {
        if (entry.options && entry.options.group) continue;
        const name = (entry.options && entry.options.name) || entry.id;
        const bridge = isBridgePlugin(entry);
        entries.push({
          id: entry.id,
          name,
          enabled: !entry.disabled,
          fiberPhase: entry.fiber === void 0 ? null : FIBER_PHASE[entry.fiber.state],
          // 系统核心(官方 @deepseek-ai/*)与管理桥受保护,App 端据此禁用操作。
          system: name.startsWith(SYSTEM_PLUGIN_PREFIX) && !bridge,
          protected: bridge || name.startsWith(SYSTEM_PLUGIN_PREFIX),
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
        return { ok: false, error: { code: 'protected', message: 'dsh-plugin-center is the management bridge' } };
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
        return { ok: false, error: { code: 'protected', message: 'dsh-plugin-center is the management bridge' } };
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

    // ---------- center.* — 插件中心总操作 ----------

    const opCenterDescribe = async () => ({
      ok: true,
      value: {
        id: PLUGIN_ID,
        name: 'dsh-plugin-center',
        version: readPluginVersion(),
        kind: 'master',
        profile: PROFILE,
        tokenAuth: TOKEN.length > 0,
        capabilities: [
          'plugins.list', 'plugins.setEnabled', 'plugins.remove',
          'center.describe', 'center.catalog',
        ],
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

    const OPERATIONS = {
      'plugins.list': opPluginList,
      'plugins.setEnabled': opPluginSetEnabled,
      'plugins.remove': opPluginRemove,
      'center.describe': opCenterDescribe,
      'center.catalog': opCenterCatalog,
    };

    // ---------- HTTP mount ----------

    // Register one exact route per method. Exact routes are matched before the
    // official /api prefix channel, so these endpoints win without touching
    // the connection layer; the envelope/rpcId discipline mirrors the official
    // unary carrier so clients need no adaptation.
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
                bodyText = await readBody(req);
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
                result = await operation(env.payload);
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
            },
          }),
        `${PLUGIN_ID}: ${path} route`
      );
    }

    ctx.logger?.info?.('[dsh-plugin-center] mounted %d endpoints (profile=%s, token=%s)', Object.keys(OPERATIONS).length, PROFILE, TOKEN ? 'on' : 'off');
  },
};
