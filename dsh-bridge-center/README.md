# dsh-bridge-center — 插件中心主插件（管理桥）

**插件中心(Plugin Center)的总成主插件 / 管理桥**。一个自包含、零运行时依赖的包,装到**任意** dsh web 后端上,就把那个后端变成可远程管理的"插件中心"。它是**受保护、常驻**的管理桥 —— 其它插件(包括官方子插件)由它统一启停/卸载。

**MCP 管理不是本插件的一部分**:它是官方**子插件** `dsh-mcp-admin`(见 `../dsh-mcp-admin`),由本插件像普通插件一样启停/卸载。`center.catalog` 返回官方子插件目录及其实时安装/启用状态,客户端据此提供"一键安装"。

## 角色模型

```
dsh-bridge-center  ← 本包:管理桥(受保护、常驻)
    │  plugins.list / setEnabled / remove
    │  plugins.install        ← 接收手机推来的子插件包(默认关闭)
    │  center.describe / center.catalog
    └─ dsh-mcp-admin  ← 子插件(普通、可管理)
          mcp.list / add / update / remove / setEnabled / restart
```

## 安装(任意后端通用)

先决条件:目标主机装好 `dsh` 与 `pnpm`(node>=18)。

```sh
# 发布到 npm 后 —— 仓库直装(桌面/远程后端同样适用)
dsh plugin --profile web add dsh-bridge-center

# 尚未发布、本地先跑通 —— 本地包/归档同一条路
dsh plugin --profile web add -w /path/to/dsh-bridge-center.tgz
```

`dsh plugin add` 是 pnpm 转发器:看到包内 `dsh.bundle.patch` 声明后,会把 `dsh-bridge-center`
自动并入 profile 的 bundle 层(写入 `dsh.profile.bundles`)。**该方式首次安装后需重启一次
`dsh web`** 让它随 profile 启动;之后的启停/卸载全部**免重启**(loader 热生效)。

> **免重启热装(实测)**:把包复制进 `~/.dsh/profiles/<p>/node_modules/` 并在 `cordis.patch.yml`
> 追加一行 `- insert: {id: dsh-bridge-center, name: dsh-bridge-center}`(包内零依赖,无需 pnpm),
> 运行中的 dsh web 会监听 patch 文件并**热加载**,约 2 秒后 `/api/center.describe` 即可用 ——
> 这就是 App 一键安装走的路径。**两种方式不要混用**(同一插件 id 会重复挂载)。
> 子插件 `dsh-mcp-admin` 用同一套规则安装。

> ⚠️ **但热加载只对「装一个尚未加载的插件」成立。** 若插件**已经加载**、只是改了它的源码
> （例如更新 `lib/index.js`），HMR **不会**重新导入 —— 实测运行中的进程只对 profile 的少量
> 配置路径挂了 inotify（**仅 10 个 watch**），并不监听 `node_modules` 下的插件源码，
> 旧模块仍留在 Node 的模块缓存里。这种情况**必须重启 `dsh web`** 才生效：
> 改文件、touch 同目录、touch patch 层三种触发方式实测均无效。

> 注:pnpm 会把 profile 目录当作 workspace 根,`dsh plugin add` 需带 `-w`(当前 pnpm 行为)。

## 接口一览(与官方 unary 协议同构)

请求:POST `/api/<method>`,body:

```json
{"type":"client-request","rpcId":"<uuid>","method":"plugins.list","payload":{}}
```

响应:`{"type":"server-response","rpcId":"<uuid>","result":{"ok":true,"value":{...}}}` 或
`{"result":{"ok":false,"error":{"code":"...","message":"..."}}}`。

