# dsh-hot-refresh（面板一键热刷新）

把 DSH **官方的客户端插件热重载链路**做成面板上的一键入口：客户端插件改完不必按 F5。

## 逆向来源（本机 `app.asar`，均为官方包，MIT）

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-client-hmr` v0.2.0-rc.2 | 宿主半体每 `pollIntervalMs`（默认 **500ms**）stat 轮询每个客户端 bundle 的 `{mtimeMs, ctimeMs, size}`；一变就 `ctx.clientModules.rebuilt(id)`，并经 SSE **`/plugins/events`** 推 `rebuilt` 帧。浏览器半体订阅该 SSE，收到帧就交给客户端模块系统。 |
| `@deepseek-ai/dsh-client-modules` | 浏览器侧模块表：`invalidate → prefetch → refresh`，`ctx.modules.entries.sync(graph)` 全量同步、`entries.reload(id, rev)` 单条就地重载。 |
| `@deepseek-ai/dsh-hmr` | 宿主侧热重载（模块替换 / Include 刷新 / profile 配置变更共用一个串行队列）。文档明写：**「直接通过 Plugin Manager 发起的操作无需等待文件事件即可应用」**。 |

## 本插件做什么

- `POST /hot-refresh/reload?id=<rowId>`：直接调 `clientModules.rebuilt(id)` —— **立即推帧**，不必等 500ms 轮询、也不必先改文件。
- `POST /hot-refresh/reload?ids=a,b,c`（**v0.4.0**）：**精确重载一小组行**。客户端记住"上次见过的每行 rev"，据 `/health.graph` 差分出自上次后**变了的那几个** ⇒ 按钮显示「⟳ 热刷新 · N 个已变」并**只重载它们**（常用情况下不必整图重载、不丢整图 React 状态）。含未知 id ⇒ **503 且一条都不重载**（先校验后执行）；`?ids=` 为空 ⇒ 400 `need-explicit-all`（空列表不得被当成"全部"）。
- `POST /hot-refresh/reload?all=1`：整图重载（会丢所有插件的 React 状态）——**必须显式**，否则 400 并告知影响面（行数）。
- `GET /hot-refresh/health`：只读自检（`clientModules` 是否可用、图里有多少行、`graph:[{id,rev}]`、`applies` 重放计数、最近客户端自报）。
- `POST /hot-refresh/report`：客户端自报（按过没有、成没成、宿主是哪个版本）。
- 面板入口：**设置旁边的「⟳ 热刷新」**（`sidebar.footer.action`；有变化＝只重载变化行；无变化＝首点待确认、5 秒内再点＝整图重载）· **插件详情页头部的「⟳ 就地重载」**（`plugins.detail.actions`，单行即时）。

### 兼容闸门（v0.4.0）

客户端**只在宿主版本 ≥ 0.4.0 时**才发 `?ids=`。理由：旧宿主（例如仍在跑的 0.1.0）**不认识该参数，会退回"整图重载"**，等于一声不响把整页状态抹掉。旧宿主下客户端继续走"二次确认 + `?all=1`"的老路（对旧宿主是显式意图）。版本比较按**数值段**（`0.10.0 > 0.9.0`），空/未知版本一律视为更旧（安全侧）。

本插件**不自己实现模块替换**（那会与官方机制打架），只负责触发与可观测。


## 已知边界（官方文档明写 + 本机实测）

### 本机实测（2026-10-15，两次对照）

| 场景 | 结果 |
|---|---|
| **新装**本插件（`install_bundle link:…`） | **宿主半体当场生效**（`/health` 200 · `clientModules:true` · 图 86 行），**未重启** |
| **改已装插件**的 `lib/client.js` | **客户端半体自己热更**（500ms stat → `rebuilt` 帧 → 就地替换），未刷新页面 |
| **改已装插件**的 `lib/index.js`（宿主）后**停用+启用**（`set_bundle`，两次 `application: applied`） | **仍是旧代码**（`/health` 照旧旧版本号；连新增的 `entry`/`applies` 字段都没有）⇒ **宿主半体换不上** |
| 同上，再把入口**换文件名**并改 `exports`（换 URL）后停用+启用 | **仍是旧代码** ⇒ Node ESM 按 URL 缓存 + toggle 不重新导入，换文件名也没用 |

⇒ **结论**：**客户端半体的代码变更可热更；宿主半体的代码变更在本机需要重启 App。** 本插件只把"客户端热更"做成按钮，不去伪装能热换宿主。
（`lib/index.js` 保留了"按 package.json 版本号动态导入 `lib/host/impl.js`"的薄入口：它不改上述结论，只是**保险** —— 将来任何会重新导入入口的组合路径都能自动拿到新版实现；版本没变则命中缓存，不会重复注册。）

### 对照社区成熟实现（`dshmarket` v1.66.8，本机 `node_modules/dshmarket`）

- 它对"一键安装"的承诺原话是「**多数插件刷新页面即可用，无需重启**」—— 社区语境里的"装完就能直接刷新"指的是**刷页面**，不是宿主热重载。
- 它的**热禁用/启用**是往 profile 的 `cordis.patch.yml` 写 `- id: …` + `disabled: true|false`，靠 **DSH 的 HMR 约 1 秒内重新组合**（机制移植自 [dsh-plugin-hub](https://github.com/Noob-stupid/dsh-plugin-hub)）——**这不是"重新导入已加载的模块"**，所以它同样换不掉已装插件的宿主代码。
- 对真正换不掉的变更，它给的是**一键重启**（`POST /dsh-market/restart`，仅本机同源；`lib/restart.js` 会重放原入口/参数/环境/工作目录，`lib/recovery.js` 提供"重启没起来"时的恢复页）。但它**在受监督宿主上自动隐藏该按钮**（systemd 主进程、被调试进程等）——**本机是桌面外壳（受监督宿主）**，一键重启不适用，必须由用户关窗再开。
- 它的插件目录来自社区精选表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

### 其它官方限制

- **替换已安装包的版本**仍需要重启（"包安装在该队列之外执行"）。
- 重载是**粗粒度**的：被重载插件内的 React 状态会丢失（数据层不受影响）。

## 安装

```
plugin_manager install_bundle  link:E:\DeepSeek\skills\hot-refresh\bundle
plugin_manager set_bundle      target=dsh-hot-refresh  enabled=true
```

升级前先跑门：`node _preflight.cjs`（14 项：包元数据 / 版本一致 / 薄入口契约 / 语法 / 客户端形状 / 路由注册 / health / 整图护栏 / 单行 / 显式整图 / 未知 id / apply 重放 / 敌意 ctx）。
