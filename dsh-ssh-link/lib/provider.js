/**
 * SSH subagent provider —— 把远端 `dsh --profile headless` 当子代理跑。
 *
 * ## 为什么是「远端一次性 run」而不是别的
 *
 * dsh 的 `SubagentProvider.start()` 要返回 `{ id, localAgent, result, dispose }`,
 * 其中 `localAgent` 对**远端** run 必须是 `undefined`(契约明写:"a remote provider
 * mints an id unique in the parent namespace")。也就是说这条链路天然就是
 * 「本进程不持有子 Agent,只拿一个结果」—— 正好是 `dsh ... headless "<prompt>"`
 * 的形状:一问一答,答案在 stdout。
 *
 * ## capabilities 为什么全 false
 *
 * `request` 里那些启动选项(`agentOptions` / `outputSchema` / `maxDepth` /
 * `toolFilter` / `persona`)都需要**在子 Agent 创建窗口内**做作用域操作。远端
 * headless 是另一个进程、另一套组合,本进程够不着 —— 声称支持然后忽略,就违反了
 * 框架的 "fail loud, no silent degradation"。所以能力位全 false,请求里带了这些
 * 选项的调用方会**在 start 之前**被框架拒掉,而不是被静默降级。
 *
 * `inheritsParentContext: false`:远端看不到父会话的历史(它连父会话都不知道)。
 * 这也是 dsh 给模型写话术时用的字段,必须如实 —— 说 true 会让模型以为子代理
 * 知道上下文。
 *
 * ## 与探针的关系
 *
 * `tools/probes/ssh-subagent-probe.mjs` 先验证了这条链路的三条契约(stdout 干净、
 * cwd 透传、abort 无孤儿),这里是把验证过的形状搬进插件。探针仍是这套逻辑的
 * 回归入口(它在环回上跑,不需要第二台机器)。
 *
 * @module dsh-ssh-link/provider
 */

import { randomUUID } from 'node:crypto';
import { runRemote } from './transport.js';

/** 远端后端不支持任何启动期作用域能力 —— 见模块注释。 */
export const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
});

/**
 * 把 `ContentBlock[]` 压成一段纯文本。
 *
 * `SubagentStartRequest.prompt` 是内容块数组(可能含图片)。远端 headless 只吃
 * 一个字符串参数,所以这里做**有损**转换 —— 但绝不静默:遇到非文本块时在结果里
 * 留一条说明,让调用方知道有内容没传过去。
 *
 * @param {Array<{type:string,text?:string}>} blocks - 请求里的内容块。
 * @returns {{text:string, dropped:number}} 文本与被丢弃的非文本块数。
 */
export function promptToText(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const texts = [];
  let dropped = 0;
  for (const b of list) {
    if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else dropped++;
  }
  return { text: texts.join('\n\n'), dropped };
}

/**
 * 远端 run 的 id。
 *
 * 契约要求:远端 provider 铸一个**在父命名空间里唯一**的 id。用带前缀的随机 uuid ——
 * 前缀让它在日志里一眼可辨(不会和本地 session id 混淆),uuid 保证唯一。
 *
 * 不用 sessionId 之类需要远端配合的东西:远端 headless 是独立 profile,
 * 它自己的会话 id 与本进程的命名空间无关,拿过来会撞。
 *
 * @returns {{ id: string, raw: string }}
 */
export function mintRemoteRunId() {
  const raw = randomUUID();
  return { id: `ssh:${raw}`, raw };
}

/**
 * 构造一个 SSH subagent provider。
 *
 * @param {object} opts
 * @param {string} opts.name - 注册名(模型工具那一行 `provider:` 要写这个)。
 * @param {object} opts.target - ssh 目标,见 transport.js 的 DEFAULT_TARGET。
 * @param {number} opts.timeoutMs - 单次 delegate 的超时。
 * @returns {object} 满足 `SubagentProvider` 契约的对象。
 */