| Method | payload | 说明 |
|---|---|---|
| `plugins.list` | `{}` | 已加载插件清单(id/name/enabled/fiberPhase/system/protected/**title**) |
| `plugins.setEnabled` | `{id, enabled}` | 启停(管理桥与系统核心受保护) |
| `plugins.remove` | `{id}` | 移除(受保护项拒绝;子插件可移除) |
| `plugins.install` | `{name, version, files:[{path,data}], enable?}` | **接收客户端推来的子插件包**(默认关闭,见下) |
| `center.describe` | `{}` | 能力探测:`{id, name, version, kind:"master", profile, tokenAuth, capabilities, remoteInstall}` |
| `center.catalog` | `{}` | 官方子插件目录:`{subplugins:[{package, role, title, description, installed, enabled, fiberPhase}]}`(当前:`dsh-mcp-admin`, role `mcp`) |

## 名称标签（`title`）

插件在 App 列表里的主标题取自**插件包自己的** `package.json`：

```json
{
  "name": "dsh-file-transfer",
  "description": "dsh web 的文件传输插件:原始字节流式落盘端点,把手机文件写入后端。",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "title": "文件传输" }
}
```

- `dsh.title` 是**给人看的名字**（「文件传输」「MCP 管理」），App 拿它当列表主标题。
- `description` 是 npm 的一句话说明，两者不是一回事，因此**不复用同一个字段**。
- `plugins.list` 从 profile 的 `node_modules/<包名>/package.json` 读出 `dsh.title` 返回；
  只在插件里维护一份，不在 App 或服务端再抄一份（两份文案必然漂移）。
- 读不到就返回 `null`，App 退回显示包名 —— 第三方插件没有 `dsh.title` 也能正常显示。
- 系统核心（`@deepseek-ai/*`）不读：有一百多个，挨个读文件纯属浪费，App 也不显示它们。

同时 `plugins.list` 会**过滤 loader 内置容器**（`cordis:` 前缀，如 `cordis:include`）：
它们是 `loader.builtins` 里的挂载点，不是插件，没有包名也不能启停。官方
`plugin-package-inventory` 用同一个前缀做同样的判定。

## 远程安装 `plugins.install`（默认关闭）

用来让**客户端**（手机 App）把子插件包推过来装上，于是云端仓库只需要放主插件，子插件由手机推。

**默认关闭。** 开启方式（二选一，之后重启 `dsh web`）：

```yaml
# 插件 config
allowRemoteInstall: true
```

```sh
# 或环境变量
DSH_PLUGIN_CENTER_ALLOW_INSTALL=1 dsh web --profile web
```

之所以默认关闭：「装上主插件」和「允许远程往这台机器装代码」是两个独立决定，不该由前者自动带出后者。
**这条路由等于在目标机上开放远程代码执行**，比 `setEnabled`/`remove` 危险一个量级 —— 那两个受
`protected` 规则约束，而「装一个新包」天然绕开所有既有约束：装完就是这个进程里的一份可执行代码。

### 包格式不是 tgz

`files` 是一个 **JSON 文件列表**（`path` + base64 的 `data`），**不是** tar.gz。
插件侧因此完全不需要解析 tar —— 没有 tar 头就没有 tar 头解析，也就没有「用构造的 header
逃出目标目录」这一整类问题。`tools/pack-plugins.sh` 打的 tgz 是给 `dsh plugin add` 用的，与此无关。

### 四道防护

| 防护 | 作用 |
|---|---|
| 开关，默认关 | 装上主插件不自动等于开放安装 |
| 包名白名单（复用 `SUBPLUGIN_CATALOG`） | 挡掉「用这条路由装任意包」；也挡掉主插件自己（不允许远程替换管理桥） |
| 路径双重校验（逐段 + 解析后终检） | 挡掉 `..`、绝对路径、盘符、反斜杠、NUL 字节 |
| 落盘后强制 `import()` 校验 | 坏包不会进 `cordis.patch.yml` —— 否则会让 dsh web 起不来 |

### 错误码

| code | 含义 |
|---|---|
| `install-disabled` | 开关没开（默认路径） |
| `not-in-catalog` | 包名不在白名单（含主插件自己） |
| `invalid-path` | 某个 `path` 校验不过 |
| `bad-payload` | base64 非法 / 字段缺失 / 重复路径 / `package.json` 不是 JSON |
| `name-mismatch` | 包内声明的 name/version 与请求不符 |
| `incomplete-package` | 缺 `package.json` 或 `lib/index.js` |
| `verify-failed` | 落盘后 `import()` 校验不过（已回滚） |
| `write-failed` | 落盘失败（EACCES/ENOSPC…），已回滚 |

### 装完要不要重启

响应的 `restartRequired` 按实际情况回报：

- **新装**（loader 里还没有这个包）→ `false`。patch 文件被监听，约 2 秒热加载。
- **覆盖已加载的包** → `true`。HMR 不重新导入源码，旧模块仍在 Node 模块缓存里，必须重启。

请求体上限对该方法单独放宽到 8 MiB（其余方法仍是 1 MiB）。最大的子插件包 base64 后约 334 KB。

## 保护规则

`plugins.setEnabled` / `plugins.remove` 对以下对象**拒绝**(`protected`):
- **管理桥本身**(`dsh-bridge-center`,及迁移期可能驻留的旧 `dsh-mcp-admin` 全功能桥);
- **官方系统核心**(`@deepseek-ai/*`)。

**官方子插件 `dsh-mcp-admin` 不在保护名单** —— 它应当能被正常安装/启停/卸载。

## 持久化与安全

- 本插件只用**纯文本 patch 操作**(无需 yaml),不写托管块;`dsh-mcp-admin` 子插件自行维护其
  MCP 实例托管块(`dsh-mcp-admin managed`,兼容集成期 `dsh-bridge-center managed` 遗留标记)。
- 仅接受 `POST`;跨站浏览器请求(不同 Origin)拒绝(403);无 Origin 的非浏览器客户端放行。
- 可选令牌:插件 `config.token` 或环境变量 `DSH_PLUGIN_CENTER_TOKEN`(兼容旧 `DSH_MCP_ADMIN_TOKEN`)
  设置后,请求须带 `x-dsh-bridge-center-token: <token>`(兼容旧 `x-dsh-mcp-token`)。
- 请求体上限 1 MiB；`plugins.install` 单独放宽到 8 MiB。

## 开发 / 发布

```sh
# 自检(ESM 语法/加载)
node --check lib/index.js && node -e "import('./lib/index.js').then(m=>console.log('ok', m.default.name))"

# 契约测试 + 运行时冒烟(mock ctx,免后端)
node --test test/protocol.test.mjs && node test/smoke-live.mjs

# 本地打包验证(建议在干净 profile 上先跑通)
npm pack
dsh plugin --profile <scratch> add -w ./dsh-bridge-center-0.1.2.tgz

# 发布
npm publish
```

零依赖、`files` 已限定 `lib` + `cordis.patch.yml` + README(纯文本 patch 操作,无 vendor)。
