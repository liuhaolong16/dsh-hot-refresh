---
name: dsh-hot-refresh
description: "DSH 面板一键热刷新：把官方客户端插件的热重载链路做成面板入口，客户端插件改完不必按 F5。含兼容闸门与整图重载护栏。当改的是客户端半体（界面/侧栏面板）想立刻见效时用它；改宿主半体无效——那类只能重启，且必须先过预检。"
version: 0.4.0
---

# dsh-hot-refresh · 面板一键热刷新（v0.4.0）

把 DSH **官方的客户端插件热重载链路**做成面板上的一键入口：**客户端插件改完不必按 F5**。

- **本文件放两处、内容一致**（避免第二份说法）：
  - 插件仓根：`github.com/liuhaolong16/dsh-hot-refresh`（**本仓根目录就是插件体**，代码在 `lib/`）
  - 本机技能树：`E:\DeepSeek\skills\hot-refresh\SKILL.md`（插件体在其下的 `bundle\`）
- **交付形态**：DSH 插件（`dsh plugin add github:liuhaolong16/dsh-hot-refresh`），MIT、npm-less

## 它救什么、不救什么（最关键的一条）

| 半体 | 热刷新是否有效 | 生效方式 |
|---|---|---|
| **客户端半体**（`lib/client.js` / 侧栏面板） | ✅ 有效 | 官方热重载通路，改完刷新即可 |
| **宿主半体**（`lib/index.js`、`lib/host/impl.js` / 工具、路由、上下文名） | ❌ **无效** | **只能重启宿主**；且重启前必须先过预检 |

实测依据：宿主半体**只在 DSH 启动时加载**——热重载、禁用再启用、卸载重装、删依赖声明四法全部无效（磁盘上新码与活工具的旧拒绝文案同时存在，即证明跑的是旧码）。

## 硬规矩：请求重启之前先过预检

```bat
:: 在插件仓根（= 本机技能树的 bundle\ 目录）里执行
node _preflight.cjs
:: 本机技能树等价写法： node E:\DeepSeek\skills\hot-refresh\bundle\_preflight.cjs
:: 退出码 0 = 可以安全重启；非 0 = 先修，别重启
```

预检覆盖：**兼容闸门（v0.4.0）** · 整图重载护栏 · 宿主侧防御 · 样式去重 · 握手上报 · `subjectId` 六输入 · 敌意 ctx。
负控（5 条，证明判据有区分力）：去掉整图护栏、去掉宿主防御、去掉样式去重、去掉握手上报、`subjectId` 失效。

## 已知边界（官方明写 + 本机实测）

- 热刷新**只管客户端半体**；宿主半体改动一律走「预检 → 重启」。
- 整图重载有护栏：不做全量重建，避免把面板整体刷掉。
- 只对**客户端插件**有意义；纯宿主型插件没有这条捷径。

## 自检

```bat
node _check-client.cjs      :: 客户端夹具（版本握手 / 幂等 / subjectId 六输入 / 敌意 ctx）
node _preflight.cjs         :: 14 项 · 全 PASS
```

本仓已配 CI：`.github/workflows/preflight.yml`（推上去即跑）。

## 相关

- 逆向来源（本机 `app.asar` 官方包，MIT）、兼容闸门与对照社区实现的差异：`README.md`（本机：`E:\DeepSeek\skills\hot-refresh\bundle\README.md`）
- 变更记录：`CHANGELOG.md` · 许可：`LICENSE`（MIT）
- 姊妹技能（引用层）：`github.com/liuhaolong16/dsh-quote-reply`
