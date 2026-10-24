本文件：S3 CI 修复（[1a-s3-ci-fix.md](1a-s3-ci-fix.md)）验收后的返工任务书原文（交给 dsh）。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-24，待用户派发；依据的 protocol.md §5.3、§5.5、§6 补充【已确认】用户 2026-10-24。依据：Claude 2026-10-24 对 1a-s3-ci-fix 的验收（在本机加负载重跑、在副本里逐项撤回修复做反证）。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S3 原任务书 docs/context/briefs/1a-s3-runtime.md（隔离和安全规则照旧有效），再读上一轮的任务书 docs/context/briefs/1a-s3-ci-fix.md。docs/protocol.md 只读 §3 的 `attach`、§5.3、§5.5 和 §6 的 `run wait`，以 2026-10-24 补充后的条文为准。

## 第 0 步：沙箱自检（必须先做）

同 S3 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

上一轮的 FX1、FX3–FX6 Claude 重跑都通过了，`npm test` 正常负载下 6/6 通过。问题出在比 FX5 更重的负载下（`nproc` 个占满 CPU 的进程，加上 `run-attach`、`run-cancel`、`run-stall`、`run-lock` 四个测试文件各 24 份同时跑），以及 FX2 的反证：

- 凡是“杀掉工作进程再接上”的用例都会大量记成 `report_invalid`（预期 `done`），一轮 96 个进程里失败 36–43 个。Claude 留下现场看过：从杀掉工作进程到新工作进程 `attach`，用的时间超过了这一轮剩下的 1.2 秒，执行端已经结束这一轮，`attach` 返回 `running: false`，假适配器按 protocol.md §3 的规则从补发的事件里算 `finalText`（最后一次工具调用之后的全部 text），只得到“最后一步”；而汇报只放在脚本的 `end.finalText` 里，没有对应的 text 事件。之后要求重发，第 2 轮脚本里没有汇报，于是 `report_invalid`。你上一轮汇报里那次没抓到原文的 `run-attach` 失败，很可能就是这个。Windows CI 上起两个 node 进程就可能用掉 1 秒，这在 CI 上也会发生。产品代码在这里没有错，是假执行端的两条路径（`turn_end` 消息里的 `result` 和补发的事件）给出的最终文字不一致。Claude 在副本里让假执行端把 `end.finalText` 作为最后一条 text 事件发出后，这些用例全部不再失败（但本来就把汇报作为事件发出的用例会汇报重复，所以不能照搬）。
- `tests/run-lock.test.mjs` 的“本仓库别的任务在跑时 run resume 以 lock_held 拒绝”偶发失败（`0 !== 3`，即 `run resume` 成功了）。原因：两个任务共用一个假执行端，第二个任务 `start` 跑的是 `turns[0]`（立即结束），不是那个 2.5 秒的慢轮次；负载一重，第二个任务在 `run resume` 之前就结束、放掉了锁。你上一轮在正常负载下 10 次里也碰到过 1 次。
- FX2 的用例单独撤回任何一处修复都还通过（各 3/3）：只把 `finalize` 改回“终态先写”时，`run wait` 等 `pendingSpawnPid` 退出兜住了；只把 `run wait` 改回旧写法时，`summary.json` 先写兜住了。原因是 2 秒的 `AGENT_COLLAB_TEST_SUMMARY_DELAY_MS` 让新工作进程活得比 1.5 秒的轮询间隔还长，`run wait` 其实看得到它的 pid，“一次轮询间隔内就收尾”的情形并没有出现。
- 代码审阅发现：`finalize` 把终态设进内存后，到写 `summary.json` 之前有好几处 `await`；这期间执行端如果还有事件到达，`handleAdapterEvent` 会调用 `saveState()`，终态就先于 `summary.json` 落盘，§5.3 的顺序保证被绕过。假执行端一轮结束后不再发事件，所以测试没碰到；真实的 dsh 一轮结束后可能还有事件（S4 才接入）。
- 重发汇报那条路径（`finishTurn` 里的 `adapter.resume`）只在调用前重置了 `lastActivityAt`，返回后没有重置，和 `drive()` 里的 `start`、`resume` 不一致。

## 任务

