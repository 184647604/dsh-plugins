# dsh-ssh-link

用 SSH 把远端机器接成本机可用的能力 —— **不需要配对**，只要公钥认证能用。

装好之后你在 dsh 里得到三样东西：

| 能力 | 形态 | 用途 |
|---|---|---|
| `ssh_exec` 工具 | 模型工具 | 直接在那台机器上跑命令（文件、进程、git、包管理），**不起 agent、不烧 token** |
| `ssh` subagent provider | 进程级注册 | 配合一行 preset 配置，得到 `subagent_ssh` 委派工具：每次调用 = 远端起一个 `dsh --profile headless` 干活 |
| `/api/ssh.*` 路由 | HTTP | 给 App / 脚本用：列目标、测连通、跑命令 |

## 安装

⚠️ **不要用裸包名安装。** 本项目的包一律走 GitHub Release 的 tgz 直链：

> **为什么特意强调**：这个插件原名 `dsh-ssh-bridge`，而**那个名字在 npm 上被别人占了**
> —— 一位 lance-kanglu 发布的 OpenWRT 路由器 SSH 桥（v0.4.2，关键词同样是
> `dsh / deepseek-harness / plugin / ssh / bridge`）。裸名安装会**静默装上他的代码**。
> 2026-09 因此改名为 `dsh-ssh-link`：该名字已确认 npm 上无人占用，
> 万一真走了裸名路径，也只是**明确 404**，而不会装错东西。
> **不要再改回 `dsh-ssh-bridge`。**

```sh
dsh plugin --profile web add -w \
  https://github.com/184647604/dsh-plugins/releases/download/<tag>/dsh-ssh-link-<version>.tgz
```

装完重启后端。


**目标有两个来源**，不配 YAML 也能用：

| 来源 | 怎么加 | 生效 | 能不能删 |
| --- | --- | --- | --- |
| 配置文件 `targets` | 改 YAML | 要重启后端 | 不能（路由会拒绝，避免"删了又出现") |
| `ssh.targets.add` 路由 | App 侧边栏「SSH 连接」面板 | 立刻 | 能 |

**什么都不配就是没有目标** —— 插件不再凭空补一个 `127.0.0.1:8022`。那是"本机自己
跑着 sshd"时代的默认，而本插件是**纯客户端**：环回目标等于让它去连自己，几乎不可能
成功，只会在面板上多出一条假机器。第一次用就在面板里加一台（或者写进下面的 `targets`）。

## 这个插件只有客户端能力

一句话：**它连出去，不接进来。**

| 做 | 不做 |
|---|---|
| 用系统里的 `ssh` 连目标机器 | ❌ 不监听任何端口 |
| 远程跑命令（`ssh_exec` / `/api/ssh.exec`） | ❌ 不装、不启动、不检查 `sshd` |
| 把远端 `dsh --profile headless` 当 subagent 后端 | ❌ 不读写任何 `authorized_keys` |
| 给 App 提供 `/api/ssh.*` 路由 | ❌ 不认识"配对"这个概念 |

所以「**别人怎么连到我**」完全不是这个插件的事。要手机操作 PC，就在手机这边加一条
指向 PC 的 target；PC 那边只要有一个正常跑着的 sshd 就够了 —— 那是 PC 自己的运维，
不需要本插件参与。

> 2026-09 之前这里还有一整套服务端：入站 sshd 自检、`authorized_keys` 维护、
> 基于 `~/.dsh/hosts.json` 的"配对"。全部删掉了 —— 一个客户端插件不该管这些，
> 而且它让"缺 sshd"这种与本插件无关的状态变成了一条红警报。App 的启动脚本里
> 自动拉起 sshd 的那段也一并去掉。

## 配置

`~/.dsh/profiles/<profile>/cordis.patch.yml` 里那行的 `config`：

