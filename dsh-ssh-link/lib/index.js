/**
 * dsh-ssh-link —— 用 SSH 把远端机器接成本机可用的能力。
 *
 * ## 它提供三样东西
 *
 * 1. **`ssh_exec` 工具** —— 模型直接跑任意远端命令。这是「像 ssh 那样操作那台
 *    机器」的字面实现,不经过 agent、不烧 token。
 * 2. **subagent provider(`ssh`)** —— 注册到 `ctx.subagents`。配合 preset 里一行
 *    `dsh-tool-subagent`(provider: ssh),模型就多出一个 `subagent_ssh` 委派工具,
 *    每次调用 = 在远端起一个 `dsh --profile headless` 干活。
 * 3. **`/api/ssh.*` 路由** —— 给手机 App 用:列出/测试目标、直接跑命令。
 *
 * ## 认证:走 `connection.fetch.register`,不自己挂路由
 *
 * 这里刻意**不用** `webServer.register({kind:'exact'})`。本仓库在 2026-09 刚出过
 * 一次事故:exact 路由先于 client-connection 的 `kind:'prefix'` `/api` 路由匹配,
 * 而认证恰恰挂在后者 handler 的第一行 —— 于是插件路由全部裸奔(未授权就能装插件、
 * 读 supervisor token)。
 *
 * `ctx.connection.fetch.register()` 注册的路由**在已认证的共享 handler 内部**,
 * 认证由 connection 服务统一做。所以这个插件在结构上就不可能重现那个洞 ——
 * 不依赖「记得在 gate 里调用 requestRejection」这种约定。
 *
 * ## 目标从哪来
 *
 * `dsh.profile` 配置里的 `targets` 列表(见 cordis.patch.yml)。**不读 hosts.json**:
 * 那是 App 的产物,格式与生命周期都不归后端管;后端要的是自己的配置。
 *
 * ## 为什么不用 `defineTool`
 *
 * `@deepseek-ai/dsh-tools` 的 `defineTool` 会把「简写参数描述」编译成 JSON Schema
 * 并顺带做参数校验,但它**解析不到**:插件是 `npm pack` 成 tgz 装进
 * `~/.dsh/profiles/<p>/node_modules/` 的,而 `@deepseek-ai/*` 不在那个解析路径上
 * (本机实测:dsh-tools 不在 profile 的 node_modules 里)。官方子插件靠
 * `peerDependencies` 由宿主提供,那适用于随 dsh 分发的插件,不适用于外部 tgz。
 *
 * 而 `tools.register` 要的 `parameters` 本来就是**标准 JSON Schema**
 * (`ToolSchema.parameters: Record<string, unknown>`),所以直接写 JSON Schema 即可,
 * 零依赖 —— 与本仓库另外三个插件一致(它们全部零外部依赖,这是可移植性的前提)。
 *
 * @module dsh-ssh-link
 */

import { DEFAULT_TARGET, runRemote } from './transport.js';
import { inspectSshEnvironment } from './doctor.js';
import { createSshProvider } from './provider.js';
import { TargetRegistry, defaultStatePath } from './registry.js';
import {
  generateKey,
  readIdentity,
} from './identity.js';
export const name = 'ssh-link';

/**
 * 硬依赖：**只有**工具与 subagent 注册表。
 *
 * 这两个在 headless 与 web 两种 profile 里都有,所以插件在两种环境下都能挂载 ——
 * 核心能力(`ssh_exec` 工具 + subagent provider)不依赖 web server。
 *
 * `connection` / `webServer` **刻意不写在这里**:它们是 HTTP 路由才需要的,
 * 而 headless profile 里没有 web server。写成硬依赖的后果是真 loader 实测到的 ——
 * 整个 dsh 起不来:
 *
 *     dsh: plugin tree failed to load: 1 entry did not activate
 *     dsh-ssh-link: pending (waiting for services: webServer, connection)
 *
 * 正确做法是照官方 `dsh-api-gateway` 的写法:用 `ctx.inject([...], cb)` 建一个
 * **子 fiber** —— 它单独等服务,服务到位就挂路由,不到位就跳过,而**不阻塞父级**。
 * 见下面 apply() 里注册 HTTP 路由那一段。
 */
export const inject = ['tools', 'subagents'];

