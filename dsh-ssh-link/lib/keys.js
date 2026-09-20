/**
 * 公钥解析 —— 把 `id_ed25519.pub` 这类文件读成结构化结果。
 *
 * ## 为什么还在
 *
 * 本插件现在**只是客户端**：它不再往任何 `authorized_keys` 里写东西
 * （那是服务端行为，已删）。这里留下的是**读**公钥所需的部分 ——
 * 本机身份（`identity.js`）用它把「我这份公钥是什么、指纹多少」报给 App，
 * 用户拿它去目标机器的 authorized_keys 里放一次。
 *
 * ## 解析仍然要严
 *
 * 即使只是为了**显示**，解析也用同一套严格白名单，因为
 * 1. 这份公钥最终会被用户复制到某台机器的认证配置里，解析错了会误导人；
 * 2. 对同一段文本，宽松解析与严格解析给出不同结论本身就是隐患。
 *
 * 拒绝规则见下面的 ALLOWED_KEY_TYPES 与 parsePublicKey 的注释。
 *
 * @module dsh-ssh-link/keys
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * 允许解析的密钥类型白名单。
 *
 * 这是拒绝 options 行的**机制**(见模块注释第 1 条),不是"顺手列几个"。
 * 增删这项都要先想清楚:每加一个类型,就多一种能被对端写进来的密钥形态。
 */
export const ALLOWED_KEY_TYPES = Object.freeze([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

const ALLOWED = new Set(ALLOWED_KEY_TYPES);

/** 公钥行的长度上限。真实密钥最长也就几百字符,给足余量但不留滥用空间。 */
const MAX_LINE = 8192;
/** comment 截断长度 —— 只用于显示,不参与认证。 */
const MAX_COMMENT = 200;

/** 控制字符(含 \n \r \t \0)。任何一个出现就拒。 */
const CONTROL = /[\u0000-\u001f\u007f]/;
/**
 * 同上的**全局**版本,专供 `replace` 用。
 *
 * 不能拿 [CONTROL] 去做 replace:它没有 `g` 标志,一次只替换第一处 ——
 * 那是一个静默的过滤不干净(真被测试抓到过)。
 */
const CONTROL_G = /[\u0000-\u001f\u007f]/g;

/**
 * 严格 base64 校验。
 *
 * 不用 `Buffer.from(s,'base64')` 的宽松解码做校验 —— 它会**静默丢弃**非法字符
 * (`Buffer.from('!!!','base64')` 得到空 buffer 而不报错),拿它当验证器等于没验。
 * 所以这里先用正则确认字符集与填充,再解码。
 */
function isStrictBase64(s) {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  const pad = s.length - s.replace(/=+$/, '').length;
  return pad <= 2;
}

/**
 * 把一个字符串解析成结构化公钥,非法则抛错。
 *
 * @param {unknown} line - 候选公钥行。
 * @returns {{type:string, blob:string, comment:string, canonical:string, fingerprint:string}}
 *   `canonical` 是去掉 comment 的规范化形式(去重键),`fingerprint` 是
 *   `SHA256:<base64>` 形状的指纹(与 `ssh-keygen -lf` 一致)。
 * @throws {TypeError} 任何不合规输入。错误信息里**不回显**原始输入 ——
 *   它可能来自网络,不该被反射回日志/界面。
 */
export function parsePublicKey(line) {
  if (typeof line !== 'string') throw new TypeError('public key must be a string');
  const raw = line.trim();
  if (raw.length === 0) throw new TypeError('public key is empty');
  if (raw.length > MAX_LINE) throw new TypeError('public key is too long');
  if (CONTROL.test(raw)) throw new TypeError('public key contains control characters');

  const fields = raw.split(/\s+/);
  if (fields.length < 2) throw new TypeError('public key needs a type and a base64 body');

  const type = fields[0];
  const blob = fields[1];
  const comment = fields.slice(2).join(' ');

  if (!ALLOWED.has(type)) {
    throw new TypeError(
      'unsupported public key type (options-prefixed lines are rejected): ' + type.slice(0, 32),
    );
  }
  if (!isStrictBase64(blob)) throw new TypeError('public key body is not valid base64');
  if (comment.length > 0 && CONTROL.test(comment)) {
    throw new TypeError('public key comment contains control characters');
  }

  const decoded = Buffer.from(blob, 'base64');
  if (decoded.length < 4) throw new TypeError('public key body is truncated');
  const innerLen = decoded.readUInt32BE(0);
  if (innerLen <= 0 || innerLen > decoded.length - 4) {
    throw new TypeError('public key body has an invalid length prefix');
  }
  const innerType = decoded.subarray(4, 4 + innerLen).toString('utf8');
  if (innerType !== type) {
    throw new TypeError(
      'public key type mismatch: declared ' + type + ', body says ' + innerType.slice(0, 32),
    );
  }

  const fingerprint =
    'SHA256:' + createHash('sha256').update(decoded).digest('base64').replace(/=+$/, '');

  return {
    type,
    blob,
    comment: comment.slice(0, MAX_COMMENT),
    canonical: type + ' ' + blob,
    fingerprint,
  };
}

/** 宽松版:解析失败返回 null 而不抛错。给「扫描文件里已有的行」用。 */
export function tryParsePublicKey(line) {
  try {
    return parsePublicKey(line);
  } catch {
    return null;
  }
}

/**
 * 读一个公钥文件(`id_ed25519.pub`),返回结构化结果或 null。
 *
 * 文件不存在/不可读/内容非法都返回 null —— 调用方(本机身份)要能容忍
 * 「还没生成密钥」这种正常状态,而不是让插件加载失败。
 */
export function readPublicKeyFile(path) {
  try {
    if (!existsSync(path)) return null;
    return tryParsePublicKey(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
