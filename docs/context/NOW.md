# NOW

本文件：当前目标、验收标准、进展、阻塞、下一步和证据入口。修改类和接续任务时读；状态实质变化时，以及每个任务结束、被中断或交接前更新。保持约 100 行以内。

## 当前目标

第 1a 阶段的实现（[PLAN.md](../PLAN.md) §15“1a：核心闭环”）。分工不变：dsh 写代码，Claude 检查验收。派给 dsh 的任务一律按 [RUNBOOK.md](RUNBOOK.md)“派发 dsh 任务”执行。

1a 的技术验证（PLAN.md §15 表格、§17）已于 2026-10-23 全部完成并回填 PLAN.md；遗留的验证：Desktop 里插件相关的几项并入 T20（1b），Windows 的部分放到第 2 阶段。

## 验收标准

1a 实现的分步计划和各步验收标准尚未起草；产品验收见 PLAN.md §15“验收”表（T1–T26）。

## 进展

- 2026-10-23 建立基础文档和根目录 `CLAUDE.md`（只含导入行 `@AGENTS.md`）。【已验证】2026-10-23：文档检查见 [RUNBOOK.md](RUNBOOK.md)“文档维护”，`claude -p` 实测新会话能加载 AGENTS.md（[RISKS.md](RISKS.md) R4）。用户验收：尚未进行。
- 2026-10-23 第 0 阶段完成：dsh 实现、Claude 验收，8 条全部通过，三平台 CI 通过（[history/2026-10-23-phase0.md](history/2026-10-23-phase0.md)）。用户验收：尚未进行。
- 2026-10-23 仓库清理了本机信息；PLAN.md 随仓库公开（[DECISIONS.md](DECISIONS.md)）。
- 2026-10-23 1a 技术验证完成，结论均经用户审阅 diff 后回填 PLAN.md，实验和报告在 [experiments/1a/](../../experiments/1a/REPORT.md)。用户验收：尚未进行。
  - 第 1 批（§17 第 1、2、3、6、7、12、18 项，dsh 做）：8 条全部通过（[history/2026-10-23-1a-batch1.md](history/2026-10-23-1a-batch1.md)）。
  - Claude 侧（§17 第 8、16、17 项）：完成；Desktop 插件部分推迟到 T20（[history/2026-10-23-1a-claude-side.md](history/2026-10-23-1a-claude-side.md)）。
  - 第 2 批（§17 第 4 项，dsh 做，真实模型）：6 条全部通过（[history/2026-10-23-1a-batch2.md](history/2026-10-23-1a-batch2.md)）。
  - 主要设计变化：`agent-collab` 预设整份复制 `standard`；dsh 执行端防套娃变量为 `DSH_AGENT_COLLAB_ROLE`；更新插件要重启 dsh Web；命令带 `agent-collab:` 前缀；桥接只观察审批和提问（[DECISIONS.md](DECISIONS.md)）。
- 2026-10-23 文档整理：R6 隔离要求移到 RUNBOOK 作为长期操作规程；第 2 批记录归档。

## 阻塞与待核实

- 【待核实】`package.json` 写了 `"license": "MIT"`，但 LICENSE 文件还没建；版权人署名需用户提供（PLAN.md §7.1、§18）。
- 【待核实】PLAN.md §3 中 D1–D19 的确认人（见 [DECISIONS.md](DECISIONS.md)）。
- 【待核实】本次文档结构（MAP 并入 PROJECT_INDEX.md，RISKS 和 DECISIONS 独立）是 AI 采用的方案，待用户认可。

## 下一步

1. Claude 起草 1a 实现的分步计划、各步验收标准和第一份任务书，给用户审阅。
2. 可选：把 CI 里的 `actions/checkout`、`actions/setup-node` 升到面向 Node 24 的新版本，消除弃用警告。
3. 每次提交和推送都须用户授权。

## 证据入口

- 阶段计划与验收标准：PLAN.md §15；待确认点：PLAN.md §17
- 技术验证实验和报告：[experiments/1a/REPORT.md](../../experiments/1a/REPORT.md)
- 操作和验收方法：[RUNBOOK.md](RUNBOOK.md)
- 归档：[history/README.md](history/README.md)
