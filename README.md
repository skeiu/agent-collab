# agent-collab

本文件：项目用途、基本使用方式和文档入口。了解或使用项目时读；实际能力和使用方式变化时更新。

## 用途

让多个编程代理分工协作：设计端（主控）读代码、写任务书、派发、审查改动并汇报；执行端按任务书改代码、跑测试、按格式汇报。计划做成 Claude Code 插件，执行端支持 dsh、codex、claude 三种并可在配置中切换，面向 Linux 和 Windows（macOS 尽量支持）。完整目标和不做的事见 [docs/PLAN.md](docs/PLAN.md) §1。

## 当前状态

设计已定稿；第 0 阶段（仓库、测试和构建脚本、CI）已完成，产品功能尚未实现（2026-10-23）。开发命令见 [docs/dev-setup.md](docs/dev-setup.md)。当前进展见 [docs/context/NOW.md](docs/context/NOW.md)。

## 使用方式

暂无（尚未实现）。规划中的入口是 Claude Code 里的 `/collab <需求>`、`/collab-setup`、`/collab-config`（PLAN.md §8、§14）；实际命令名以 PLAN.md §17 第 8 点的确认结果为准。

## 文档入口

- [PROJECT_INDEX.md](PROJECT_INDEX.md)：“任务 → 文件或章节”路由
- [AGENTS.md](AGENTS.md)：AI 协作规则与项目特有约定
- [docs/PLAN.md](docs/PLAN.md)：设计方案（权威）
- [docs/context/NOW.md](docs/context/NOW.md)：当前目标与进展；同目录下有 RUNBOOK、DECISIONS、RISKS 和 history/

## 许可

规划为 MIT（PLAN.md §7.1、§18）；LICENSE 文件尚未建立。
