本文件：第 1a 阶段产品验收（S6）逐项记录 PLAN.md §15 的 1a T 编号：验证方法、结果、日期和发现的问题。做 S6 时读；每验一项更新。T 编号的定义以 PLAN.md §15“验收”为准，这里不复制。

> 状态：2026-10-25 凌晨由 Claude 在用户授权下进行（用户原话“允许你装桥接并模拟真实操作”，见 [DECISIONS.md](DECISIONS.md)“项目决策”）。结论标【已验证】的是 Claude 的验证；用户验收尚未进行。

## 环境

- 用户日常的 dsh Web（dsh 0.2.1-rc.2，web profile），2026-10-25 01:02 由 Claude 装上桥接（01:49 换成修好多会话的 `d53f0ab` 版本：tgz 换了文件名放在同一目录，`dsh plugin --profile web add` 重新安装，然后按 PID 结束旧 Web、在家目录用同样的命令重新启动，见下文“重启”）：`npm run build` 打出 `dsh-bridge-0.0.0.tgz`，复制到 `~/.agent-collab/bridge/`（profile 的 `package.json` 记的是 tgz 的路径，放在临时目录里会在清理后失效），再 `dsh plugin --profile web add <该路径>`。pnpm 由 corepack 临时提供。运行中的 Web 热加载了桥接，发现文件立即出现。装前 profile 的 `package.json`、`cordis.patch.yml` 已备份到 Claude 的临时目录。
- 被测仓库：系统临时目录下新建的 git 仓库（`README.md`、`math.mjs`，一次初始提交）。修好多会话之后另建 4 个同样的仓库（r1–r4）同时派发；这些任务用的运行时是 `d53f0ab` 的代码快照，桥接是同一提交打的包。`AGENT_COLLAB_HOME` 用默认的 `~/.agent-collab`。模型：Web 的默认模型（真实模型）。
- 设计端一侧：Claude 直接运行 `bin/collab.mjs`，任务书和问题单按 skill 的模板手写；人在 dsh Web 里的操作由 Claude 在内置浏览器里做。

## 逐项结果

