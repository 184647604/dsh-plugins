// dsh-mcp-admin — MCP server management SUB-plugin of the plugin-center master.
//
// This package manages MCP server instances (mcp.*) on a dsh web backend that
// runs the plugin-center master (dsh-bridge-center). It is an ordinary,
// NON-protected plugin: the master can install it, enable/disable it and
// remove it like any other plugin. It is the "MCP" entry of the master's
// center.catalog.
//
// Endpoints (all over the standard dsh unary envelope — POST /api/mcp.<method>,
// client-request / server-response with rpcId echo):
//   * mcp.list / mcp.add / mcp.update / mcp.remove / mcp.setEnabled / mcp.restart
//
// Mechanics (same verified pattern as the community dsh-mcp-market):
//   * Live activation via ctx.loader.create/update/remove — HMR reconnects the
//     official @deepseek-ai/dsh-mcp-client instance on config change, so a new
//     server's tools become model-callable without restarting dsh web.
//   * Persistence into the profile's cordis.patch.yml inside an auto-generated
//     managed comment block (# --- dsh-mcp-admin managed ---); user edits
//     elsewhere are kept. Legacy blocks written by the integrated master
//     (dsh-plugin-center managed) are recognized and normalized on the next
//     write, so an in-place migration never duplicates entries.
//   * Optional bearer-style token (config.token or DSH_MCP_ADMIN_TOKEN env):
//     when set, every request must carry x-dsh-mcp-token. When unset, only
//     loopback/same-origin callers pass (CSRF gate).
//
// Build note: plain ESM JS, ZERO runtime dependencies (js-yaml vendored under
// ./vendor). Disabling this plugin only stops the mcp.* management surface —
// already-connected server instances keep running (their tools stay usable);
// remove servers with mcp.remove before uninstalling the plugin if you want a
// full teardown.

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
import yaml from '../vendor/js-yaml/index.js';

const PLUGIN_ID = 'dsh-mcp-admin';
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
// 当前 managed 标记(dsh-mcp-admin 写入);同时识别集成期 dsh-bridge-center 写入的
// 遗留标记,一次写回即归一,避免同源条目双份。
const MANAGED_HEAD = '# --- dsh-mcp-admin managed (auto-generated; do not edit) ---';
const MANAGED_TAIL = '# --- end dsh-mcp-admin managed ---';
const LEGACY_MANAGED_HEAD = '# --- dsh-plugin-center managed (auto-generated; do not edit) ---';
const LEGACY_MANAGED_TAIL = '# --- end dsh-plugin-center managed ---';
const MARKER_PAIRS = [
  [MANAGED_HEAD, MANAGED_TAIL],
  [LEGACY_MANAGED_HEAD, LEGACY_MANAGED_TAIL],
];
const MAX_BODY = 1024 * 1024; // 1 MiB — the API has no legitimate large payloads.
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

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
 * 读取 patch 层。只有"文件确实不存在"才算空；其它错误(EACCES/EISDIR/EMFILE/ELOOP…)
 * 一律上抛——把读失败静默当成空文件，会让下一次写入用"只含我们新条目"的内容覆盖掉
 * 用户真实的 patch 层，即权限故障演变成静默数据丢失。
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
 * 原子替换 patch 层。writeFileSync 对已存在文件是 O_TRUNC + 增量写，进程被杀 / OOM /
 * ENOSPC 会留下半截文件，而该文件是 profile 启动的必需输入——损坏是永久的：此后每次
 * dsh web 启动都解析失败。改为同目录临时文件 + fsync + rename 覆盖：rename(2) 在同一
 * 文件系统内原子，读者要么看到旧内容要么看到新内容，不会看到截断的混合体。
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

// ---------------------------------------------------------------------------
// Managed-block persistence (dsh-mcp-admin owns the MCP instance block).
// ---------------------------------------------------------------------------

function extractManagedBlocks(text) {
  const blocks = [];
  for (const [head, tail] of MARKER_PAIRS) {
    const re = new RegExp(`${escapeRegExp(head)}[\\s\\S]*?${escapeRegExp(tail)}`, 'g');
    let match;
    while ((match = re.exec(text)) !== null) blocks.push(match[0]);
  }
  return blocks;
}