export function createSshProvider({ name, target, timeoutMs = 600_000 }) {
  /** 活着的 run,用于 dispose 与统一收尾。 */
  const live = new Map();

  return {
    name,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,

    /**
     * 起一次远端 delegate。
     *
     * **这里不 await 结果** —— 契约要求 start() 在「run 已发布」后就返回,
     * 结果通过 `run.result` 结算。所以先把 handle 造出来,再让 result 去等命令。
     *
     * @param {object} request - `ResolvedSubagentStartRequest`。
     * @returns {Promise<object>} `SubagentRun`。
     */
    async start(request) {
      // 注册 provider 不要求此刻就有目标（默认配置就是 targets: []），
      // 但真的委派时必须说清楚 —— 否则用户看到的是一句
      // `Cannot read properties of undefined (reading 'dsh')`。
      if (!target) {
        throw new Error(
          `ssh-link: provider "${name}" 还没有目标机器 —— 先在 App 侧边栏「SSH 连接」` +
          '面板里加一台，或在插件配置的 targets 里写一条。',
        );
      }
      const { id } = mintRemoteRunId();
      const { text, dropped } = promptToText(request.prompt);

      // cwd 从父 Agent 取。AT ACP 之类只读 cwd;这里也一样 —— 不猜、不编,
      // 拿不到就不加 cd(远端用它自己的默认目录)。
      const cwd = typeof request.parent?.cwd === 'string' ? request.parent.cwd : undefined;

      const controller = new AbortController();
      // 把调用方的 signal 与本地 controller 熔在一起:调用方取消要能杀掉远端,
      // 而 dispose() 也要能。两者任一触发都算取消。
      const onCallerAbort = () => controller.abort();
      if (request.signal) {
        if (request.signal.aborted) controller.abort();
        else request.signal.addEventListener('abort', onCallerAbort, { once: true });
      }

      const run = {
        id,
        localAgent: undefined,
        result: null,
        dispose: null,
      };

      const settle = async () => {
        const r = await runRemote({
          target,
          argv: [target.dsh, '--profile', target.profile, text],
          cwd,
          timeoutMs,
          signal: controller.signal,
        });

        const output = [];
        if (r.stdout.length > 0) output.push({ type: 'text', text: r.stdout.replace(/\n$/, '') });

        // 被丢弃的非文本块要**显式说出来**,不能让调用方以为内容都传到了。
        if (dropped > 0) {
          output.push({
            type: 'text',
            text: `[ssh-link: ${dropped} 个非文本内容块未传给远端 —— 远端 headless 只接受纯文本提示词]`,
          });
        }

        return {
          output,
          diagnostic: buildDiagnostic(r, cwd, target),
          stopReason: r.stopReason,
        };
      };

      run.result = settle();
      run.dispose = async () => {
        controller.abort();
        if (request.signal) request.signal.removeEventListener('abort', onCallerAbort);
        live.delete(id);
        // 等 result 结算,保证 dispose 返回后远端确实没了(契约要求「达到静止」)。
        try { await run.result; } catch { /* 结算失败也要让 dispose 成功 */ }
      };

      live.set(id, run);
      return run;
    },

    /** 进程收尾:把所有还活着的 run 掐掉。 */
    async drain() {
      const all = [...live.values()];
      await Promise.allSettled(all.map((r) => r.dispose()));
    },
  };
}

/**
 * 失败的诊断文本。
 *
 * 契约对 `diagnostic` 有明确约束:**不得包含工具输入、文件内容、环境变量、凭据、
 * 原始协议载荷**,且不超过 4096 UTF-8 字节。所以这里只给「为什么失败」的形状,
 * 不回灌 stderr 全文(它可能含远端路径、token 之类)。
 *
 * @param {object} r - runRemote 的返回。
 * @param {string|undefined} cwd - 远端工作目录。
 * @param {object} target - ssh 目标。
 * @returns {string|undefined} 完成时 undefined。
 */
function buildDiagnostic(r, cwd, target) {
  if (r.stopReason === 'completed') return undefined;

  const where = `${target.user ? target.user + '@' : ''}${target.host}:${target.port}`;
  const head = `ssh 远端 delegate 未完成 (${r.stopReason}), 目标 ${where}${cwd ? `, cwd ${cwd}` : ''}`;

  if (r.stopReason === 'aborted') return `${head}: 已取消或超时`;

  // stderr 只给**首行**且截断 —— 足够定位(通常是 ssh 或 dsh 的一句话),
  // 又不会把远端整段输出带进来。这是 diagnostic 长度与信息量的折中。
  const firstLine = String(r.stderr || '').split('\n').find((l) => l.trim().length > 0) ?? '';
  const brief = firstLine.slice(0, 300);
  const code = r.code === null ? 'null' : String(r.code);
  return brief ? `${head}: exit=${code}, ${brief}` : `${head}: exit=${code}`;
}