1. **假执行端两条路径的最终文字一致**（测试夹具）。让同一轮里 `turn_end` 消息带的 `result.finalText` 和按 §3 规则从这一轮事件算出的 `finalText` 相同，改法你定（例如由假执行端在 `end.finalText` 不为空、且这一轮最后一次工具调用之后的 text 拼起来不等于它时，补发一条 text 事件；或者改 `turnWithReport` 和各用例的脚本）。改完后核对依赖事件条数、事件内容的断言是否需要跟着调整，不得为通过而删断言。
2. **“接上进行中的一轮”的用例确实在一轮进行中接上**（测试）。`run-attach.test.mjs` 里本意是接上进行中会话的用例（RW8 的“杀掉工作进程后 run wait 接上…”、“events.jsonl 最后一行不完整时也能恢复”、FX1 的“从 session 事件恢复并接上”、`run-stall.test.mjs` 的 FX3“attach 接上之后还要过一会儿才有事件”，以及你认为同类的用例），负载重时会悄悄变成“接上时这一轮已结束”的情形，测的不是用例名说的东西。改成不依赖时序：例如给假执行端加一个脚本步骤，让这一轮停在那里直到收到 `attach` 再继续；并在用例里断言确实走了 `running: true` 的路径（例如看 `worker.log` 或假执行端记录）。“这一轮已结束时接上”的用例（RW8 的“工作进程不在期间这一轮已跑完”等）保持原样。
3. **run-lock 的 lock_held 用例不依赖时序**（测试）。保证 `run resume` 时第二个任务一定还在跑、一定占着锁（例如给第二个任务一个单独的、能挂住的轮次），用例最后照旧 `run cancel` 收掉第二个任务。顺手检查 `tests/run-lock.test.mjs` 里其他“另一个任务在跑”的用例有没有同样的共用脚本问题。
4. **FX2 的用例能分别抓住两处修复**（测试）。
   - 顺序：新用例不经过 `run wait`，在 `AGENT_COLLAB_TEST_SUMMARY_DELAY_MS` 期间高频（例如每 10 ms）直接读 `state.json`，只要读到终态，`summary.json` 就必须已经存在。
   - `run wait` 的等待：`run wait` 返回后，`worker.log` 里记过的每个工作进程 pid 都已退出，`active.lock` 不存在（或不再是本任务的）。
   - 反证：在副本里分别只撤回“summary 先写”、只撤回“`run wait` 等自己启动的工作进程和锁”，各自至少有一个用例失败；做不到的写明原因。
5. **收尾开始后到达的事件不写 `events.jsonl` 和 `state.json`**（产品，protocol.md §5.3 补充）。`finalize` 开始后，`handleAdapterEvent` 收到的事件只记进 `worker.log`（写明类型），不写 `events.jsonl`、不调用 `saveState()`。加用例：假执行端在 `turn_end` 之后再发一条事件（需要的话加脚本开关），配合 `AGENT_COLLAB_TEST_SUMMARY_DELAY_MS`，断言第 4 条的“读到终态时 `summary.json` 已存在”仍成立，且这条迟到的事件不在 `events.jsonl` 里、在 `worker.log` 里。
6. **重发汇报时 `lastActivityAt` 和其他路径一致**（产品，protocol.md §5.5 补充）。`finishTurn` 里的 `adapter.resume` 返回后也重置 `lastActivityAt` 并写一次 `state.json`。不要求新用例，汇报里说明改动。

## 验收标准

- CR1：第 1 条完成；说明改法和调整过的断言。
- CR2：第 2 条涉及的每个用例都断言了走的是 `running: true` 的路径。反证：去掉“等 `attach` 再继续”的那一步之后（或用其他方法让 `attach` 晚于这一轮结束），这些用例因为那条断言失败，而不是悄悄通过。
- CR3：第 3 条完成；把 `tests/run-lock.test.mjs` 单独同时跑 24 份、连跑 3 轮全部通过。
- CR4：第 4 条的两个用例通过，反证按第 4 条做并汇报结果。
- CR5：第 5 条的用例通过；反证：去掉第 5 条的改动后它失败。
- CR6：重负载：先启动 `nproc` 个占满 CPU 的进程（按 PID 结束），在这期间把 `tests/run-attach.test.mjs`、`tests/run-cancel.test.mjs`、`tests/run-stall.test.mjs`、`tests/run-lock.test.mjs` 各同时跑 24 份、连跑 2 轮，全部通过；再按上一轮 FX5 的规格（前三个文件各 8 份、3 轮）跑一遍，全部通过。跑完结束占 CPU 的进程，确认没有残留。达不到时如实汇报失败的用例、次数和断言原文，不要放宽阈值凑数；判断是负载过重而非缺陷的，写明依据。
- CR7：回归：`npm test` 连跑 10 次全部通过，每次跑完没有 `fake-executor`、`run.mjs --worker`、`lock-worker` 进程；S3 的测试合计仍在 60 秒内；`npm run build` 退出码 0，跑完删掉 `dist/`。
- Windows、macOS 上是否通过，以推送后的 CI 为准；推送由用户授权，不在本任务内。

## 隔离和安全

同 S3 原任务书。不执行 git commit、git push；不修改 docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。只停止自己 spawn 的进程（按 PID）。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 CR 的结果和证据（命令及输出摘要）；新增的 `AGENT_COLLAB_TEST_` 变量和假执行端脚本开关；你开过的所有后台任务及其结束情况；和 protocol.md 不一致的地方；没做完的项和疑问。