function stripManagedBlock(text) {
  let out = text;
  for (const block of extractManagedBlocks(text)) {
    out = out.replace(block, '');
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

function parseManagedEntries(text) {
  const entries = [];
  for (const block of extractManagedBlocks(text)) {
    try {
      const root = yaml.load(block);
      if (!Array.isArray(root)) continue;
      for (const node of root) {
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node.insert)) {
          for (const ins of node.insert) {
            if (ins && typeof ins.id === 'string' && typeof ins.name === 'string') {
              entries.push({ id: ins.id, name: ins.name, config: ins.config ?? {}, disabled: false });
            }
          }
        } else if (typeof node.id === 'string' && node.disabled === true) {
          const hit = entries.find((entry) => entry.id === node.id);
          if (hit) hit.disabled = true;
        }
      }
    } catch {
      // Generated blocks always parse; treat a malformed block as empty.
    }
  }
  return entries;
}

function renderManagedBlock(entries) {
  const lines = [MANAGED_HEAD];
  for (const entry of entries) {
    lines.push(
      yaml
        .dump([{ insert: [{ id: entry.id, name: entry.name, config: entry.config }] }], {
          lineWidth: 160,
          noRefs: true,
        })
        .trimEnd()
    );
    if (entry.disabled) {
      lines.push(yaml.dump([{ id: entry.id, disabled: true }], { noRefs: true }).trimEnd());
    }
  }
  lines.push(MANAGED_TAIL);
  return `${lines.join('\n')}\n`;
}

