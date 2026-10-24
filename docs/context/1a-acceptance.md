本文件：第 1a 阶段产品验收（S6）逐项记录 PLAN.md §15 的 1a T 编号：验证方法、结果、日期和发现的问题。做 S6 时读；每验一项更新。T 编号的定义以 PLAN.md §15“验收”为准，这里不复制。

> 状态：2026-10-25 凌晨由 Claude 在用户授权下进行（用户原话“允许你装桥接并模拟真实操作”，见 [DECISIONS.md](DECISIONS.md)“项目决策”）。结论标【已验证】的是 Claude 的验证；用户验收尚未进行。

## 环境

- 用户日常的 dsh Web（dsh 0.2.1-rc.2，web profile），2026-10-25 01:02 由 Claude 装上桥接：`npm run build` 打出 `dsh-bridge-0.0.0.tgz`，复制到 `~/.agent-collab/bridge/`（profile 的 `package.json` 记的是 tgz 的路径，放在临时目录里会在清理后失效），再 `dsh plugin --profile web add <该路径>`。pnpm 由 corepack 临时提供。运行中的 Web 热加载了桥接，发现文件立即出现。装前 profile 的 `package.json`、`cordis.patch.yml` 已备份到 Claude 的临时目录。
- 被测仓库：系统临时目录下新建的 git 仓库（`README.md`、`math.mjs`，一次初始提交）。`AGENT_COLLAB_HOME` 用默认的 `~/.agent-collab`。模型：Web 的默认模型（真实模型）。
- 设计端一侧：Claude 直接运行 `bin/collab.mjs`，任务书和问题单按 skill 的模板手写；人在 dsh Web 里的操作由 Claude 在内置浏览器里做。

## 逐项结果

| T | 方法 | 结果 |
|---|---|---|
| T1 | 临时仓库里 `collab doctor --designer claude` | 通过【已验证】2026-10-25：九项全部 OK（dsh Web 在运行、桥接在线、协议 1、`agent-collab` 预设可用），退出码 0 |
| T2 | `run start` 一个小任务（加 `subtract` 函数和测试），在 Web 侧栏里找会话 | 通过，有一处缺陷【已验证】2026-10-25：任务 14 秒 `done`，汇报合法；会话挂在该仓库的工作区下，预设显示 Agent Collab，“轨迹”能看到 7 步。缺陷：这个仓库原先没有工作区，桥接新建的工作区名字是任务标题 `[collab] T001 T2 加 subtract`，而不是目录名（见“发现的问题”2） |
| T3 | 续接 T001，要求执行端读写一个仓库外的文件；审批挂起超过卡死阈值（默认 15 分钟）后在 Web 里批准 | 通过【已验证】2026-10-25：执行端用 bash 读仓库外文件时申请把沙箱提到 `danger-full-access`，Web 里弹出审批卡片；`watch` 输出“审批 pending”“running → waiting_approval（等待审批）”。挂了 17 分 21 秒，期间 `state.json` 一直是 `waiting_approval`，没有判为 `stalled`。Claude 在 Web 里点“允许一次”后 `waiting_approval → running`，11 秒后第 4 轮 `done`，汇报合法；`summary.json` 的 `approvals` 记了这次审批（`outcome: allowed-once`，提出和决定的时间） |
| T4 | 待做：任务进行中在 Web 里插话 | — |
| T5 | T001 在 Web 里打开过之后，`run resume --kind correction` | 通过【已验证】2026-10-25：第 2 轮在同一个 dsh 会话里（`sessionId` 不变）完成，汇报合法，3 个测试通过 |
| T6 | 待做：`run cancel`；在 Web 里点停止 | — |
| T7、T8 | 集成脚本 `adapter-dsh.mjs` 的 I2、I3（临时 `DSH_HOME`、假 LLM） | 通过【已验证】2026-10-25（S4、S5 验收时重跑）；真实 Web 上未单独做 |
| T17 | 设计端一侧：环境里设 `AGENT_COLLAB_ROLE=executor` 或 `DSH_AGENT_COLLAB_ROLE=executor` 后 `run start` | 设计端一侧通过【已验证】2026-10-25：两种都被拒绝，`executor_role`，退出码 3。执行端 shell 里实际调用的情形待做 |
| T25 | T001 等待审批时，同一仓库再 `run start` | 运行时一侧通过【已验证】2026-10-25：`lock_held`，退出码 3，`data` 带 `runId: T001`、`status: waiting_approval`。skill 让用户选等待、接上或取消的部分待做 |
| T9–T10、T23–T24 | 待做 | — |
| T11、T13、T21 | 待做 | — |

## 发现的问题

1. **同一个 Web 进程里第二个任务建不了会话**（严重）。第二次 `run start` 失败，`statusReason` 为 `executor_error`，`worker.log`：`bash env key "DSH_AGENT_COLLAB_ROLE" is already owned by contributor "agent-collab-<第一个会话>"`。桥接每个会话注册一个 shell 环境提供者，dsh 规定一个键只能有一个提供者，第一个会话跑完后仍挂在 Web 里。后果：一个 Web 进程只能派一个任务，之后只能续接它。假 dsh 不检查这一点，集成测试只建过一个会话。修复任务书 [briefs/1a-bridge-multi-session.md](briefs/1a-bridge-multi-session.md)。修好后用户的 Web 要重启才能加载新桥接（更新已装的包不会热加载，PLAN.md §5.6）。
2. **新工作区以任务标题命名**（小）。原因：桥接把会话标题传给了 `workspaceRegistry.create(path, title)`。同一任务书一并修。
3. **dsh 的 workspace-write 允许不经审批写系统临时目录**（事实，不是缺陷）：T3 第一次让执行端写临时目录下的文件，write 工具直接写成功，没有审批；接着它用 bash 读这个文件时才弹审批，因为 bash 沙箱里的 `/tmp` 是独立的 tmpfs，看不到 write 工具写的文件。验收“越权写入弹审批”要选临时目录以外的目标。
4. 执行端的行为（正面）：问题单要求写仓库外文件、改 README，和原任务书的约束冲突时，执行端按任务书停下，汇报 `blocked` 并在 `open_questions` 写明要设计端决定什么；设计端用 `run resume --kind answer` 解除约束后继续。
5. **建会话失败后工作进程不退出**（中）。T002 因问题 1 失败后，它的工作进程 20 多分钟还在，连着桥接的端口；`run cancel` 后也不退。原因：`core/adapters/dsh.mjs` 的 `startBridge` 在 `newSession` 抛错时没关连接（`resume` 那条路径是关的）。并入 [briefs/1a-bridge-multi-session.md](briefs/1a-bridge-multi-session.md) 的缺陷三。
