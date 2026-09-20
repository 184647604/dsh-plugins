/**
 * 目标注册表 —— 配置里的静态目标 + 运行时加入的动态目标,统一成一份可持久化的清单。
 *
 * ## 为什么要有它
 *
 * 原先目标只来自 `cordis.patch.yml` 的 `targets`,那是**静态**的:用户在 App 里
 * 选了另一台机器、或者临时想连一台普通服务器,就得改 YAML 再重启后端。
 * 这个模块把「用户选的目标」落盘,插件重启后还在,而 App 通过路由增删。
 *
 * ## 两个来源的优先级
 *
 * 1. **配置里的**(`cordis.patch.yml`)—— 只读,优先级最高。
 *    用户在 YAML 里写的东西不该被路由悄悄改掉;要改就得改 YAML。
 * 2. **运行时加入的** —— 落盘到 `$DSH_HOME/ssh-link/targets.json`,可增删。
 *
 * 同名时配置胜出,并且**拒绝**用路由覆盖它 —— 静默失败比报错更难查。
 *
 * ## 落盘为什么不用「读-改-写」
 *
 * 同一个文件会被多个路由并发写。`readFileSync` → 改 → `writeFileSync` 在并发下
 * 会丢更新(尤其 authorized_keys 那种追加语义)。这里所有变更走一个内存态,
 * 由 [TargetRegistry] 串行化,再整体原子落盘。
 *
 * @module dsh-ssh-link/registry
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_TARGET } from './transport.js';

/** 目标名的合法形状:路由与工具都拿它当寻址键,所以限制成保守的字符集。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 主机名/IP 的合法形状。允许 IPv6 的冒号与 Tailscale 的短名。 */
const HOST_RE = /^[A-Za-z0-9._:[\]-]{1,255}$/;

/**
 * 从一个 host 折算出合法的目标名。
 *
 * IPv6 的冒号/方括号、以及可能的其它字符都要换掉 —— name 是寻址键,
 * 不能带这些。结果可能撞名(两台机器的 IPv6 折叠后一样),那时由调用方
 * 的重名检查报错,而不是在这里静默加后缀(静默改名会让"我明明写的那个"
 * 找不回来)。
 *
 * @param {string} host - 已经过 HOST_RE 校验的 host。
 * @returns {string} 合法的 name。
 */
function sanitizeNameFromHost(host) {
  const cleaned = String(host)
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 64);
  // NAME_RE 要求首字符是字母或数字;IPv6 折叠后可能以 `-` 开头(例如 ::1 → --1)。
  const lead = cleaned.replace(/^[^A-Za-z0-9]+/, '');
  return lead.length > 0 ? lead : 'target';
}

/**
 * 校验并归一一个目标。
 *
 * **所有入口都要过这里** —— 配置、路由、自动配对三条路进来的是同一种东西,
 * 校验写一处才不会出现「路由校验了、配对路径漏了」这种洞。
 *
 * @param {object} raw - 候选目标(可能是网络输入)。
 * @param {object} [opts]
 * @param {object} [opts.defaults] - 缺省值来源(通常是 DEFAULT_TARGET)。
 * @param {boolean} [opts.requireName] - 是否强制要求 name。
 * @returns {object} 归一后的目标。
 * @throws {TypeError} 非法输入。错误信息不含原始值的完整回显。
 */
export function normalizeTarget(raw, opts = {}) {
  if (raw == null || typeof raw !== 'object') throw new TypeError('target must be an object');
  const defaults = opts.defaults ?? {};

  const host = String(raw.host ?? '').trim();
  if (host.length === 0) throw new TypeError('target.host is required');
  if (!HOST_RE.test(host)) throw new TypeError('target.host has an unsupported shape');

  // name 缺省就用 host —— 与旧行为一致(以前 normalizeTarget 就这么做)。
  //
  // 但 IPv6 的 host({`::1`}、{`[fe80::1]`})**不能**直接当 name:冒号与方括号
  // 不在 NAME_RE 里,而 name 又是路由/工具的寻址键(会出现在 URL 路径与 JSON
  // 字段里)。所以这里把 host 折算成一个安全的名字,而不是让整条配置失败 ——
  // 「能用 IPv6 当 host」本身是必须支持的(局域网/Tailscale 场景很常见)。
  let name = String(raw.name ?? '').trim();
  if (name.length === 0) {
    if (opts.requireName) throw new TypeError('target.name is required');
    name = sanitizeNameFromHost(host);
  }
  if (!NAME_RE.test(name)) {
    throw new TypeError(
      'target.name must start alphanumeric and use only letters, digits, dot, dash, underscore (max 64)',
    );
  }

  // 注意:这里**不能**先 Math.trunc 再校验 —— 那会把 1.5 静默变成 1、
  // 把 "22abc" 静默变成 NaN 之外的东西。端口是直接进 ssh argv 的值,
  // 只接受「整数本身」,浮点/带后缀的字符串一律拒。
  const portRaw = raw.port == null || raw.port === '' ? defaults.port : raw.port;
  const port = typeof portRaw === 'string' && /^[0-9]+$/.test(portRaw.trim())
    ? Number(portRaw.trim())
    : typeof portRaw === 'number' && Number.isInteger(portRaw)
      ? portRaw
      : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('target.port must be an integer between 1 and 65535');
  }

  const user = String(raw.user ?? defaults.user ?? '').trim();
  // user 会进 ssh 的 argv,所以只允许保守字符集 —— 空格/前导 - 都可能被 ssh 当选项解释。
  if (user.length > 0 && !/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    throw new TypeError('target.user has an unsupported shape');
  }

  const dsh = String(raw.dsh ?? defaults.dsh ?? 'dsh').trim() || 'dsh';
  const profile = String(raw.profile ?? defaults.profile ?? 'headless').trim() || 'headless';

  return {
    name,
    host,
    port,
    user,
    dsh,
    profile,
    /**
     * 来源标记 —— 只有两种。
     * - `config`   配置里的,只读(路由会拒绝删除,避免"删了又出现")
     * - `manual`   用户在 App 面板里手填的任意 SSH 地址
     *
     * 以前还有 `paired`(自动配对发现的)与配套的 `auto` 字段。配对是服务端能力,
     * 已随服务端一起删掉 —— 现在没有任何代码路径会产生它们,留着只会让下一个人
     * 以为"配对"还存在。
     */
    source: raw.source === 'config' ? 'config' : 'manual',
    /** 最近一次探测结果,由 ssh.test 回写,纯展示用。 */
    lastSeenAt: Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 300) : null,
  };
}