function withManagedEntries(text, mutate) {
  const entries = parseManagedEntries(text);
  mutate(entries);
  const rest = stripManagedBlock(text).trimEnd().replace(/\n+$/, '');
  const headerLines = rest.split('\n').filter((line) => /^\s*#/.test(line));
  const effective = rest.replace(/^\s*#.*$/gm, '').trim();
  const emptyBase = effective === '' || effective === '[]' || effective === '---';
  const header = headerLines.length > 0 ? `${headerLines.join('\n')}\n` : '';
  if (emptyBase) {
    if (entries.length === 0) return `${header}[]\n`;
    return header + renderManagedBlock(entries);
  }
  return `${rest}\n${renderManagedBlock(entries)}`;
}

/** All MCP client instances declared in the patch layer — managed or hand-written. */
function parseMcpInstances(text) {
  const managed = new Map(parseManagedEntries(text).map((entry) => [entry.id, entry]));
  const instances = [];
  let parsed = null;
  try {
    parsed = yaml.load(text);
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed)) {
    const disabledIds = new Set();
    const found = [];
    for (const node of parsed) {
      if (!node || typeof node !== 'object') continue;
      const n = node;
      if (typeof n.id === 'string' && n.disabled === true) disabledIds.add(n.id);
      if (!Array.isArray(n.insert)) continue;
      for (const ins of n.insert) {
        if (ins && ins.name === MCP_CLIENT_PACKAGE && typeof ins.id === 'string') {
          found.push({
            id: ins.id,
            config: ins.config ?? {},
            disabled: ins.disabled === true,
            managed: managed.has(ins.id),
          });
        }
      }
    }
    for (const instance of found) {
      if (disabledIds.has(instance.id)) instance.disabled = true;
    }
    return found;
  }
  // Fallback scan for files with !!js expressions etc.
  const lines = text.split('\n');
  let pendingId = null;
  for (const line of lines) {
    const idMatch = /^\s*-\s*id:\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
    if (idMatch) {
      pendingId = idMatch[1];
      continue;
    }
    if (pendingId !== null) {
      if (line.includes(`name: '${MCP_CLIENT_PACKAGE}'`)) {
        instances.push({ id: pendingId, config: {}, disabled: false, managed: managed.has(pendingId) });
        pendingId = null;
      } else if (/^\s*-\s/.test(line) && !/^\s*-\s*id:/.test(line)) {
        pendingId = null;
      }
    }
  }
  return instances;
}

// ---------------------------------------------------------------------------
// Server definition validation and config building.
// ---------------------------------------------------------------------------

function validateNewServer(input) {
  if (!input || typeof input !== 'object') return 'invalid payload';
  if (typeof input.serverName !== 'string' || !SERVER_NAME_RE.test(input.serverName)) {
    return 'serverName must match [A-Za-z0-9_-]{1,32}';
  }
  if (input.transport === 'stdio') {
    if (typeof input.command !== 'string' || input.command === '') {
      return 'stdio servers need a command';
    }
  } else if (input.transport === 'streamable-http') {
    if (typeof input.url !== 'string' || !/^https?:\/\//.test(input.url)) {
      return 'streamable-http servers need a valid http(s) url';
    }
  } else {
    return `unknown transport: ${String(input.transport)}`;
  }
  return null;
}

function buildMcpConfig(input) {
  const base = { serverName: input.serverName };
  if (input.toolCallTimeoutMs !== undefined) base.toolCallTimeoutMs = input.toolCallTimeoutMs;
  if (input.transport === 'streamable-http') {
    base.transport = 'streamable-http';
    base.url = input.url;
    if (input.headers && Object.keys(input.headers).length > 0) base.headers = input.headers;
  } else {
    base.transport = 'stdio';
    base.command = input.command;
    if (input.args && input.args.length > 0) base.args = input.args;
    if (input.env && Object.keys(input.env).length > 0) base.env = input.env;
    if (input.cwd) base.cwd = input.cwd;
  }
  return base;
}

function entryIdFor(serverName) {
  return `mcp-${serverName}`;
}

/** Snapshot of one configured server with live loader state. */
function describeInstance(loader, instance) {
  const config = instance.config ?? {};
  const id = instance.id;
  let live = null;
  try {
    const entry = loader.resolve(id);
    live = { loaded: true, disabled: entry.disabled === true };
  } catch {
    live = { loaded: false, disabled: instance.disabled === true };
  }
  return {
    id,
    managed: instance.managed === true,
    disabled: instance.disabled === true,
    serverName: config.serverName ?? id.replace(/^mcp-/, ''),
    transport: config.transport ?? (config.url ? 'streamable-http' : 'stdio'),
    ...(config.command ? { command: config.command } : {}),
    ...(Array.isArray(config.args) ? { args: config.args } : {}),
    ...(config.env && typeof config.env === 'object' ? { env: config.env } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.url ? { url: config.url } : {}),
    ...(config.headers && typeof config.headers === 'object' ? { headers: config.headers } : {}),
    ...(config.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: config.toolCallTimeoutMs } : {}),
    live,
  };
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

// 命名导出:持久化与解析原语,供行为级回归测试直接驱动
// (见 test/patch-persistence.test.mjs)。纯函数/纯文件操作,不接触 loader。
export {
  parseManagedEntries,
  patchFilePath,
  readPatchText,
  renderManagedBlock,
  withManagedEntries,
  writePatchText,
};

export default {
  name: PLUGIN_ID,
  inject: ['webServer', 'loader'],

  apply(ctx, config = {}) {
    const webServer = ctx.webServer;
    const loader = ctx.loader;

    const TOKEN = String(config.token || process.env.DSH_MCP_ADMIN_TOKEN || '').trim();
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
        const got = String(req.headers['x-dsh-mcp-token'] || '').trim();
        if (got !== TOKEN) {
          json(res, 403, { ok: false, error: 'invalid token' });
          return false;
        }
      }
      return true;
    };

    // ---------- mcp.* operations ----------

    const opList = async () => {
      const text = readPatchText(PROFILE);
      const instances = parseMcpInstances(text);
      return {
        ok: true,
        value: { servers: instances.map((inst) => describeInstance(loader, inst)) },
      };
    };

    const opAdd = async (payload) => {
      const validation = validateNewServer(payload);
      if (validation) return { ok: false, error: { code: 'invalid-request', message: validation } };
      const id = entryIdFor(payload.serverName);
      const config = buildMcpConfig(payload);
      const text = readPatchText(PROFILE);
      if (parseMcpInstances(text).some((entry) => entry.id === id)) {
        return { ok: false, error: { code: 'conflict', message: `already installed: ${id}` } };
      }
      // Live first: activation must succeed before anything is written to disk.
      try {
        await loader.create({ id, name: MCP_CLIENT_PACKAGE, config });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'activation-failed',
            message: `activation failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
      try {
        writePatchText(
          PROFILE,
          withManagedEntries(text, (entries) => {
            entries.push({ id, name: MCP_CLIENT_PACKAGE, config, disabled: false });
          })
        );
      } catch (error) {
        try {
          await loader.remove(id);
        } catch { /* best-effort rollback */ }
        return {
          ok: false,
          error: { code: 'persist-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      return { ok: true, value: { id } };
    };

    const findOrError = (text, id) => {
      const inst = parseMcpInstances(text).find((entry) => entry.id === id);
      if (!inst) return null;
      return inst;
    };

    const opUpdate = async (payload) => {
      const id = String(payload.id || '');
      if (!id) return { ok: false, error: { code: 'invalid-request', message: 'missing id' } };
      if (!payload.serverName) return { ok: false, error: { code: 'invalid-request', message: 'missing serverName' } };
      const validation = validateNewServer(payload);
      if (validation) return { ok: false, error: { code: 'invalid-request', message: validation } };
      const config = buildMcpConfig(payload);
      const text = readPatchText(PROFILE);
      if (!findOrError(text, id)) {
        return { ok: false, error: { code: 'not-found', message: `not installed: ${id}` } };
      }
      try {
        await loader.update(id, { config });
      } catch (error) {
        return {
          ok: false,
          error: { code: 'update-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      try {
        writePatchText(
          PROFILE,
          withManagedEntries(text, (entries) => {
            const hit = entries.find((entry) => entry.id === id);
            if (hit) {
              hit.name = MCP_CLIENT_PACKAGE;
              hit.config = config;
              hit.disabled = false;
            }
          })
        );
      } catch (error) {
        return { ok: false, error: { code: 'persist-failed', message: error instanceof Error ? error.message : String(error) } };
      }
      return { ok: true, value: { id } };
    };

    const opRemove = async (payload) => {
      const id = String(payload.id || '');
      if (!id) return { ok: false, error: { code: 'invalid-request', message: 'missing id' } };
      const text = readPatchText(PROFILE);
      if (!findOrError(text, id)) {
        return { ok: false, error: { code: 'not-found', message: `not installed: ${id}` } };
      }
      try {
        await loader.remove(id);
      } catch (error) {
        return {
          ok: false,
          error: { code: 'deactivation-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      try {
        writePatchText(
          PROFILE,
          withManagedEntries(text, (entries) => {
            const index = entries.findIndex((entry) => entry.id === id);
            if (index !== -1) entries.splice(index, 1);
          })
        );
      } catch (error) {
        return { ok: false, error: { code: 'persist-failed', message: error instanceof Error ? error.message : String(error) } };
      }
      return { ok: true, value: { id } };
    };

    const opSetEnabled = async (payload) => {
      const id = String(payload.id || '');
      if (!id) return { ok: false, error: { code: 'invalid-request', message: 'missing id' } };
      if (typeof payload.enabled !== 'boolean') {
        return { ok: false, error: { code: 'invalid-request', message: 'enabled must be a boolean' } };
      }
      const disabled = !payload.enabled;
      const text = readPatchText(PROFILE);
      if (!findOrError(text, id)) {
        return { ok: false, error: { code: 'not-found', message: `not installed: ${id}` } };
      }
      try {
        await loader.update(id, { disabled });
      } catch (error) {
        return {
          ok: false,
          error: { code: 'update-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      try {
        writePatchText(
          PROFILE,
          withManagedEntries(text, (entries) => {
            const hit = entries.find((entry) => entry.id === id);
            if (hit) hit.disabled = disabled;
          })
        );
      } catch (error) {
        return { ok: false, error: { code: 'persist-failed', message: error instanceof Error ? error.message : String(error) } };
      }
      return { ok: true, value: { id, enabled: payload.enabled } };
    };

    const opRestart = async (payload) => {
      const id = String(payload.id || '');
      if (!id) return { ok: false, error: { code: 'invalid-request', message: 'missing id' } };
      const text = readPatchText(PROFILE);
      if (!findOrError(text, id)) {
        return { ok: false, error: { code: 'not-found', message: `not installed: ${id}` } };
      }
      try {
        await loader.update(id, { disabled: true });
        await loader.update(id, { disabled: false });
      } catch (error) {
        return {
          ok: false,
          error: { code: 'restart-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
      return { ok: true, value: { id } };
    };

    const OPERATIONS = {
      'mcp.list': opList,
      'mcp.add': opAdd,
      'mcp.update': opUpdate,
      'mcp.remove': opRemove,
      'mcp.setEnabled': opSetEnabled,
      'mcp.restart': opRestart,
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

    ctx.logger?.info?.('[dsh-mcp-admin] mounted %d MCP endpoints (profile=%s, token=%s)', Object.keys(OPERATIONS).length, PROFILE, TOKEN ? 'on' : 'off');
  },
};
