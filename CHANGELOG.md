# Changelog

## 0.4.0 — 2026-10-15
- 新增 ?ids=a,b,c 精确重载变化行（客户端据 /health.graph 的 rev 差分）
- 版本闸门：仅宿主 >= 0.4.0 才发 ?ids（旧宿主会把未知参数当未指定而整图重载）
- /health 暴露 graph 与 applies；门达 19 项（含「H 客户端入口契约」断言）
- **同日补充（不改版本号，运行代码未变）**：包元数据补 repository / homepage / bugs；新增本 CHANGELOG；加 preflight CI
- **同日补充之二（不改版本号，运行代码未变）**：新增 `SKILL.md`（技能入口文件：真实版本号 / 「宿主半体热刷新无效、只能预检后重启」这张对照表 / 真实边界），与本机技能树副本逐字同文；并加 Gitee 镜像远端

## 0.3.0
- 整图重载护栏（必须显式 ?all=1）、applies 重放计数、headless 静默退出、入口薄化
