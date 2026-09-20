/**
 * SSH 环境自检 —— 回答「这台机器能不能当 SSH **客户端**」。
 *
 * ## 为什么需要它
 *
 * 在加这个模块之前，缺 ssh 的**唯一症状是 `spawn('ssh')` 抛 ENOENT**：
 * 用户看到的是"连接失败"，读不出"你没装 ssh"。
 *
 * ## 这个插件**只是客户端**
 *
 * 它只往外连（把远端机器接成本机可用的能力），**不做服务端**：
 * 不检查 sshd、不管 authorized_keys、不启任何服务。所以自检只回答一个问题 ——
 * PATH 上有没有可用的 `ssh`。这一条是整个插件的**唯一前置条件**。
 *
 * 想让别的机器连进来（比如 PC 连手机），那是操作系统的事（装 OpenSSH Server、
 * 开路端口、放公钥），与本插件无关，本插件也不会替你做。
 *
 * ## 平台上没有包管理器
 *
 * 本仓库硬约束是零外部依赖，插件**从不**执行包管理器。缺 ssh 时只把该平台的
 * 安装命令**告诉**用户（下面的 PLATFORM_HINTS），由用户自己在目标机器上执行。
 *
 * @module doctor
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** 跑 `ssh -V` 的超时。读个版本号不该把自检拖死。 */
const CMD_TIMEOUT_MS = 4000;

/** 缺 ssh 客户端时给用户的安装命令。`null` 表示该平台自带，不需要装。 */
export const PLATFORM_HINTS = Object.freeze({
  termux: {
    client: 'pkg install openssh',
    note: 'Termux 的 openssh 一个包同时提供 ssh 与 sshd；本插件只用其中的 ssh。',
  },
  linux: {
    client: 'sudo apt install openssh-client',
    note: '发行版不同包管理器不同（dnf/pacman/apk…），上面是 Debian/Ubuntu 的写法。',
  },
  darwin: {
    client: null,
    note: 'macOS 自带 ssh，不需要额外安装。',
  },
  win32: {
    client: null,
    note: 'Windows 通常自带 OpenSSH Client（C:\\Windows\\System32\\OpenSSH\\ssh.exe）。',
  },
});

/** 平台未知时的兜底提示 —— 说实话，别编一条命令出来。 */
const UNKNOWN_HINT = Object.freeze({
  client: null,
  note: '未知平台：请自行安装 OpenSSH 客户端，确保 PATH 上有 ssh。',
});

export function detectPlatform(env = process.env, platform = process.platform) {
  if (env.TERMUX_VERSION || String(env.PREFIX ?? '').includes('com.termux')) return 'termux';
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'android') return 'android';
  if (platform === 'linux') return 'linux';
  return platform;
}

/**
 * 在 PATH 上找一个可执行文件，返回绝对路径或 null。
 *
 * 刻意**不 spawn** 来做存在性判断：Windows 上要靠 PATHEXT 才知道 `ssh` 其实叫
 * `ssh.exe`，而 POSIX 上 `command -v` 又需要一个 shell。直接扫 PATH 两个问题都免了，
 * 而且零依赖。
 */
export function findExecutable(name, env = process.env, platform = process.platform) {
  const rawExts = platform === 'win32'
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  // Windows 的 PATHEXT 通常是大写（.EXE），而真实文件名可能写成小写（ssh.exe）。
  // 真实 Windows 文件系统不区分大小写，所以两种都能命中；但这里顺手把两种都试一遍，
  // 免得在区分大小写的文件系统上（或被测试 mock 出来的环境里）静默找不到。
  const exts = [...new Set(rawExts.flatMap((e) => (e === '' ? [''] : [e, e.toLowerCase()])))];
  if (exts.length === 0) exts.push('');
  const dirs = String(env.PATH ?? '')
    .split(platform === 'win32' ? ';' : delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        const st = statSync(candidate);
        if (!st.isFile()) continue;
        // POSIX 上还要求真的有执行位；Windows 没有执行位这东西（PATHEXT 已经筛过
        // 扩展名），存在即可执行。**用 mode 判断而不是 accessSync(X_OK)**：Node 文档
        // 明确说 Windows 上 X_OK 不被支持，靠它会让两个平台的行为不一致 ——
        // 实测在 Windows 模拟下会把 ssh.exe 判成"找不到"。
        if (platform !== 'win32' && (st.mode & 0o111) === 0) continue;
        return candidate;
      } catch {
        // 不存在 —— 继续找下一个。
      }
    }
  }
  return null;
}

/** 取第一行，去掉两侧空白。版本号通常在这一行。 */
function firstLine(text) {
  const line = String(text ?? '').split('\n').map((s) => s.trim()).find((s) => s.length > 0);
  return line ?? null;
}

/**
 * 跑一条命令拿输出。**不 reject** —— 自检里"命令跑不起来"也是事实的一部分。
 *
 * @returns {Promise<{ok:boolean, code:number|null, out:string, err:string, enoent:boolean}>}
 */
export function runCommand(bin, args, opts = {}) {
  const { timeoutMs = CMD_TIMEOUT_MS, env = process.env } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: null, out: '', err: String(error?.message ?? error), enoent: false });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      finish({ ok: false, code: null, out, err: err || 'timeout', enoent: false });
    }, timeoutMs);
    // ENOENT 走 'error' 而不是 'close'，且**不一定**有 close 事件 —— 必须先接住它。
    child.on('error', (error) => finish({
      ok: false, code: null, out: '', err: String(error?.message ?? error),
      enoent: error?.code === 'ENOENT',
    }));
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.stderr?.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => finish({ ok: code === 0, code, out, err, enoent: false }));
  });
}

/**
 * 完整自检。**只读**：不装包、不改配置、不启服务。
 *
 * 只回答一件事：**这台机器能不能当 SSH 客户端**（PATH 上有没有 `ssh`）。
 * 服务端相关的检查（sshd 在不在听、authorized_keys 权限对不对）已经全部删掉 ——
 * 这个插件不做服务端，检查它们只会让用户去修一个与本插件无关的东西。
 *
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {string} [opts.platform]
 * @returns {Promise<object>} 结构化事实，交给 App 渲染。
 */
export async function inspectSshEnvironment(opts = {}) {
  const { env = process.env, platform = process.platform } = opts;

  const detected = detectPlatform(env, platform);
  const sshPath = findExecutable('ssh', env, platform);

  let version = null;
  if (sshPath) {
    // OpenSSH 把版本号打在 **stderr** 上（不是 stdout），所以两边都看。
    const result = await runCommand(sshPath, ['-V'], { env });
    version = firstLine(result.out) ?? firstLine(result.err);
  }

  const hints = PLATFORM_HINTS[detected] ?? UNKNOWN_HINT;
  const ok = sshPath !== null;

  return {
    platform: detected,
    // 「这个插件只是客户端」——唯一的前置条件就是这一个方向。
    // 保留 ok/description/install 这些字段名，是为了让 App 侧的渲染逻辑不用改形状。
    client: {
      ok,
      description: '本机主动连出去（ssh.exec、委派给远端 dsh）',
      sshPath,
      version,
      install: ok ? null : hints.client,
    },
    hint: hints.note,
    ready: ok,
  };
}
