# NOW

本文件：当前目标、验收标准、进展、阻塞、下一步和证据入口。修改类和接续任务时读；状态实质变化时，以及每个任务结束、被中断或交接前更新。保持约 100 行以内。

## 当前目标

第 1a 阶段的实现（[PLAN.md](../PLAN.md) §15“1a：核心闭环”）。分工不变：dsh 写代码，Claude 检查验收。派给 dsh 的任务一律按 [RUNBOOK.md](RUNBOOK.md)“派发 dsh 任务”执行。

1a 的技术验证（PLAN.md §15 表格、§17）已于 2026-10-23 全部完成并回填 PLAN.md；遗留的验证：Desktop 里插件相关的几项并入 T20（1b），Windows 的部分放到第 2 阶段。

## 验收标准

1a 实现分 S0–S6 七步，各步验收标准见 [1a-impl-plan.md](1a-impl-plan.md)；产品验收见 PLAN.md §15“验收”表（T1–T26）。

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
- 2026-10-23 1a 实现计划：7 个实现决定【已确认】用户 2026-10-23，已回填 PLAN.md 并登记 DECISIONS.md；S1 任务书定稿；S0 接口契约草稿完成（[1a-impl-plan.md](1a-impl-plan.md)“进展”）。

## 阻塞与待核实

- 2026-10-23 经用户授权推送 S1、S2（`176eb90`）。CI 在 Linux、macOS 通过；Windows 卡在 `tests/config.test.mjs`（`saveConfig` 改名抛 `EPERM` 后测试挂住），运行已由用户中断。修复（[briefs/1a-ci-windows-fix.md](briefs/1a-ci-windows-fix.md)）2026-10-24 验收通过【已验证】2026-10-24（见 [1a-impl-plan.md](1a-impl-plan.md)“进展”），同日经用户授权提交并推送（`2719951`）。CI 运行 40055863970：Linux、macOS 4 组通过；Windows 两组不再挂住，8 秒跑完，88 个用例只剩并发读写那个失败：改名重试约 1.1 秒用尽仍是 `EPERM`。第 2 轮修复（[briefs/1a-ci-windows-fix2.md](briefs/1a-ci-windows-fix2.md)，重试预算加到 10 秒）2026-10-24 验收通过【已验证】2026-10-24，同日经用户授权提交并推送（`a67780f`），CI 运行 40056577654 三平台 × Node 20/LTS 共 6 组全部通过【已验证】2026-10-24；S3 任务书同步加了“`state.json` 写入失败不退出”。

- 【待核实】`package.json` 写了 `"license": "MIT"`，但 LICENSE 文件还没建；版权人署名需用户提供（PLAN.md §7.1、§18）。
- 【待核实】PLAN.md §3 中 D1–D19 的确认人（见 [DECISIONS.md](DECISIONS.md)）。
- 【待核实】本次文档结构（MAP 并入 PROJECT_INDEX.md，RISKS 和 DECISIONS 独立）是 AI 采用的方案，待用户认可。

## 下一步

