# Changelog

## 0.4.1 — 2026-10-15
- 包元数据补 repository / homepage / bugs
- 新增本 CHANGELOG

## 0.4.0 — 2026-10-15
- 新增 ?ids=a,b,c 精确重载变化行（客户端据 /health.graph 的 rev 差分）
- 版本闸门：仅宿主 >= 0.4.0 才发 ?ids（旧宿主会把未知参数当未指定而整图重载）
- /health 暴露 graph 与 applies；门达 19 项（含 H 客户端入口契约）

## 0.3.0
- 整图重载护栏（必须显式 ?all=1）、applies 重放计数、headless 静默退出、入口薄化
