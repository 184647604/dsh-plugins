# dsh-plugins

DeepSeek Harness 插件集。装到**任意** `dsh web` 后端上即可用。

## 四个插件的关系

```
dsh-bridge-center   ← 管理桥（受保护、常驻）
    │  plugins.list / setEnabled / remove
    │  center.describe / center.catalog
    ├─ dsh-mcp-admin      ← 子插件（普通、可启停/卸载）
    │     mcp.list / add / update / remove / setEnabled / restart
    ├─ dsh-file-transfer  ← 子插件（普通、可启停/卸载）
    │     transfer.write / describe / list / archive
    └─ dsh-ssh-link       ← 子插件（普通、可启停/卸载）
          ssh.targets / test / exec / pair / discover / keys / doctor…
```

**只有 `dsh-bridge-center` 是必装的**——它是唯一的管理桥，装上之后另外三个（以及以后所有的子插件）
都可以由它统一安装/启停/卸载。子插件都是**零运行时依赖**的，`dsh-mcp-admin` 自带 vendored 的 js-yaml。

⚠️ `dsh-ssh-link` **原名 `dsh-ssh-bridge`**，2026-09 改名：那个名字在 npm 上是**别人的**
OpenWRT 路由器 SSH 桥，裸包名安装会静默装上别人的代码。

## 安装

先决条件：目标主机有 `node >= 18` 和 **`pnpm`**（`dsh plugin add` 是把参数转发给 pnpm 的）。

```sh
# 管理桥（必装）
dsh plugin --profile web add \
  https://github.com/184647604/dsh-plugins/releases/download/v0.1.8/dsh-bridge-center-0.1.7.tgz

# 子插件（按需）
dsh plugin --profile web add \
  https://github.com/184647604/dsh-plugins/releases/download/v0.1.8/dsh-mcp-admin-0.2.1.tgz

dsh plugin --profile web add \
  https://github.com/184647604/dsh-plugins/releases/download/v0.1.8/dsh-file-transfer-0.2.0.tgz
```

装完**重启一次 `dsh web`**（首次要靠 profile 的 bundle 层把它带起来）。之后的启停/卸载**免重启**。

## ⚠️ 一律用完整 release URL，不要用裸包名

管理桥**原名 `dsh-plugin-center`**。npm 上早就存在一个**同名的别人的包**（作者 `gh503`，
2026-08-22 发布）——那是一个**客户端**插件（在设置页加一张卡片、搜 npm 上的 dsh 插件），
和本仓库的**服务端管理桥**完全不是一回事。执行不带 URL 的
`dsh plugin add dsh-plugin-center` 会装上他的包，而且不会报错。

正因为这个坑，2026-09 把管理桥**改名为 `dsh-bridge-center`**（npm 上未被占用，已核实）。
**改名从 v0.1.8 起生效**：旧名只出现在 v0.1.7 及更早的 release 里。

装本仓库的包**一律带上完整的 release URL**。

## 为什么用 tarball URL 而不是 `git+https://...`

本仓库是**四个包并列的 monorepo**，仓库根目录没有 `package.json`。
`dsh plugin add git+https://github.com/184647604/dsh-plugins.git` 指向的是仓库根，
不是一个可安装的包，**会失败**。用 release 挂出来的 `.tgz` 是每个包独立、版本固定、内容不可变的产物。

## 从源码更新

改完插件后，在项目根目录跑：

```sh
tools/publish-plugins.sh
```

它会重新镜像四个插件、打包、提交、推送，并把新版本的 tgz 传成 release 资产。

## License

MIT
