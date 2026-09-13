# dsh-mcp-admin — MCP 服务器管理子插件（插件中心的官方子插件）

`dsh-plugin-center`（插件中心主插件/管理桥）之上的 **MCP 子插件**：只负责 **MCP 服务器实例**（`mcp.*`）的增删改查/启停/重启。它是**普通插件，不受保护**——可以被插件中心正常**启用 / 停用 / 卸载**。

角色关系（避免混淆的关键）：

```
dsh-plugin-center  ← 管理桥(受保护、常驻)
    │  plugins.list / setEnabled / remove
    │  center.describe / center.catalog
    └─ dsh-mcp-admin ← 本包(MCP 子插件,可管理)
          mcp.list / add / update / remove / setEnabled / restart
```

## 安装

后端需先装插件中心主插件 `dsh-plugin-center`（App 一键安装/`dsh plugin add`）。

```sh
# 仓库/远程后端直装(需一次重启加载)
dsh plugin --profile web add dsh-mcp-admin

# 本包也可热装:文件 + cordis.patch.yml 追加挂载行,免重启
```

装完后 `center.catalog` 即显示 `dsh-mcp-admin installed: true`。

## 接口（与官方 unary 协议同构）

请求:POST `/api/mcp.<method>`，body:

```json
{"type":"client-request","rpcId":"<uuid>","method":"mcp.list","payload":{}}
```

| Method | payload | 说明 |
|---|---|---|
| `mcp.list` | `{}` | 列出全部已配置服务器(含 loader 实时状态、managed 标记) |
| `mcp.add` | `{serverName, transport:"stdio"\|"streamable-http", command?, args?, env?, cwd?, url?, headers?, toolCallTimeoutMs?}` | 新增(loader 热注册 + 持久化,免重启) |
| `mcp.update` | `{id, serverName, ...同上}` | 编辑(HMR 自动重连) |
| `mcp.remove` | `{id}` | 删除服务器 |
| `mcp.setEnabled` | `{id, enabled}` | 启用/停用服务器(热连接/热断开) |
| `mcp.restart` | `{id}` | 重启(disable + re-enable) |

## 持久化

服务器实例写入 profile `cordis.patch.yml` 的托管块（`# --- dsh-mcp-admin managed ---`）；
集成期由旧主插件写入的 `dsh-plugin-center managed` 块会被识别并归一，不产生双份。
块外手写配置原样保留。

## 启停/卸载语义（重要）

- **停用子插件**（`plugins.setEnabled … false`）= 只下线 `mcp.*` 管理面；**已连的服务器实例继续运行**（工具仍可用）。
- **卸载子插件**（`plugins.remove`）= 从插件中心清单移除；若想彻底清空，请先逐个 `mcp.remove` 删除服务器，再卸载。
- 本包**不受保护**——能正常被插件中心操作；主插件 `dsh-plugin-center` 才受保护。

## 安全

- 仅接受 POST；无 Origin 的非浏览器客户端放行，跨站浏览器请求拒绝(403)。
- 可选令牌：`config.token` 或环境变量 `DSH_MCP_ADMIN_TOKEN`，请求带 `x-dsh-mcp-token: <token>`。
- 请求体上限 1 MiB。

## 自检 / 发布

```sh
node --check lib/index.js
node --test test/protocol.test.mjs          # 契约测试
node test/smoke-live.mjs                     # 免重启运行时冒烟(mock ctx)
npm pack && dsh plugin --profile <scratch> add -w ./dsh-mcp-admin-0.2.1.tgz
npm publish
```

零依赖（js-yaml 在 `vendor/`），`files` 已限定 `lib` + `vendor` + `cordis.patch.yml` + README。
