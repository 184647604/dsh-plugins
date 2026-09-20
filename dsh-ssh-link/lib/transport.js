/**
 * SSH 传输层 —— 纯逻辑,不含 cordis 依赖,便于单测。
 *
 * 这一层只做一件事:**把一次远端命令跑出来,并把结果归一成
 * `{ code, signal, stdout, stderr, ms, stopReason }`**。
 *
 * 三个契约来自 `tools/probes/ssh-subagent-probe.mjs` 的实测结论(环回 3/3 通过):
 *
 *   1. **stdout 只含最终答复** —— `dsh --profile headless "<prompt>"` 把答案写
 *      stdout、把思考写 stderr。两者必须分开接,混在一起结果就被思考污染了。
 *   2. **cwd 走 `cd`,不走 ssh 的 cwd** —— ssh 没有「在远端某个目录启动」的选项,
 *      只有 `cd X && cmd` 这一条路。
 *   3. **abort 杀掉本地 ssh 即可** —— 远端 headless 会随通道关闭一起退出,实测无孤儿。
 *
 * 第 2 条里 prompt 的转义是**安全边界**:它要穿过一层远端 shell。用单引号包裹 +
 * 把内部单引号转成 `'\''`,这是 POSIX shell 里唯一安全的嵌套方式(见 quoteShell)。
 *
 * @module dsh-ssh-link/transport
 */

import { spawn } from 'node:child_process';

/**
 * 目标字段的**默认值来源** —— 注意它不是一个"默认的那台机器"。
 *
 * [name]/[host] 在这里只作占位：真正加目标时 host 是必填的
 * （见 registry.js 的 normalizeTarget，缺 host 直接抛错），所以永远不会有
 * "用户没写主机名，插件就悄悄去连本机环回"这种事。真正被取用的只有
 * port / user / dsh / profile 这几个可以放心缺省的字段。
 */
export const DEFAULT_TARGET = {
  name: 'localhost',
  host: '127.0.0.1',
  port: 8022,
  user: '',
  /** 远端 dsh 的可执行文件。PATH 里有就直接写 dsh。 */
  dsh: 'dsh',
  /** 远端 profile 名,`dsh --profile <name>`。 */
  profile: 'headless',
};

/**
 * 把任意字符串安全地包成**一个** POSIX shell 词。
 *
 * 这是整个插件唯一的安全边界:prompt / cwd / 命令都要穿过远端 shell。
 * 规则来自 POSIX:单引号内除 `'` 外一切字面;`'` 只能靠「收尾 + 转义 + 重开」表达。
 *
 * **不要**图省事改成双引号 —— 双引号里 `$`、反引号、`\` 仍会被解释,命令注入。
 *
 * @param {string} s - 任意字符串(可含换行、引号、$、反引号)。
 * @returns {string} 可安全拼进 shell 命令行的词。
 */