/**
 * 目标注册表。
 *
 * 变更方法都是**同步**的:它们只碰内存与一个小 JSON 文件,没有 IO 等待,
 * 同步实现反而消除了并发窗口。真正的网络动作(runRemote)在调用方做。
 */
export class TargetRegistry {
  /**
   * @param {object} opts
   * @param {object[]} [opts.configured] - 配置里的目标(只读,优先)。
   * @param {string} opts.statePath - 动态目标的落盘路径。
   */
  constructor(opts) {
    this.statePath = opts.statePath;
    /** 配置里的目标:name → target。整场只读。 */
    this.configured = new Map();
    for (const t of opts.configured ?? []) {
      const n = normalizeTarget(
        { ...t, source: 'config' },
        { defaults: DEFAULT_TARGET, requireName: true },
      );
      if (this.configured.has(n.name)) throw new Error('ssh-link: target 重名 "' + n.name + '"');
      this.configured.set(n.name, n);
    }
    /** 运行时加入的目标:name → target。 */
    this.dynamic = new Map();
    this.#loadState();
  }

  /** 落盘的状态形状:只存动态目标,配置里的不落盘。 */
  #loadState() {
    let raw = null;
    try {
      if (existsSync(this.statePath)) raw = JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch {
      // 损坏的状态文件不该让插件起不来 —— 丢弃它,从空开始。
      raw = null;
    }
    const list = Array.isArray(raw?.targets) ? raw.targets : [];
    for (const t of list) {
      try {
        const n = normalizeTarget(t, { defaults: DEFAULT_TARGET, requireName: true });
        // 配置里已有的同名目标优先,动态的丢弃 —— 避免两处都能改同一个东西。
        if (!this.configured.has(n.name)) this.dynamic.set(n.name, n);
      } catch {
        // 单条坏数据跳过,不牵连整份状态。
      }
    }
  }

  /** 原子落盘。 */
  #saveState() {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(
      { version: 1, targets: [...this.dynamic.values()] },
      null,
      2,
    );
    const tmp = this.statePath + '.' + process.pid + '.tmp';
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  /** 全部目标(配置优先,顺序稳定:先配置后动态)。 */
  list() {
    return [...this.configured.values(), ...this.dynamic.values()];
  }

  /** 按名字取;`''`/null 表示「默认那个」。找不到返回 undefined。 */
  get(name) {
    if (name == null || name === '') return undefined;
    return this.configured.get(String(name)) ?? this.dynamic.get(String(name));
  }

  /** 是否存在(含配置里的)。 */
  has(name) {
    return this.get(name) !== undefined;
  }

  /**
   * 加入或更新一个动态目标。
   *
   * @param {object} raw - 候选目标。
   * @returns {object} 归一后的目标。
   * @throws {Error} 试图覆盖配置里的同名目标时。
   */
  upsert(raw) {
    const n = normalizeTarget(raw, { defaults: DEFAULT_TARGET, requireName: true });
    if (this.configured.has(n.name)) {
      throw new Error(
        'target "' + n.name + '" 来自配置文件(cordis.patch.yml),不能由 App 覆盖;请改配置或换个名字',
      );
    }
    // 保留已有的观测字段,除非这次显式带了新值。
    const prev = this.dynamic.get(n.name);
    if (prev) {
      if (n.lastSeenAt == null) n.lastSeenAt = prev.lastSeenAt;
      if (n.lastError == null) n.lastError = prev.lastError;
    }
    this.dynamic.set(n.name, n);
    this.#saveState();
    return n;
  }

  /**
   * 删除一个动态目标。
   *
   * @returns {boolean} 是否真的删掉了。
   * @throws {Error} 试图删配置里的目标时。
   */
  remove(name) {
    const key = String(name ?? '');
    if (this.configured.has(key)) {
      throw new Error('target "' + key + '" 来自配置文件,不能删除');
    }
    const had = this.dynamic.delete(key);
    if (had) this.#saveState();
    return had;
  }

  /** 回写一次探测结果(不改变其它字段)。目标不存在时静默跳过。 */
  recordProbe(name, { ok, error, at } = {}) {
    const key = String(name ?? '');
    const t = this.dynamic.get(key);
    if (!t) return false;
    t.lastSeenAt = Number.isFinite(at) ? at : Date.now();
    t.lastError = ok ? null : String(error ?? 'probe failed').slice(0, 300);
    this.#saveState();
    return true;
  }
}

/** 默认的状态文件路径。 */
export function defaultStatePath(dshHome) {
  const home = dshHome == null ? process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh') : dshHome;
  return join(home, 'ssh-link', 'targets.json');
}