| T | 方法 | 结果 |
|---|---|---|
| T1 | 临时仓库里 `collab doctor --designer claude` | 通过【已验证】2026-10-25：九项全部 OK（dsh Web 在运行、桥接在线、协议 1、`agent-collab` 预设可用），退出码 0 |
| T2 | `run start` 一个小任务（加 `subtract` 函数和测试），在 Web 侧栏里找会话 | 通过，有一处缺陷【已验证】2026-10-25：任务 14 秒 `done`，汇报合法；会话挂在该仓库的工作区下，预设显示 Agent Collab，“轨迹”能看到 7 步。缺陷：这个仓库原先没有工作区，桥接新建的工作区名字是任务标题 `[collab] T001 T2 加 subtract`，而不是目录名（见“发现的问题”2） |
| T3 | 续接 T001，要求执行端读写一个仓库外的文件；审批挂起超过卡死阈值（默认 15 分钟）后在 Web 里批准 | 通过【已验证】2026-10-25：执行端用 bash 读仓库外文件时申请把沙箱提到 `danger-full-access`，Web 里弹出审批卡片；`watch` 输出“审批 pending”“running → waiting_approval（等待审批）”。挂了 17 分 21 秒，期间 `state.json` 一直是 `waiting_approval`，没有判为 `stalled`。Claude 在 Web 里点“允许一次”后 `waiting_approval → running`，11 秒后第 4 轮 `done`，汇报合法；`summary.json` 的 `approvals` 记了这次审批（`outcome: allowed-once`，提出和决定的时间） |
| T4 | 续接 T001（`--kind answer`，`correction` 已到上限 2 轮，`run resume` 按规定拒绝，退出码非 0、`round_limit`），让执行端先跑 90 秒的命令；命令运行中在 Web 的会话里发一条插话（把除零的异常从 RangeError 改成 TypeError） | 通过【已验证】2026-10-25：`summary.json` 的 `humanInputs` 有一条 `{at, turn: 5, text}`，汇报的 `human_inputs` 写了处理方式，代码确实改成了 TypeError，5 个测试通过。过程（dsh 的事实）：dsh Web 把运行中发来的消息排到“下一轮”（会话日志 `agent/inbox/spliced` 的 `target: next-turn`），执行端这一轮看不到；这一轮结束（`turn_end`，汇报 `done`）后 dsh 立即用插话开下一轮，桥接转出 `human_message`（`source: dsh-web-human`），工作进程没有在第一个 `turn_end` 收尾，而是接着跟完人开的这一轮，以最后一份汇报为准，全部记在第 5 轮里 |
| T5 | T001 在 Web 里打开过之后，`run resume --kind correction` | 通过【已验证】2026-10-25：第 2 轮在同一个 dsh 会话里（`sessionId` 不变）完成，汇报合法，3 个测试通过 |
| T6 | r3：任务执行 `sleep 300` 时 `run cancel`；再派一个，执行中在 Web 会话里点停止按钮 | 通过【已验证】2026-10-25：前者 `cancelled`（“设计端要求取消”），这一轮 `endReason: aborted`、`stoppedBy: client`；后者 `stopped_by_human`（“用户在 dsh Web 里停止了任务”），`stoppedBy: human` |
| T7、T8 | 集成脚本 `adapter-dsh.mjs` 的 I2、I3（临时 `DSH_HOME`、假 LLM） | 通过【已验证】2026-10-25（S4、S5 验收时重跑）；真实 Web 上未单独做 |
| T17 | 设计端一侧：环境里设 `AGENT_COLLAB_ROLE=executor` 或 `DSH_AGENT_COLLAB_ROLE=executor` 后 `run start`；执行端一侧：r1 的任务书让执行端在自己的 shell 里打印这个变量、再调用 `collab run start` | 通过【已验证】2026-10-25：设计端一侧两种都被拒绝，`executor_role`，退出码 3；执行端 shell 里 `DSH_AGENT_COLLAB_ROLE=executor`，调用 `run start` 得到 `executor_role`、退出码 3。r4 续接一轮（同一个 Web 进程）时变量仍在。2026-10-25 02:13 Claude 再次按 PID 重启用户的 Web（这次加了 `--no-open`）后续接 r1 的 T002，执行端 shell 里 `role=`（空）：Web 重启后续接时防套娃失效【已验证】，修复任务书 [briefs/1a-fix4-env-resume.md](briefs/1a-fix4-env-resume.md)。第四份修复（`e0364bd`）装进用户的 Web 后重测通过【已验证】2026-10-25：新仓库 r6 的任务第 1 轮 `role=executor`，桥接写出会话环境文件（目录 0700、文件 0600）；按 PID 重启 Web 后 `run resume --kind correction` 一轮 `role=executor`；再重启一次后由 Claude 扮演人在 Web 里直接对这个会话发消息（没有工作进程连着桥接），`role=executor` |
| T25 | T001 等待审批时，同一仓库再 `run start` | 运行时一侧通过【已验证】2026-10-25：`lock_held`，退出码 3，`data` 带 `runId: T001`、`status: waiting_approval`。skill 一侧通过【已验证】2026-10-25：r3 有任务 T003 在跑时用 `claude -p`（Haiku）调用 `/agent-collab:collab`，它停下说明 T003 在运行，让用户选等待、接上或取消，并说明不会擅自取消。同一次输出里它误说“math.mjs 不存在”（文件在），属于模型读错，和锁无关 |
| T9 | r2：任务书要求第一次汇报只写一句普通文字，收到重发要求后再正常汇报 | 修复后通过【已验证】2026-10-25：用第三轮修复后的代码重跑（r2 的 T002），第 1 轮 `report_invalid` → 自动续接要求重发（`counts.resend: 1`）→ 第 2 轮汇报合法 → `done`。修复前的第一次：第 1 轮判 `report_invalid`（没有 json 代码块）后运行时在同一个工作进程里自动续接一轮要求重发（`counts.resend: 1`，`prompt-2.md` 写明错误类型和要求），这一部分符合；但执行端第 2 轮给出的合法汇报被判“JSON 不合法”，任务停在 `report_invalid`。原因是重发那一轮汇报文字被拼了两遍（见“发现的问题”7） |
| T10 | r1：`--protected README.md`，任务书要求改 README | 通过【已验证】2026-10-25：`summary.json` 的 `violations` 有 `{kind: protected_path, path: README.md}`（这个任务后来被取消，见“发现的问题”8，违规照样记录） |
| T11（1a 部分） | r2：`--image` 给一张纯绿色 PNG，任务书给出路径，要求执行端用 `read_image` 判断主色 | 通过【已验证】2026-10-25：执行端调用了 `read_image`，写出 `MAIN_COLOR = 'green'`；`state.json` 的 `images` 记了图片路径 |
| T23 | r4：派发后起一个 `run wait`，15 秒后按 PID 结束它（模拟设计端会话关掉）；之后在新的命令里 `run status`、`run wait` | 通过【已验证】2026-10-25：`wait` 被结束时任务在跑，之后照常 `done`；`run status` 列出这个任务（`workerAlive: false`），`run wait` 返回结果；`events.jsonl` 22 条，序号 1–22 连续。第二次 `wait` 时任务已经结束，“接上进行中的任务”的情形由 T3、T4 的 `run wait` 覆盖 |
| T24 | r1：派发前放一个设计端写好的验收测试 `accept.test.mjs` 和一个无关的未跟踪文件 `notes.local.txt`；第二个任务里任务书要求执行端 `git commit` | 通过【已验证】2026-10-25：两个任务的补丁里都没有这两个文件（第一个只有 `README.md`、`math.mjs`，第二个只有 `math.mjs`）；执行端提交后 `violations` 有 `{kind: head_moved, detail: HEAD 从 … 变为 …}`，任务仍按汇报记为 `done` |
| T21 | 运行时一侧：临时目录里非 git 目录 `run start`、`doctor`；T001 做完后工作区有改动时 `doctor`；返工到上限时 `run resume` | 运行时一侧通过【已验证】2026-10-25：非 git 目录 `run start` 返回 `not_git`，`doctor` 的 `repo` 为 error、`git.isRepo` 为 false；有改动时 `worktree_clean` 为 warn，`git.dirty` 列出 3 个文件；`correction` 到 2 轮后 `run resume` 返回 `round_limit`。skill 一侧（`claude -p`、Haiku）：非 git 目录里停下问是否 `git init`；有未跟踪文件时停下让用户选提交、暂存、保持原样或取消，没有派发【已验证】2026-10-25。返工到上限后汇报剩余问题的部分未做 |
| T13 | r5：`claude -p --plugin-dir <代码快照> --model claude-sonnet-5-5`，需求“在 math.mjs 里加 pow(a, b)……补上测试”；权限只放行读写文件、`git`、`node`。因为 `-p` 模式收不到后台通知，需求里注明“前台运行 `run wait`”；为了覆盖返工，注明“验收时至少提一轮返工” | 通过【已验证】2026-10-25：设计端按 skill 跑 `doctor`、按模板写任务书（4 条 AC）、`run start`、`run wait`，读 `summary.json` 和补丁、自己重跑 `node --test`（4/4），写返工意见（补边界测试，新增 AC5）、`run resume`、再等待和验收（9/9），最后按阶段 5 汇报。共 18 轮对话、约 93 秒、0.24 美元。两处偏离由验收设置造成：前台等待、刻意返工。另：设计端用 `cat` 读插件目录里的模板被 Claude Code 拦下（“For security”），它改用 Read 工具，不影响流程 |

