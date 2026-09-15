# dsh-file-transfer

`dsh-bridge-center` 的**文件传输子插件**：给 dsh web 后端加一个原始字节写盘端点，
让客户端（AiChatbox Android App 的文件传输页）能把手机上的文件直接写进后端文件系统。

非保护插件 —— 插件中心可自由启停/卸载（受保护的只有管理桥本身与 `@deepseek-ai/*` 系统核心）。

## 为什么不用官方的 `/api/session/uploadFileBinary`

dsh 官方确实有一个流式上传端点，但它把字节交给 **attachment 服务**
（`ctx.attachments.saveFileStream`），而该服务用「逐级 fsync 到文件系统根」来证明持久性：

```js
ensureDurableHome(home) → ensureDurableDirectory(home, parse(home).root)
```

在 Termux 上，`DSH_HOME` 的祖先链是

```
/data/data/com.termux/files/home/.dsh → … → /data/data → /data → /
```

走到 `open("/data/data", O_RDONLY)` 时必然 **EACCES** —— `/data/data` 不给 Termux 应用读。
于是**任何**上传都以这个错误告终，且该行为**没有任何配置项可以限制**：

```
EACCES: permission denied, open '/data/data'
```

实测佐证：本机 `~/.dsh/attachments` 在该端点被调用前**根本不存在**，说明这个部署上
从未有过任何一次上传成功（Web 端自己的文件选择器也一样）。

本插件完全绕开 attachment 存储，直接把字节写到调用方指定的路径。

## 接口

### `POST /api/transfer.write?path=<绝对目录>&name=<文件名>`

- 请求体：**原始字节**，`Content-Type: application/octet-stream`
- 成功：`200 {"ok":true,"value":{"path":"…","name":"…","bytes":N}}`
- 失败：非 2xx，`{"ok":false,"error":{"code":"transfer/…","message":"…"}}`

行为与安全约束：

| 约束 | 说明 |
| --- | --- |
| 目标目录必须**已存在**的绝对目录 | 不会隐式建目录，避免打错路径就散落一堆空目录 |
| 文件名必须是纯文件名 | 含 `/`、`\`、`\0`、`.`、`..` 一律 **400 拒绝**（不做静默 basename 改写） |
| 先写 `.<name>.<uuid>.part` 再 `rename` | 上传中断不会留下「看起来完整」的同名文件，也不会毁掉旧文件 |
| 文件先 `fsync` 再 `rename` | 崩溃后不会出现指向未落盘数据的目录项 |
| `config.maxBytes`（默认 8 GiB） | 同时做 `content-length` 前置检查与流式计数 |
| `config.roots` 白名单 | 留空 = 允许任意绝对路径；填了就只允许其下 |
| POST + Origin 门禁 | 浏览器跨站请求被挡；非浏览器客户端（App）放行 |
| 可选 `config.token` | 设了就要求 `x-dsh-file-transfer-token` 头 |

### `POST /api/transfer.describe`

标准一元信封，用于探测「这个后端装了文件传输插件没有」：

```json
{"plugin":"dsh-file-transfer","version":"0.1.0","roots":[],"maxBytes":8589934592,
 "maxEntries":2000,"capabilities":["write","list"],
 "places":[{"label":"内部存储","path":"/storage/emulated/0"},
           {"label":"主目录","path":"/data/data/com.termux/files/home"}],
 "defaultRoot":"/storage/emulated/0","tokenRequired":false}
```

### `POST /api/transfer.list`

列举**后端上任意绝对目录**，标准一元信封，`payload` 为 `{"path":"<绝对目录>","limit"?:N}`：

```json
{"path":"/srv","entries":[{"name":"src","type":"directory"},
                       {"name":"main.rs","type":"file","size":1204}],
 "truncated":false}
```

条目形状与官方 `workspaceFiles/list` **完全一致**（`file` / `directory` / `other`，
文件带 `size`），所以客户端可以两条来源共用同一套解析。目录优先、再按名字排序。

#### `places`：列举该从哪儿起步

`list` 接受绝对路径，但**没有**一个天然的根可以当入口 —— 而且入口形态随系统完全变化：

| 系统 | 入口 |
| --- | --- |
| Windows | `C 盘` `D 盘` …（探测 A:–Z:，A:/B: 是软驱故跳过） |
| Android | `内部存储` = `/storage/emulated/0`；外置卡 = `/storage/<UUID>`（从 `/proc/mounts` 认） |
| Linux | `/mnt/*`、`/media/<user>/*`、`/` |
| macOS | `/Volumes/*`、`/` |

`describe` 因此回报 `places: [{label, path}]`，客户端渲染成下拉列表即可。
**每个候选都会真的 `readdir` 一次**，列不出来的直接剔除 —— 只判断「存在」是不够的：

```
⛔ /            EACCES          ✅ /storage/emulated/0    75 条
⛔ /data        EACCES          ✅ $HOME                  38 条
⛔ /data/data   EACCES
                                ⛔ /storage/emulated     ENOENT  ← 父目录不存在，子目录却能读
```

推荐一个点进去就报错的入口，比不推荐更糟。同一个目录会按 `realpath` 去重
（`/sdcard` 与 `/storage/emulated/0` 是同一个地方，只留一个）。

`defaultRoot` 是兼容字段，等于 `places[0].path`。

注意逐级向上仍可能撞到不可读的祖先（`$HOME` 往上第二级就是 `/data/data`，EACCES），
客户端应当把这种情况当作**可恢复的错误**处理，而不是清空当前列表；
并且因为可读范围经常不连续，**必须**另外提供直接输入绝对路径的跳转。

#### 为什么需要它：官方接口是不对称的

`workspaceFiles` 的七个方法里，**只有 `list` 有边界检查**：

| 方法 | 边界 |
| --- | --- |
| `list` | 调 `confine()`，工作区外一律 `workspace-file/outside-workspace` |
| `read` / `readAll` / `readBytes` / `stat` / `readRelated` | 走 `locateFile()`，**无边界检查** |

上游源码里 `readBytes` 的注释就写着 *"files outside it are allowed"* —— 这是有意设计，
不是漏洞。但它导致一个尴尬的局面：工作区外的文件**读得到、却列不出来**。
你知道绝对路径就能下载，却永远发现不了。

`transfer.list` 补的就是「列举」那一半，让 App 能像文件管理器一样浏览整个后端。
用 `config.roots` 白名单可以把它收窄到指定目录。

注：符号链接**按目标类型**回报（`/sdcard` 这类链接否则会变成进不去的 `other`），
断链回报为 `other`。

## 安装

```bash
dsh plugin --profile web add dsh-file-transfer
```

或由 `dsh-bridge-center` 一键安装（见 `SUBPLUGIN_CATALOG`）。

## 测试

```bash
node --test dsh-file-transfer/test/transfer.test.mjs
```

不依赖 dsh 运行时：测试用真实 http server + 最小假 `ctx` 打真实请求，覆盖写入一致性、
路径穿越拒绝、roots 白名单、体积上限、原子覆盖、方法/Origin 门禁。