```yaml
- id: dsh-ssh-link
  name: dsh-ssh-link
  config:
    providerName: ssh          # subagent 注册名（preset 那行要写这个）
    defaultTarget: pc          # 不指定 target 时用哪个
    timeoutMs: 120000          # ssh_exec 默认超时
    delegateTimeoutMs: 600000  # 委派给远端 agent 的超时
    targets:                   # 可选；不写就在 App 面板里加
      - name: pc
        host: 100.x.y.z        # Tailscale IP / 局域网 IP
        port: 22
        user: sun
        dsh: dsh
        profile: headless
```

字段默认值：`port` 8022、`user` 空、`dsh` `dsh`、`profile` `headless`。
`host` 是**必填**的（缺了直接报错，不会悄悄回落到环回）。

`defaultTarget` 是**惰性**解析的：显式配置 → 第一条配置目标 → 第一条动态目标（App 里加的）
→ 没有。所以你在面板里加完机器，`ssh.exec` 不带 target 也能直接用上它。

## 让模型能委派给远端（可选）

在上面那步之外，还要在 **agent preset** 里加一行 —— 这是 dsh 的既定分工：
provider 注册在 host 组合里（进程单例，一个名字只能注册一次），而**每个 agent 可见的委派工具**在 preset 层。

```yaml
- id: tool-subagent-ssh
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: ssh          # 与上面的 providerName 一致
    toolName: subagent_ssh
    backgroundMode: one-shot
    maxDepth: provider-managed
```

照着 `dsh-agent-presets/presets/standard/agent.cordis.yml` 里
`tool-subagent` / `tool-subagent-fork` / `tool-subagent-codex` 的写法抄即可 ——
它们是四个并列的 backend，这个 `ssh` 就是第五个。

> **别改随 dsh 发行的 preset**（`.../dsh-agent-presets/presets/`）：属于部署，升级会覆盖。
> 复制一份到 `~/.dsh/.agent-presets/<你的名字>/` 再改。

## 前提

- **远端要有 sshd，且你的公钥在它的 `authorized_keys` 里**。本插件只走公钥认证
  （`BatchMode=yes` + `PreferredAuthentications=publickey`）—— 它跑在无人值守的后端进程里，
  任何交互提示都等于卡死，所以没有可用公钥时立刻失败，而不是挂在那里等密码。
- 委派功能要求远端有 `dsh` 且配了 `headless` profile。
- **方向别搞混**：这个插件让**本机**去调**远端**。Windows 要当被调的那一端，
  得先装 OpenSSH **Server**（`ssh.exe` 是客户端，不算）。
## HTTP 路由

全部 `POST`，body 为 JSON。认证由 dsh 的 connection 服务统一处理
（这些路由注册在**已认证的共享 handler 内部**，不是自己挂的裸路由）。

参数就是 `payload` 本身（插件自有路由的约定，**不套 `args`** —— 那是 typert 的规矩）。
路由同时容忍裸 body，所以手写 curl 调试时直接传参数即可。

```
POST /api/ssh.targets            {}                                      → { defaultTarget, targets[] }
POST /api/ssh.test               { target?, timeoutMs? }                 → { ok, user, node, dsh, ... }
POST /api/ssh.exec               { command, target?, workdir?, timeoutMs? } → { exitCode, stdout, stderr, ... }
POST /api/ssh.targets.add        { name?, host, port?, user?, ... }      → 加一个动态目标
POST /api/ssh.targets.remove     { name }                                → 删一个动态目标（配置里的删不掉）
POST /api/ssh.info               {}                                      → 本机身份：user / 公钥 / 指纹
POST /api/ssh.identity.generate  {}                                      → 显式生成本机密钥对（幂等）
POST /api/ssh.doctor             {}                                      → 环境自检：这台机器有没有 ssh 客户端
```

一共 8 条，**全是客户端方向的**。以前还有 `ssh.discover` / `ssh.pair` /
`ssh.authorize` / `ssh.keys` / `ssh.keys.revoke` 五条服务端路由，已删。

### `ssh.doctor`：本插件**不装任何东西**，所以要先问"这台机器有没有 ssh"

