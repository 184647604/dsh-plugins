# dsh-plugin-center — 插件中心主插件（管理桥）

**插件中心(Plugin Center)的总成主插件 / 管理桥**。一个自包含、零运行时依赖的包,装到**任意** dsh web 后端上,就把那个后端变成可远程管理的"插件中心"。它是**受保护、常驻**的管理桥 —— 其它插件(包括官方子插件)由它统一启停/卸载。

**MCP 管理不是本插件的一部分**:它是官方**子插件** `dsh-mcp-admin`(见 `../dsh-mcp-admin`),由本插件像普通插件一样启停/卸载。`center.catalog` 返回官方子插件目录及其实时安装/启用状态,客户端据此提供"一键安装"。

## 角色模型

```
dsh-plugin-center  ← 本包:管理桥(受保护、常驻)
    │  plugins.list / setEnabled / remove
    │  center.describe / center.catalog
    └─ dsh-mcp-admin  ← 子插件(普通、可管理)
          mcp.list / add / update / remove / setEnabled / restart
```

## 安装(任意后端通用)

先决条件:目标主机装好 `dsh` 与 `pnpm`(node>=18)。

```sh
# 发布到 npm 后 —— 仓库直装(桌面/远程后端同样适用)
dsh plugin --profile web add dsh-plugin-center

# 尚未发布、本地先跑通 —— 本地包/归档同一条路
dsh plugin --profile web add -w /path/to/dsh-plugin-center.tgz
```

`dsh plugin add` 是 pnpm 转发器:看到包内 `dsh.bundle.patch` 声明后,会把 `dsh-plugin-center`
自动并入 profile 的 bundle 层(写入 `dsh.profile.bundles`)。**该方式首次安装后需重启一次
`dsh web`** 让它随 profile 启动;之后的启停/卸载全部**免重启**(loader 热生效)。

> **免重启热装(实测)**:把包复制进 `~/.dsh/profiles/<p>/node_modules/` 并在 `cordis.patch.yml`
> 追加一行 `- insert: {id: dsh-plugin-center, name: dsh-plugin-center}`(包内零依赖,无需 pnpm),
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
| `plugins.list` | `{}` | 已加载插件清单(id/name/enabled/fiberPhase/system/protected) |
| `plugins.setEnabled` | `{id, enabled}` | 启停(管理桥与系统核心受保护) |
| `plugins.remove` | `{id}` | 移除(受保护项拒绝;子插件可移除) |
| `center.describe` | `{}` | 能力探测:`{id, name, version, kind:"master", profile, tokenAuth, capabilities}` |
| `center.catalog` | `{}` | 官方子插件目录:`{subplugins:[{package, role, title, description, installed, enabled, fiberPhase}]}`(当前:`dsh-mcp-admin`, role `mcp`) |

## 保护规则

`plugins.setEnabled` / `plugins.remove` 对以下对象**拒绝**(`protected`):
- **管理桥本身**(`dsh-plugin-center`,及迁移期可能驻留的旧 `dsh-mcp-admin` 全功能桥);
- **官方系统核心**(`@deepseek-ai/*`)。

**官方子插件 `dsh-mcp-admin` 不在保护名单** —— 它应当能被正常安装/启停/卸载。

## 持久化与安全

- 本插件只用**纯文本 patch 操作**(无需 yaml),不写托管块;`dsh-mcp-admin` 子插件自行维护其
  MCP 实例托管块(`dsh-mcp-admin managed`,兼容集成期 `dsh-plugin-center managed` 遗留标记)。
- 仅接受 `POST`;跨站浏览器请求(不同 Origin)拒绝(403);无 Origin 的非浏览器客户端放行。
- 可选令牌:插件 `config.token` 或环境变量 `DSH_PLUGIN_CENTER_TOKEN`(兼容旧 `DSH_MCP_ADMIN_TOKEN`)
  设置后,请求须带 `x-dsh-plugin-center-token: <token>`(兼容旧 `x-dsh-mcp-token`)。
- 请求体上限 1 MiB。

## 开发 / 发布

```sh
# 自检(ESM 语法/加载)
node --check lib/index.js && node -e "import('./lib/index.js').then(m=>console.log('ok', m.default.name))"

# 契约测试 + 运行时冒烟(mock ctx,免后端)
node --test test/protocol.test.mjs && node test/smoke-live.mjs

# 本地打包验证(建议在干净 profile 上先跑通)
npm pack
dsh plugin --profile <scratch> add -w ./dsh-plugin-center-0.1.0.tgz

# 发布
npm publish
```

零依赖、`files` 已限定 `lib` + `cordis.patch.yml` + README(纯文本 patch 操作,无 vendor)。