/**
 * 从模块/设备名折算出合法的目标名。
 *
 * 对端在 hosts.json 里的名字是**显示名**,可能含空格、中文、斜杠 —— 而目标名
 * 是路由与工具的寻址键,字符集受限。所以这里做保守折算,并把空结果兜成 "peer"
 * (由 registry 的重名检查负责报冲突,而不是在这里静默加后缀)。
 *
 * @param {string} name - 候选名字。
 * @returns {string} 合法的目标名。
 */
function sanitizeTargetName(name) {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  // NAME_RE 要求首字符是字母或数字。
  const lead = cleaned.replace(/^[^A-Za-z0-9]+/, '');
  return lead.length > 0 ? lead : 'peer';
}

/** 路由前缀。用 `/api/ssh.*` 与另外三个插件的 `/api/<domain>.<verb>` 风格一致。 */
const ROUTE_PREFIX = '/api/ssh.';

/** 单次远端命令的默认超时。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** agent 委派(远端跑一个完整 headless)要宽松得多。 */
const DEFAULT_DELEGATE_TIMEOUT_MS = 600_000;
/** 输出上限,防止一条 `yes` 把内存打满。 */
const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * 归一配置:把用户写的 target 补全成完整形状。
 *
 * 宽松是有意的 —— 配置里通常只写 `host`(其余用默认),不该逼用户把
 * port/user/dsh/profile 全抄一遍。
 *
 * @param {object} raw - 配置里的一项。
 * @returns {object} 补全后的 target。
 */
function normalizeTarget(raw) {
  const base = { ...DEFAULT_TARGET };
  const merged = { ...base, ...raw };
  // name 是工具/路由里寻址用的键,必须有;没给就用 host。
  if (!merged.name) merged.name = String(merged.host);
  merged.port = Number(merged.port) || base.port;
  merged.user = merged.user ?? '';
  merged.dsh = merged.dsh ?? base.dsh;
  merged.profile = merged.profile ?? base.profile;
  return merged;
}

/**
 * 插件主体。
 *
 * @param {object} ctx - host 组合里的 cordis context。
 * @param {object} config - cordis.patch.yml 里这一行的 config。
 */