零依赖是本仓库的硬约束，插件从不调用 `pkg`/`apt`/`brew`，也不会去装 openssh。
于是「插件装好了」**不等于**「能用」—— 在没有 ssh 客户端的机器上，唯一症状是一句
`spawn ssh ENOENT`，用户读不出那是"没装 openssh"。

返回值只有客户端这一半：

```js
{
  platform: 'termux',
  client: { ok, description, sshPath, version, install },  // 缺的时候 install 是给人照抄的命令
  hint,                                                    // 平台相关的补充说明
  ready,                                                   // 等价于 client.ok
}
```

注意 `ready` 只看客户端。以前这里还有 `inbound`（sshd 有没有在听）、
`authorizedKeys`（StrictModes 会不会拒绝）、`partial`（只装了一半）、
以及按 `role`（client/server/both）决定"缺哪个方向才算问题"—— 全部删除。
它们检查的都是**别人连进来**需要的东西，与本插件无关。

参数错返回 `400`，远端/内部故障返回 `502`，body 里都有结构化的 `error`。
**非零退出码不是 HTTP 错误** —— 它是 `200` + `value.exitCode`，与 bash 工具的语义一致。

## 安全

- **命令转义**：`quoteShell` 是唯一的安全边界（远端路径/参数要穿过一层远端 shell）。
  它对真实 shell 做过 16 种注入载荷的往返测试（`$(...)`、反引号、`;`、`|`、`>`、嵌套引号、换行）。
- **两种语义刻意分开**：`remoteCommand`（参数=**数据**，逐个转义，用于 prompt）
  与 `remoteScript`（参数=**代码**，原样执行，用于 `ssh_exec` 的命令）。
  混用会出真 bug —— 见 `lib/transport.js` 的注释。
- **不套 `sh -c`**：Termux 上 `/bin/sh` 是 Android 的 mksh，PATH 不含 `$PREFIX/bin`，
  套一层会让 `node`/`dsh`/`npm` 全都找不到。ssh 的语义本来就是「交给远端登录 shell」。
- **主机密钥**：用 `StrictHostKeyChecking=accept-new`（首次自动接受），**不是** `no` ——
  主机密钥变了正是 MITM 的指纹，必须报错。
- **不做网络扫描**：目标只能由用户显式给出（配置文件或 App 面板）。插件不会去探测网段。

> 以前这一节还讲 `authorized_keys` 的写入面与配对信任锚 —— 那是服务端才有的暴露面，
> 已随功能一起消失。**本插件现在对文件系统只有读**（读自己的身份密钥，
> 在 `ssh.identity.generate` 时才写 `~/.ssh/id_ed25519`）。

## 测试

```sh
node --test plugins/dsh-ssh-link/test/transport.test.mjs   # 转义 / 拼装 / 归一
node --test plugins/dsh-ssh-link/test/provider.test.mjs    # SubagentProvider 契约
node --test plugins/dsh-ssh-link/test/plugin.test.mjs      # 认证结构 / 零依赖 / 防退化
node --test plugins/dsh-ssh-link/test/keys.test.mjs        # 公钥解析与拒绝面
node --test plugins/dsh-ssh-link/test/registry.test.mjs    # 目标唯一性 / 配置只读 / 持久化
node --test plugins/dsh-ssh-link/test/doctor.test.mjs      # 客户端自检 / 平台提示

node --test plugins/dsh-ssh-link/test/*.test.mjs           # 全部（108 条）

node plugins/dsh-ssh-link/test/smoke-live.mjs              # 假 ctx 挂载 + 打 8 条路由
node plugins/dsh-ssh-link/test/smoke-live.mjs --live       # 外加真跑一次 ssh
node plugins/dsh-ssh-link/test/e2e-provider.mjs            # 真跑远端 dsh headless（慢）
```

`tools/probes/ssh-subagent-probe.mjs` 是这条链路的**原始**探针（插件就是从它验证过的
形状写出来的），仍可当作独立回归入口。
