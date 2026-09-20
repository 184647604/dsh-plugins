/**
 * 本机 SSH **客户端**身份 —— 「我的公钥是什么」。
 *
 * ## 只有出站方向
 *
 * 这个插件只往外连。所以这里只回答一件事:**本机拿哪把密钥去连别人**。
 * 以前还报 `host`/`sshPort`/`addresses`（"别人从哪连到我"）与
 * `authorizedKeysPath` —— 那些都是服务端才关心的，已经删掉。
 *
 * ## 公钥为什么不是自动生成的
 *
 * 这里**只读不生成**。生成密钥是一个有副作用的动作(改用户 `~/.ssh`),
 * 不该在"读一下身份"这种幂等查询的路径上发生;更不该在插件加载时悄悄发生。
 * 密钥缺失时如实报 `publicKey: null`,让 App 显示"这台机器还没配 SSH 密钥"
 * 并给出操作入口 —— 比替用户做决定好。
 *
 * 生成入口在路由层(`ssh.identity.generate`),是一个**显式**的用户动作。
 *
 * @module dsh-ssh-link/identity
 */

import { existsSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { readPublicKeyFile } from './keys.js';

/**
 * 候选私钥文件名,按优先级排列。
 *
 * 顺序有讲究:ed25519 优先(现代、短、快),rsa 兜底(老机器的 `id_rsa`)。
 * 取第一个存在的**且**有对应 `.pub` 的。
 */
const KEY_CANDIDATES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

/** 本机 SSH 目录。 */
export function sshDir(home) {
  return join(home == null ? process.env.HOME ?? '.' : home, '.ssh');
}

/**
 * 读出本机的 SSH **客户端**身份。
 *
 * 只报两件事：私钥在哪（`keyPath`）、它对应的公钥是什么（`publicKey`/`fingerprint`）。
 * 用户拿这份公钥去目标机器（比如 PC）的 `authorized_keys` 里放一次，之后就能免密连过去。
 *
 * @param {object} [opts]
 * @param {string} [opts.home] - HOME 覆盖(测试用)。
 * @returns {{user:string,publicKey:object|null,keyPath:string|null,fingerprint:string|null}}
 */
export function readIdentity(opts = {}) {
  const home = opts.home ?? process.env.HOME;
  const dir = sshDir(home);

  let keyPath = null;
  let publicKey = null;
  for (const name of KEY_CANDIDATES) {
    const pub = readPublicKeyFile(join(dir, name + '.pub'));
    if (pub) {
      keyPath = join(dir, name);
      publicKey = pub;
      break;
    }
  }

  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = '';
  }

  return {
    user,
    publicKey: publicKey
      ? { type: publicKey.type, canonical: publicKey.canonical, fingerprint: publicKey.fingerprint }
      : null,
    keyPath,
    fingerprint: publicKey ? publicKey.fingerprint : null,
  };
}

/**
 * 生成一对 SSH 密钥(**显式动作**,只由路由触发)。
 *
 * 用 `ssh-keygen` 而不是纯 JS 实现:零依赖是本仓库的硬约束,而 `ssh-keygen`
 * 在 Termux/Windows/Linux 上都有(它是 OpenSSH 的一部分,而本插件本来就依赖
 * `ssh` 客户端)。参数与 OpenSSH 的默认一致:`-t ed25519 -N ''`(无口令 ——
 * 无人值守的后端进程没法输入口令,有口令的密钥在这里等于不可用)。
 *
 * @param {object} opts
 * @param {string} [opts.home] - HOME 覆盖。
 * @param {string} [opts.comment] - 写进公钥的注释。
 * @returns {Promise<{ok:boolean,keyPath:string|null,fingerprint:string|null,error:string|null,existed:boolean}>}
 */
export function generateKey(opts = {}) {
  const home = opts.home ?? process.env.HOME;
  const dir = sshDir(home);
  const keyPath = join(dir, 'id_ed25519');
  const comment = opts.comment ?? 'dsh-ssh-link';

  // 已存在就直接返回 —— 这是幂等动作,重复调用不该覆盖已有密钥
  // (覆盖 = 让所有已配对的对端失效,那是破坏性的)。
  if (existsSync(keyPath) && existsSync(keyPath + '.pub')) {
    const pub = readPublicKeyFile(keyPath + '.pub');
    return Promise.resolve({
      ok: true,
      keyPath,
      fingerprint: pub ? pub.fingerprint : null,
      error: null,
      existed: true,
    });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        ok: false,
        keyPath: null,
        fingerprint: null,
        error: String(e?.message ?? e),
        existed: false,
      });
      return;
    }
    let err = '';
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => {
      resolve({
        ok: false,
        keyPath: null,
        fingerprint: null,
        error: String(e?.message ?? e),
        existed: false,
      });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          keyPath: null,
          fingerprint: null,
          error: err.trim().slice(0, 300) || 'ssh-keygen exited ' + code,
          existed: false,
        });
        return;
      }
      const pub = readPublicKeyFile(keyPath + '.pub');
      resolve({
        ok: true,
        keyPath,
        fingerprint: pub ? pub.fingerprint : null,
        error: null,
        existed: false,
      });
    });
  });
}

/** 列出 `~/.ssh` 下看起来像私钥的文件名(诊断用)。 */
export function listKeyFiles(home) {
  try {
    return readdirSync(sshDir(home)).filter((f) => !f.endsWith('.pub'));
  } catch {
    return [];
  }
}