## 发现的问题

1. **同一个 Web 进程里第二个任务建不了会话**（严重）。第二次 `run start` 失败，`statusReason` 为 `executor_error`，`worker.log`：`bash env key "DSH_AGENT_COLLAB_ROLE" is already owned by contributor "agent-collab-<第一个会话>"`。桥接每个会话注册一个 shell 环境提供者，dsh 规定一个键只能有一个提供者，第一个会话跑完后仍挂在 Web 里。后果：一个 Web 进程只能派一个任务，之后只能续接它。假 dsh 不检查这一点，集成测试只建过一个会话。修复任务书 [briefs/1a-bridge-multi-session.md](briefs/1a-bridge-multi-session.md)，2026-10-25 修复并验收，重启用户的 Web 换上新桥接后，同一个 Web 里同时派发 4 个任务都正常。修好后用户的 Web 要重启才能加载新桥接（更新已装的包不会热加载，PLAN.md §5.6）。
2. **新工作区以任务标题命名**（小）。原因：桥接把会话标题传给了 `workspaceRegistry.create(path, title)`。同一任务书一并修。
3. **dsh 的 workspace-write 允许不经审批写系统临时目录**（事实，不是缺陷）：T3 第一次让执行端写临时目录下的文件，write 工具直接写成功，没有审批；接着它用 bash 读这个文件时才弹审批，因为 bash 沙箱里的 `/tmp` 是独立的 tmpfs，看不到 write 工具写的文件。验收“越权写入弹审批”要选临时目录以外的目标。
4. 执行端的行为（正面）：问题单要求写仓库外文件、改 README，和原任务书的约束冲突时，执行端按任务书停下，汇报 `blocked` 并在 `open_questions` 写明要设计端决定什么；设计端用 `run resume --kind answer` 解除约束后继续。
5. **建会话失败后工作进程不退出**（中）。T002 因问题 1 失败后，它的工作进程 20 多分钟还在，连着桥接的端口；`run cancel` 后也不退。原因：`core/adapters/dsh.mjs` 的 `startBridge` 在 `newSession` 抛错时没关连接（`resume` 那条路径是关的）。并入 [briefs/1a-bridge-multi-session.md](briefs/1a-bridge-multi-session.md) 的缺陷三。
6. dsh Web 里运行中的插话要等当前一轮结束才送达（事实，不是缺陷）。执行端在这一轮里做的工作可能和插话冲突，要靠插话开的下一轮改回来；PLAN.md D12 把插话当补充需求，结果一致，但人在 Web 里会看到执行端先交一份汇报、再按插话改。是否要在 PLAN.md §5.4 写明，留给设计会话。
7. **同一工作进程里要求重发时，汇报文字被拼成两遍**（严重，T9）。`core/adapters/dsh.mjs` 的 `resume` 每次新建一条桥接连接，`start` 时的连接不关，两条连接都向这一轮投递同样的事件，`turnFinalText` 拼出两遍，合法的汇报被判“JSON 不合法”（`events.jsonl` 写入时按游标去重，日志看不出来）。并入 [briefs/1a-ci-fix3-unhandled-turn.md](briefs/1a-ci-fix3-unhandled-turn.md) 的缺陷二，2026-10-25 修复，T9 重跑通过。
8. **执行端不守任务书里“不读仓库外文件”的约束，dsh 的 workspace-write 也不拦读取**（事实；有安全含义）。r1 的任务书让执行端运行放在系统临时目录里的 `bin/collab.mjs`，执行端的 bash 沙箱有独立的 `/tmp`，找不到文件；它没有按 `when_blocked` 停下，而是花了约 4 分钟到处排查：读了 `~/.dsh` 下的会话缓存、桥接发现文件（内含桥接令牌）、dsh 的源码和本仓库 `.git/agent-collab-baselines/` 下的文件。Claude 用 `run cancel` 停下了它。含义：执行端能读到桥接令牌，就能绕开 `DSH_AGENT_COLLAB_ROLE` 直接连桥接建会话，防套娃只防住了“调用 `collab`”这一条路。是否要在 PLAN.md §16 记为产品风险、要不要收紧（例如桥接拒绝来自执行端会话的连接），留给设计会话。
9. dsh Web 启动时默认会打开系统浏览器（`--no-open` 可关）。按原样重启用户的 Web 时它在用户的默认浏览器里开了一个页面。