1. S1 完成：AC1–AC9 和返工 RW1–RW7 全部通过【已验证】2026-10-23（证据见 [1a-impl-plan.md](1a-impl-plan.md)“进展”）。用户验收：尚未进行。2026-10-23 经用户授权提交，未推送。
2. S0 接口契约 [docs/protocol.md](../protocol.md) 用户审阅原样通过【已确认】用户 2026-10-23，出入已回填 PLAN.md；之后补的 `run start --designer`、`--designer-model` 也已同意【已确认】用户 2026-10-23。S2、S3 任务书定稿（[briefs/1a-s2-bridge.md](briefs/1a-s2-bridge.md)、[briefs/1a-s3-runtime.md](briefs/1a-s3-runtime.md)），按 S2、S3 的顺序派发，一步验收完再派下一步；每次派发前 Claude 先记核对基准。S2 完成：返工 RW1–RW5 全部通过【已验证】2026-10-23（证据见 [1a-impl-plan.md](1a-impl-plan.md)“进展”），用户验收尚未进行；2026-10-23 经用户授权提交，同日推送。S2 发现的 PLAN.md、protocol.md 回填已通过【已确认】用户 2026-10-23。S3 2026-10-24 派发（基准存在本机 `.git/agent-collab-baselines/s3-baseline.txt`，不进仓库），同日交付；验收未通过：功能主体可用，但测试偶发卡死、仓库锁并发时可被两个任务同时拿到、`run cancel` 会覆盖已停下任务的终态等 9 处要返工（证据见 [1a-impl-plan.md](1a-impl-plan.md)“进展”）。返工（[briefs/1a-s3-rework.md](briefs/1a-s3-rework.md)）同日派发并验收通过，RW1–RW10 全部通过【已验证】2026-10-24（证据见 [1a-impl-plan.md](1a-impl-plan.md)“进展”），未提交；protocol.md、PLAN.md §7.1 和 §11.3、dev-setup.md 的回填用户审阅后原样通过【已确认】用户 2026-10-24；两个低风险问题记为 [RISKS.md](RISKS.md) R9、R10。2026-10-24 经用户授权提交并推送（`ba4c802`）。CI 运行 40065381813：Linux 两组、macOS Node 20 通过；Windows 两组和 macOS LTS 在 `node --test` 失败。用户提供日志后分析：3 个产品缺陷（同一任务可能开出第二个执行端会话、`run wait` 返回时 `summary.json` 可能还没写、续接和接上后不重置卡死计时）和 2 个测试问题，Claude 本机复现了前三个。修复任务书 [briefs/1a-s3-ci-fix.md](briefs/1a-s3-ci-fix.md) 依据的 protocol.md §5.3、§5.5 修改【已确认】用户 2026-10-24；2026-10-24 派发并交付。验收部分通过：FX1、FX3–FX6 通过，FX2 的用例抓不住单独一处修复；更重负载下“杀掉再接上”的用例大量记成 `report_invalid`（假执行端两条路径的最终文字不一致）、run-lock 的 `lock_held` 用例依赖时序；审阅发现收尾期间到达的事件会让终态先于 `summary.json` 落盘（证据见 [1a-impl-plan.md](1a-impl-plan.md)“进展”）。返工任务书 [briefs/1a-s3-ci-rework.md](briefs/1a-s3-ci-rework.md) 依据的 protocol.md §5.3、§5.5、§6 补充【已确认】用户 2026-10-24；2026-10-24 派发并交付（派发前基准 `.git/agent-collab-baselines/s3cr-baseline.txt`）。从这一轮起 Claude 在内置浏览器里操作 dsh Web 派发和读汇报（[RUNBOOK.md](RUNBOOK.md)“Claude 在内置浏览器里派发”）。验收部分通过：CR1–CR3、CR5–CR7 通过；CR4 的 `run wait` 用例抓不住只撤回那处修复（修复本身经探针确认正确），RW9 的断言比原意宽（证据见 [1a-impl-plan.md](1a-impl-plan.md)“进展”）；dev-setup.md 已回填新增测试变量。补这两处测试的任务书 [briefs/1a-s3-ci-rework2.md](briefs/1a-s3-ci-rework2.md) 2026-10-24 派发并交付（基准 `.git/agent-collab-baselines/s3cr2-baseline.txt`），验收通过：RC1–RC4 全部通过【已验证】2026-10-24（证据见 [1a-impl-plan.md](1a-impl-plan.md)“进展”）。2026-10-24 经用户授权提交并推送（`1f346cb`）。CI 运行 40087121759：5 组通过，Windows Node 20 有 2 个用例失败：
  - 抢旧锁的测试读锁时撞上 Windows“删除中”的文件，得到 `EPERM`；
  - `run resume` 那条用例的第一轮记成了 `failed`，CI 没有输出 `worker.log`，原因不明。

  修复任务书 [briefs/1a-s3-ci-winlock.md](briefs/1a-s3-ci-winlock.md) 和它依据的 protocol.md §5.2“正在删除的文件”一条【已确认】用户 2026-10-24；2026-10-24 由 Claude 在 dsh Web 派发（基准 `.git/agent-collab-baselines/s3wl-baseline.txt`），同日交付，验收通过：WL1–WL5 全部通过【已验证】2026-10-24（证据见 [1a-impl-plan.md](1a-impl-plan.md)“进展”）；dev-setup.md 已回填；未提交。遗留：`run cancel` 结束工作进程那条路径没有处理 `lock_unreadable`，留到下一轮。返工前第 8、9 条（`attach` 时本轮已结束要带回结果、对停下的任务允许 `run cancel`）【已确认】用户 2026-10-24，已先改 protocol.md §3、§5.5、§6 和 PLAN.md §11.3。返工派发前基准已记（`.git/agent-collab-baselines/s3rw-baseline.txt`）。
3. P15（Windows 桌面版探针，PLAN.md §17 第 15 项）：任务书 [briefs/1a-p15-desktop-windows.md](briefs/1a-p15-desktop-windows.md) 已定稿，待用户派发给 dsh；dsh 交付、Claude 核对空跑后，Windows 上由那台机器的 Claude Code 按 README 执行，这边的 Claude 对照结果文件验收。
4. 可选：把 CI 里的 `actions/checkout`、`actions/setup-node` 升到面向 Node 24 的新版本，消除弃用警告。
5. 每次提交和推送都须用户授权。

## 证据入口

- 阶段计划与验收标准：PLAN.md §15；待确认点：PLAN.md §17
- 技术验证实验和报告：[experiments/1a/REPORT.md](../../experiments/1a/REPORT.md)
- 操作和验收方法：[RUNBOOK.md](RUNBOOK.md)
- 归档：[history/README.md](history/README.md)