export function apply(ctx, config) {
  // 没配 targets 就是**真的没有目标** —— 以前这里会凭空补一个 127.0.0.1:8022,
   // 那是"本机自己跑着 sshd"时代的默认。本插件是纯客户端，环回目标等于让自己
   // 去连自己，几乎不可能成功，只会让面板上多一条假机器。目标和默认值都由
   // App 的「SSH 连接」面板写入（走 ssh.targets.add）。
  const configured = Array.isArray(config?.targets) && config.targets.length > 0
    ? config.targets.map(normalizeTarget)
    : [];

  /**
   * 目标注册表 = 配置里的(只读,优先) + 运行时的(可增删,落盘)。
   *
   * 原先这里是个裸 Map,目标只能来自配置 —— 用户想在 App 里换一台机器就得改
   * YAML 再重启后端。注册表把「用户选的目标」落盘,插件重启后还在。
   */
  const registry = new TargetRegistry({
    configured,
    statePath: config?.statePath ?? defaultStatePath(config?.dshHome),
  });

  /** 本机 SSH 坐标 —— 自动配对时对端要知道往哪连我。 */
  const identityOpts = {
    home: config?.home,
  };

  /**
   * 默认目标是**惰性**解析的，不是启动时算一次的常量。
   *
   * 原因：目标有两个来源，而**动态目标**（App 面板里加的）是在 apply 之后才写进
   * 注册表的。启动时固化的那份永远看不到它们 —— 用户加完机器，`ssh.exec` 不带
   * target 仍然会说"没有默认目标"，看起来像没保存成功。
   *
   * 顺序：显式配置的 defaultTarget → 第一条配置目标 → 第一条动态目标 → 没有。
   */
  const defaultTargetName = () => {
    if (typeof config?.defaultTarget === 'string' && registry.has(config.defaultTarget)) {
      return config.defaultTarget;
    }
    const all = registry.list();
    return all.length > 0 ? all[0].name : undefined;
  };

  // 守卫：providerName 与某个非默认 target 同名时，两次 registerProvider 会撞
  // DUPLICATE_PROVIDER。那个错误对用户不够直白，提前说清楚。
  const providerName = config?.providerName ?? 'ssh';
  for (const t of configured) {
    if (t.name === providerName && t.name !== defaultTargetName()) {
      throw new Error(
        `ssh-link: target 名 "${t.name}" 与 providerName 冲突 —— ` +
        `非默认 target 会以 target 名注册 provider。请改 target 名或 providerName。`,
      );
    }
  }

  const execTimeoutMs = Number(config?.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const delegateTimeoutMs = Number(config?.delegateTimeoutMs) || DEFAULT_DELEGATE_TIMEOUT_MS;
  const maxBytes = Number(config?.maxBytes) || DEFAULT_MAX_BYTES;

  /** 解析一个 target 名;不传就用默认。名字错了要显式报错,不静默回落。 */
  const pick = (nameArg) => {
    if (nameArg === undefined || nameArg === null || nameArg === '') {
      const name = defaultTargetName();
      const d = name === undefined ? undefined : registry.get(name);
      if (!d) {
        // 一个目标都没有 —— 这是**开箱状态**（插件不再凭空补一个环回目标）。
        // 报错要能直接照做，而不是丢一个 `"undefined" 不存在` 给人猜。
        throw new Error(
          'ssh-link: 还没有任何目标机器 —— 先在 App 侧边栏「SSH 连接」面板里加一台' +
          '（或在插件配置的 targets 里写一条），然后重试。',
        );
      }
      return d;
    }
    const t = registry.get(String(nameArg));
    if (!t) {
      throw new Error(
        `ssh-link: 未知 target "${nameArg}",已知: ${registry.list().map((x) => x.name).join(', ')}`,
      );
    }
    return t;
  };

  // ---------------------------------------------------------------- provider
  //
  // 注册在**进程级**(host 组合):provider 名在一个进程里只能注册一次,
  // 而模型可见的委派工具是 preset 层另外加的(框架的既定分工,见
  // dsh-agent-presets/presets/standard/agent.cordis.yml 的注释)。
  const provider = createSshProvider({
    name: providerName,
    target: registry.get(defaultTargetName() ?? ''),
    timeoutMs: delegateTimeoutMs,
  });
  // **不再外包 ctx.effect**:registerProvider 内部就是 `this.ctx.effect(...)`
  // (dsh-subagent 的 registerProvider),重复注册会抛 DUPLICATE_PROVIDER。
  // 外面再套一层会把那个错误变成静默的加载失败。
  ctx.subagents.registerProvider(provider);

  // 多看一个 target 时,每个 target 都有自己的一份 provider(名字 = target 名),
  // 这样模型可以点名叫哪台机器。默认那台用主名字。
  //
  // **所有** provider 都要记下来收尾 —— 只 drain 主 provider 是漏的:
  // 多 target 时其余 provider 的远端 run 会在插件卸载后变成烧 token 的孤儿。
  const allProviders = [provider];
  /**
   * 为每台**非默认**目标注册一个同名 provider,这样模型可以点名叫哪台机器。
   *
   * 这里刻意只覆盖**启动时**存在的目标:provider 名在一个进程里只能注册一次,
   * 而用户之后在 App 里新加的目标没法在同一进程里安全地"注册后改名"。
   * 新加的目标立即可用 `ssh_exec` + `/api/ssh.exec`(那是按名寻址,没有注册表),
   * 想让它也能被委派,重启一次后端即可 —— 这个取舍写在 README 里。
   */
  for (const t of registry.list()) {
    if (t.name === defaultTargetName()) continue;
    const extra = createSshProvider({ name: t.name, target: t, timeoutMs: delegateTimeoutMs });
    ctx.subagents.registerProvider(extra);
    allProviders.push(extra);
  }

  // ------------------------------------------------------------------- 工具
  ctx.tools.register({
    name: 'ssh_exec',
    description:
      'Run a shell command on a configured remote host over SSH and return its stdout, stderr and exit code. ' +
      'Use this to operate the remote machine directly (files, processes, git, package managers) without spawning ' +
      'an agent there. The command runs in the remote shell; quote arguments as you would locally. ' +
      'Non-zero exits are reported, not errored — check the exit code and investigate.',
    // 标准 JSON Schema（不是 defineTool 的简写）—— 原因见模块注释。
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute on the remote host.',
        },
        target: {
          type: 'string',
          description: 'Which configured remote target to use. Defaults to the primary target.',
        },
        workdir: {
          type: 'string',
          description: 'Absolute working directory on the remote host. Defaults to the remote login directory.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds; the remote command is killed on expiry. Defaults to ${execTimeoutMs}.`,
        },
      },
    },
    output: {
      // 严格 JSON Schema 子集（dsh-tools 的 assertSupportedJsonSchema）：
      // `required` 只能出现在 **type: "object"** 上，且必须是 `properties` 的
      // **兄弟数组** —— 不能写成每个属性上的 `required: true`（那是 defineTool 的
      // 简写语法）。写成简写会让**整棵插件树加载失败**，真 loader 实测报:
      //   unsupported JSON schema: schema.properties.stdout.required is not supported on type "string"
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'exitCode', 'signal', 'stdout', 'stderr', 'truncated', 'durationMs', 'stopReason'],
        properties: {
          target: { type: 'string' },
          // oneOf 节点自身不能带 required —— 可空值用 type:"null" 的成员表达。
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
          durationMs: { type: 'number' },
          stopReason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const body = value.stdout.length > 0 ? value.stdout : '(no output)';
        const lines = [body];
        if (value.stderr.length > 0) lines.push(`[stderr]\n${value.stderr}`);
        if (value.truncated) lines.push('[output truncated]');
        if (value.signal !== null) lines.push(`[killed by signal: ${value.signal}]`);
        else if (value.exitCode !== 0) lines.push(`[exit code: ${value.exitCode}]`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const target = pick(args.target);
      const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : execTimeoutMs;
      // **不要套 `sh -c`** —— 这是实测踩到的坑:Termux 上 /bin/sh 是 Android 系统的
      // mksh,它的 PATH **不含 $PREFIX/bin**,于是 `command -v dsh` / `npm` / `node`
      // 全都找不到。而用户说「像 ssh 那样操作那台机器」,期望的是**自己的登录 shell**
      // (远端实测是 bash,PATH 首位就是 $PREFIX/bin)。
      //
      // ssh 本身的语义就是「把这条命令行交给远端登录 shell」,所以直接作为单个 argv
      // 传过去即可 —— 既符合直觉,又不经过 mksh 那一层降级。
      const r = await runRemote({
        target,
        script: String(args.command),
        cwd: typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : undefined,
        timeoutMs,
        signal: exec.signal,
        maxBytes,
      });
      return {
        target: target.name,
        exitCode: r.code,
        signal: r.signal,
        stdout: r.stdout,
        stderr: r.stderr,
        truncated: r.truncated,
        durationMs: r.ms,
        stopReason: r.stopReason,
      };
    },
  });

  // ------------------------------------------------------------------- 路由
  //
  // 每个动作一条**精确路径**:connection 的 fetch 路由按 path 匹配,
  // 用一条 `/api/ssh.` 前缀收全部动作会让「新增动作 = 新增一个 if 分支」,
  // 而精确路径下「新增动作 = 新增一次 register」—— 后者在代码里看得见、数得清,
  // 也便于测试做「注册数 == 动作数」的对账。
  /** 目标对外投影:路由与 App 都读这个形状。 */
  const projectTarget = (t) => ({
    name: t.name,
    host: t.host,
    port: t.port,
    user: t.user,
    dsh: t.dsh,
    profile: t.profile,
    // 下面三项是给 App 面板用的元信息:能让用户看出这台是"配置里写死的"
    // 还是"自己手填的"、以及最近一次探测是否通(不新发起探测)。
    source: t.source,
    lastSeenAt: t.lastSeenAt,
    lastError: t.lastError,
  });

  const routes = {
    'ssh.targets': async () => ({
      defaultTarget: defaultTargetName() ?? '',
      targets: registry.list().map(projectTarget),
    }),

    /**
     * 本机身份 —— 自动配对时对端据此知道「往哪连我」和「该收下哪把公钥」。
     *
     * 这个端点**不写任何东西**:它只读。生成密钥是 `ssh.identity.generate`,
     * 一个显式的用户动作(见 identity.js 的模块注释)。
     */
    'ssh.info': async () => {
      // 客户端只需要报一件事：**我这份公钥是什么**。
      // 用户拿它去目标机器（比如 PC）的 authorized_keys 里放一次，之后就能免密连。
      // 以前这里还报 user/sshPort/host/addresses/authorizedKeysPath/pairing ——
      // 那些全是"别人怎么连到我"，本插件不做服务端，已经删掉。
      const id = readIdentity(identityOpts);
      return {
        user: id.user,
        publicKey: id.publicKey ? id.publicKey.canonical : null,
        fingerprint: id.fingerprint,
      };
    },

    /**
     * 环境自检：这台机器缺不缺 ssh / sshd。
     *
     * **只读** —— 不装包、不改权限、不启服务。装上插件之后 App 第一件事就是调它。
     * 插件自己**不会**装 openssh（零依赖、从不碰包管理器），所以「装完插件能不能
     * 真用」完全取决于这台机器本来有没有 ssh；在这之前，这个答案只以
     * `spawn ssh ENOENT` 的形式出现，用户根本读不出来。
     *
     * 出站（ssh 客户端）与入站（sshd 在监听）**分开报**：只装了一半是很常见的
     * 状态，合并成一个布尔会把部分可用说成全坏、让人去修没坏的东西。
     */
    'ssh.doctor': async () => inspectSshEnvironment(),


    /** 显式生成 SSH 密钥(幂等:已存在就不覆盖)。 */
    'ssh.identity.generate': async () => {
      const r = await generateKey({
        home: identityOpts.home,
        comment: config?.deviceName ? `ssh-link@${config.deviceName}` : 'ssh-link',
      });
      const id = readIdentity(identityOpts);
      return { ...r, publicKey: id.publicKey ? id.publicKey.canonical : null };
    },

    /** 新增/更新一个目标(手填地址的入口)。 */
    'ssh.targets.add': async (body) => {
      const t = registry.upsert({
        name: body?.name,
        host: body?.host,
        port: body?.port,
        user: body?.user,
        dsh: body?.dsh,
        profile: body?.profile,
        source: 'manual',
      });
      return { target: projectTarget(t) };
    },

    /** 删除一个目标(只删动态的;配置里的会被拒)。 */
    'ssh.targets.remove': async (body) => {
      const name = String(body?.name ?? '').trim();
      if (!name) throw new Error('name is required');
      // 顺手回收配对时写进对端的公钥?**不做** —— 那需要连对端,而删除应当是
      // 本地即时生效的操作。对端那边留着的公钥由用户在那边清理(README 有说明)。
      const removed = registry.remove(name);
      return { removed, name, targets: registry.list().map(projectTarget) };
    },


    // 连通性探测:走的是与其它动作完全相同的通道,所以「测通」是真通。
    'ssh.test': async (body) => {
      const target = pick(body?.target);
      const r = await runRemote({
        target,
        // 同 ssh_exec:不套 sh -c,否则探测到的是 mksh 的 PATH,会误报 dsh 不存在。
        script: 'echo SSH-OK; whoami; command -v node dsh 2>/dev/null || true',
        timeoutMs: Number(body?.timeoutMs) > 0 ? Number(body.timeoutMs) : 20_000,
        maxBytes: 64 * 1024,
      });
      const lines = r.stdout.split('\n').filter((l) => l.length > 0);
      return {
        target: target.name,
        ok: r.stopReason === 'completed' && lines[0] === 'SSH-OK',
        user: lines[1] ?? null,
        node: lines[2] ?? null,
        dsh: lines[3] ?? null,
        stopReason: r.stopReason,
        stderr: r.stderr.slice(0, 2000),
      };
    },

    'ssh.exec': async (body, request) => {
      // 先校验请求本身，再解析目标。顺序不能反：请求参数缺失是 400
      // （调用方改一下就好），而没有目标机器是 502（服务端状态问题）——
      // 反过来的话，用户漏传 command 会收到一句"还没有任何目标机器"，
      // 照着做也修不好。
      if (typeof body?.command !== 'string' || body.command.length === 0) {
        throw new Error('command is required');
      }
      const target = pick(body?.target);
      const r = await runRemote({
        target,
        // 同 ssh_exec 工具:交给远端登录 shell,不套 sh -c。
        script: body.command,
        cwd: typeof body?.workdir === 'string' && body.workdir.length > 0 ? body.workdir : undefined,
        timeoutMs: Number(body?.timeoutMs) > 0 ? Number(body.timeoutMs) : execTimeoutMs,
        // 取消靠 HTTP 连接断开 + timeoutMs,**不靠 body 里的 signal**:
        // JSON 传不了 AbortSignal,写了也是永远 undefined 的死代码。真要让 App
        // 主动取消,应该在 fetch handler 里接 `request.signal`(WHATWG Request 自带,
        // 客户端断开时触发)—— 见下面 register 的 handler。
        signal: request?.signal,
        maxBytes,
      });
      return {
        target: target.name,
        exitCode: r.code,
        signal: r.signal,
        stdout: r.stdout,
        stderr: r.stderr,
        truncated: r.truncated,
        durationMs: r.ms,
        stopReason: r.stopReason,
      };
    },
  };

  // HTTP 路由是**可选能力**:headless profile 里没有 connection/webServer,
  // 不该因此拒绝加载整个插件。
  //
  // `ctx.inject(deps, cb)` 建一个子 fiber:它单独等这三个服务,到位了才执行 cb,
  // 而父 fiber 立刻激活(所以插件在 headless 下也是 active,只是没有路由)。
  // 这是官方 dsh-api-gateway 的既有写法。
  ctx.inject(['connection'], (httpCtx) => {
    // registerFetchRoute 内部是 `owner.effect(...)`,同路径重复注册会抛
    // "exact Fetch route is already registered"。直接调,让冲突当场可见。
    for (const [route, handler] of Object.entries(routes)) {
      httpCtx.connection.fetch.register({
        path: ROUTE_PREFIX + route.slice('ssh.'.length),
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body = {};
          try {
            const text = await request.text();
            if (text.length > 0) body = JSON.parse(text);
          } catch {
            // 这里还没拿到 rpcId(body 本身就没解析出来),所以只能是裸形状 ——
            // 但 App 解析失败时本来也拿不到 rpcId,两者一致。
            return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
          }

          // rpcId 必须在**解包之前**取 —— App 的 decodeEnvelope 会拿它和请求里的
          // 比,不一致就报 "rpcId 不匹配"。
          const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : null;

          // ── 信封解包:App 与对端发来的是 {type,rpcId,method,payload} ──
          //
          // **这是一个真实踩过的 bug**:handler 原先直接收到整个信封,于是
          // `body.host`/`body.target`/`body.command` 永远是 undefined ——
          // 带参数的动作全部静默失败(表现为"target.host is required"这种
          // 与真实原因无关的报错),而无参数的动作(ssh.targets)看起来正常,
          // 所以很难察觉。
          //
          // 插件自有路由的约定是 **payload 就是参数本身**(不套 args,那是 typert
          // 的规矩)。这里同时容忍裸 body —— 手写 curl 调试时直接用参数即可。
          if (body !== null && typeof body === 'object' && 'payload' in body) {
            const inner = body.payload;
            body = inner !== null && typeof inner === 'object' ? inner : {};
          }
          // ── 响应必须是 {type,rpcId,result},不是裸 {ok,value} ──
          //
          // **真实踩到的 bug**:App 的 decodeEnvelope 要求
          //   {type:"server-response", rpcId:<回显>, result:{ok,value}}
          // 裸 {ok,value} 会被判 "rpcId 不匹配" 而抛 IOException ——
          // 症状是面板永远停在"正在检测"(supported 停在 null),而不是报错。
          // 同目录另两个插件都是这个形状(见 dsh-file-transfer 的 reply 助手)。
          const reply = (result, status = 200) =>
            Response.json(
              rpcId === null
                ? result // 非信封调用(手写 curl)保持裸形状,方便调试
                : { type: 'server-response', rpcId, result },
              { status },
            );

          try {
            const value = await handler(body, request);
            return reply({ ok: true, value });
          } catch (e) {
            // 用 4xx/5xx 让 App 的 OkHttp 能凭状态码判断,body 里给结构化原因。
            // 参数错是 400,其余算远端/内部故障。
            const message = String(e?.message ?? e);
            const status = /required|未知 target|未知/.test(message) ? 400 : 502;
            // 错误也走同一个信封:裸 {ok:false,error} 会被 App 判成
            // "rpcId 不匹配",于是用户看到的是协议错而不是真实原因。
            return reply({ ok: false, error: message }, status);
          }
        },
      });
    }
  });

  // 停止时把还活着的远端 run 掐掉 —— 否则更新/卸载会留下烧 token 的孤儿。
  // 覆盖全部 provider,不只是主的那份。
  ctx.effect(() => () => {
    for (const pr of allProviders) void pr.drain();
  }, 'ssh-link: drain');
}

export default { name, inject, apply };