export function quoteShell(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * ssh 连接参数。
 *
 * `BatchMode=yes` + `PreferredAuthentications=publickey` 是刻意的:**不做交互**。
 * 没有可用公钥时立刻失败,而不是挂在那里等一个永远不会来的密码提示 ——
 * 插件跑在无人值守的后端进程里,任何交互都等于卡死。
 *
 * `StrictHostKeyChecking=accept-new` 而不是 `no`:首次连接自动接受(否则新机器
 * 用不了),但**主机密钥变了要报错** —— 那正是中间人攻击的指纹,不能静默放过。
 *
 * @param {object} target - 见 DEFAULT_TARGET。
 * @returns {string[]} ssh 参数(不含目标与远端命令)。
 */
export function sshBaseArgs(target) {
  return [
    '-p', String(target.port),
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    // 长命令(含大 prompt)要经 stdin 传输,不设上限会被 ssh 的默认通道行为坑到。
    '-o', 'ServerAliveInterval=30',
  ];
}

/** `user@host`,user 为空时只给 host。 */
export function sshTargetSpec(target) {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

/**
 * 拼出**参数化**的远端命令行:`cd <cwd> && <argv0> <argv1> ...`。
 *
 * 每个参数各自 quoteShell —— 拼接符(`&&`、空格)留在引号外,才是真正的「多个词」。
 *
 * ## 什么时候用它,什么时候用 remoteScript
 *
 * 这两种是**不同的语义**,混用会出真 bug(我第一版就是混的,把整条命令包成了
 * 一个词,远端报 "No such file or directory"):
 *
 * - **remoteCommand**:参数是**数据**。典型是 subagent —— `dsh --profile headless
 *   "<用户提示词>"`,`<用户提示词>` 里可能有引号、`/**
 * SSH 传输层 —— 纯逻辑,不含 cordis 依赖,便于单测。
 *
 * 这一层只做一件事:**把一次远端命令跑出来,并把结果归一成
 * `{ code, signal, stdout, stderr, ms, stopReason }`**。
 *
 * 三个契约来自 `tools/probes/ssh-subagent-probe.mjs` 的实测结论(环回 3/3 通过):
 *
 *   1. **stdout 只含最终答复** —— `dsh --profile headless "<prompt>"` 把答案写
 *      stdout、把思考写 stderr。两者必须分开接,混在一起结果就被思考污染了。
 *   2. **cwd 走 `cd`,不走 ssh 的 cwd** —— ssh 没有「在远端某个目录启动」的选项,
 *      只有 `cd X && cmd` 这一条路。
 *   3. **abort 杀掉本地 ssh 即可** —— 远端 headless 会随通道关闭一起退出,实测无孤儿。
 *
 * 第 2 条里 prompt 的转义是**安全边界**:它要穿过一层远端 shell。用单引号包裹 +
 * 把内部单引号转成 `'\''`,这是 POSIX shell 里唯一安全的嵌套方式(见 quoteShell)。
 *
 * @module dsh-ssh-link/transport
 */

/**
 * 拼出**脚本体**的远端命令行:`cd <cwd> && <script>`。
 *
 * `script` 被**原样**交给远端登录 shell 解释 —— 它本身就是 shell 代码,
 * 绝不能被 quoteShell 包起来(包了就是一个词,shell 会去找同名文件)。
 *
 * **cwd 仍然转义**:它是路径数据,不是代码。这是刻意的区分 ——
 * 同一层里,数据转义、代码不转义。
 *
 * 注意这里**不套 `sh -c`**:ssh 的语义就是「把这条命令行交给远端登录 shell」,
 * 而 Termux 上 `/bin/sh` 是 Android 的 mksh(PATH 不含 $PREFIX/bin),
 * 套一层会让 `node`/`dsh`/`npm` 全都找不到。
 *
 * @param {string|undefined} cwd - 远端工作目录;空则不加 cd。
 * @param {string} script - shell 代码,原样执行。
 * @returns {string} 一条可交给远端 shell 的命令行。
 */
export function remoteScript(cwd, script) {
  const body = String(script);
  return cwd ? `cd ${quoteShell(cwd)} && ${body}` : body;
}

export function remoteCommand(cwd, argv) {
  const parts = argv.map(quoteShell);
  const cmd = parts.join(' ');
  return cwd ? `cd ${quoteShell(cwd)} && ${cmd}` : cmd;
}
/**
 * 跑一次远端命令,把结果归一。
 *
 * **不 reject**:所有失败都通过返回值的 `stopReason` 表达。这是刻意的 ——
 * 上层(subagent provider 与 tool)对「远端命令失败」的处理是把它当成一次
 * 可解释的结果,而不是异常。只有 spawn 本身失败才走 `error`。
 *
 * @param {object} opts
 * @param {object} opts.target - ssh 目标。
 * @param {string[]} [opts.argv] - 远端命令参数(数据语义,逐个转义)。与 opts.script 二选一。
 * @param {string} [opts.script] - 远端 shell 代码(原样执行)。与 opts.argv 二选一。
 * @param {string} [opts.cwd] - 远端工作目录。
 * @param {number} [opts.timeoutMs] - 超时;到点杀本地 ssh。
 * @param {AbortSignal} [opts.signal] - 取消信号;到点杀本地 ssh。
 * @param {number} [opts.maxBytes] - stdout/stderr 各自的上限,超出截断并标记。
 * @returns {Promise<{code:number|null,signal:string|null,stdout:string,stderr:string,ms:number,stopReason:string,truncated:boolean}>}
 */
export function runRemote(opts) {
  const {
    target,
    argv,
    script,
    cwd,
    timeoutMs = 150_000,
    signal,
    maxBytes = 1_000_000,
  } = opts;

  // 二选一,且必须选一个 —— 两种语义不能混(见 remoteCommand / remoteScript 的注释)。
  if ((argv === undefined) === (script === undefined)) {
    throw new TypeError('runRemote 需要 argv(数据语义)或 script(代码语义)其中之一,不能都给或都不给');
  }
  const remoteCmd = script !== undefined ? remoteScript(cwd, script) : remoteCommand(cwd, argv);

  return new Promise((resolve) => {
    const started = Date.now();
    const spec = [...sshBaseArgs(target), sshTargetSpec(target), remoteCmd];

    let child;
    try {
      child = spawn('ssh', spec, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({
        code: null, signal: null, stdout: '', stderr: String(e?.message ?? e),
        ms: Date.now() - started, stopReason: 'error', truncated: false,
      });
      return;
    }

    let out = '';
    let err = '';
    let truncated = false;
    const cap = (cur, d) => {
      if (cur.length >= maxBytes) { truncated = true; return cur; }
      const next = cur + d;
      if (next.length > maxBytes) { truncated = true; return next.slice(0, maxBytes); }
      return next;
    };

    child.stdout.on('data', (d) => { out = cap(out, String(d)); });
    child.stderr.on('data', (d) => { err = cap(err, String(d)); });

    let settled = false;
    let killer = null;
    let onAbort = null;

    const finish = (stopReason) => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: child.exitCode,
        signal: child.signalCode,
        stdout: out,
        stderr: err,
        ms: Date.now() - started,
        stopReason,
        truncated,
      });
    };

    // 超时 = abort:杀本地 ssh,远端随通道关闭退出(探针实测无孤儿)。
    killer = setTimeout(() => {
      child.kill('SIGTERM');
      finish('aborted');
    }, timeoutMs);
    // 不阻止进程退出:这是后台的看门狗,不该让 node 挂着不走。
    if (typeof killer.unref === 'function') killer.unref();

    if (signal) {
      if (signal.aborted) {
        child.kill('SIGTERM');
        finish('aborted');
        return;
      }
      onAbort = () => {
        child.kill('SIGTERM');
        finish('aborted');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e) => { err = err || String(e?.message ?? e); finish('error'); });
    child.on('close', (code, sig) => {
      // 已有结论(超时/取消)时不覆盖 —— 那两种情况下 close 也会到,而且 code 常是 null。
      if (settled) return;
      finish(code === 0 ? 'completed' : sig ? 'aborted' : 'error');
    });
  });
}
