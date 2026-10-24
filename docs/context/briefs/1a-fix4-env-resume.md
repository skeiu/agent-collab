本文件：S6 和第三轮修复之后剩下的几个问题的修复任务书原文（交给 dsh）：Web 重启后续接时执行端的环境变量丢失（防套娃失效）、macOS 上工作区用例失败、两处收尾小问题。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿，用户未逐份审阅。依据：S6 在真实 dsh Web 上的实测（docs/context/1a-acceptance.md）；CI 运行 40119684014（`c7e50e2`）：Ubuntu、Windows 四组通过，macOS 两组各 1 项失败；docs/context/RISKS.md R13。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和“按 CI 的条件重跑测试”、S2 任务书 docs/context/briefs/1a-s2-bridge.md（隔离和安全规则照旧有效）、上一份任务书 docs/context/briefs/1a-bridge-multi-session.md，再读 docs/protocol.md §2.3、§2.4（`session/new`、`session/resume`）。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书（docs/context/briefs/1a-s4-dsh-adapter.md）第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程（不在 bwrap 里、命令行是 `dsh web` 的那个）就停止。

## 问题一：Web 重启后续接，执行端 shell 里没有 `DSH_AGENT_COLLAB_ROLE`（严重）

现象（Claude 2026-10-25 在用户的 dsh Web 上实测，桥接 `d53f0ab`）：r1 的任务 T002 在 Web 进程 A 里建会话，第 1 轮执行端 `echo "role=$DSH_AGENT_COLLAB_ROLE"` 输出 `role=executor`；按 PID 重启 Web（进程 B）后 `run resume T002 --kind correction`，同样的命令输出 `role=`。同一个 Web 进程里续接（没重启）时变量还在。

原因：`dsh-bridge/lib/acp-server.js` 的 `resumeSession` 恢复 agent（`resumeAgent` 的 `setup`）时不调用 `setSessionEnv`，`session/resume` 也不带 `env`；“会话 → 变量”表只在内存里，Web 重启或 agent 被卸载（`agent/disposed` 会清表）后就没了。docs/protocol.md 第 88 行规定 `env`“注入这个会话的 shell”，指整个会话，所以这是实现不符合协议。

要求：

- 一个 agent-collab 会话在 `session/new` 时登记的变量，对这个会话之后的每一轮都有效，包括：同一 Web 进程里续接；Web 重启后续接；agent 被卸载后又被恢复；Web 重启后人直接在 Web 里对这个会话发消息开的一轮（这时没有工作进程连着桥接）。
- 做法由你定。Claude 的建议：桥接在 `session/new` 成功后把这个会话的变量持久化到 dsh 的会话数据里（如果 dsh 有给插件存会话级数据的接口）或桥接自己在 `<DSH_HOME>/agent-collab/` 下的文件里（权限 0600，`session/close` 时删掉）；`agent/created`/恢复 agent 时（包括不经过桥接、由 Web 自己恢复的情形）按会话 id 读回来登记。先查 dsh 有没有“agent 恢复/创建”的全局事件，确认人从 Web 开的一轮也能被覆盖。
- 这个持久化文件属于桥接的内部状态；在汇报里写清文件位置和格式，Claude 回填 protocol.md 的目录说明。不要改 docs/。

## 问题二：macOS 上“新工作区用目录名”的用例失败（测试问题）

CI（macOS 两组）：`tests/bridge.test.mjs:267`“新工作区用目录名而不是会话标题；已有工作区不改名”，断言“应创建对应工作区”失败。原因（Claude 读代码判断）：桥接的 `validateCwd` 用 `fs.realpathSync` 解析 `cwd`，工作区按真实路径建；用例拿没解析的临时路径去找（macOS 的 `/var` 是 `/private/var` 的符号链接）。改法同第二轮 CI 修复：两边都用真实路径比较。检查 `tests/` 里其他按 `cwd` 查工作区或会话的断言有没有同样的问题，一并改。用第二轮任务书 PC3 的办法（`TMPDIR` 设成指向临时目录的符号链接）在本机复现并验证。

## 问题三：主动关闭旧连接时 worker.log 误记“dsh 连接断开”（小）

第三轮修复后，`resume`/`attach` 先关掉本适配器的上一条连接，`attachClientHandlers` 的 `close` 处理把这当成断线，worker.log 记一条 `[adapter] dsh 连接断开：ACP client closed`（S6 重跑 T9 时看到）。要求：适配器自己主动关闭的连接不记断线、不拒绝任何一轮；真正的断线照旧。

## 问题四：acp 模式 `resume` 失败时没关新建的子进程（小，第三轮 dsh 读代码发现）

`core/adapters/dsh.mjs` 的 acp `resume` 分支在 `spawnAcpClient()` 之后 `client.resumeSession()` 抛错时，没有像桥接分支那样关闭新 client。先写一个修改前失败的测试确认，再修。

## 测试

- 问题一：单元测试（假 dsh）：建会话 → 模拟 Web 重启（新的假 dsh 实例、同一个 `DSH_HOME`）→ 续接，shell 环境里有 `DSH_AGENT_COLLAB_ROLE=executor`；模拟 agent 卸载后恢复，同样有；非 agent-collab 会话没有；`session/close` 后持久化文件被删。集成测试 `tests/integration/bridge-dsh.mjs`（真 dsh、临时 `DSH_HOME`、假 LLM）：建会话跑一轮带 shell 调用的 prompt，结束临时 Web 再启动，`session/resume` 后再跑一轮，核对变量。
- 问题二到四：见各节。

## 验收标准

- FV1：问题一、三、四的新测试修改前失败（汇报失败信息原文）、修改后通过；问题二在符号链接 `TMPDIR` 下修改前失败、修改后通过。
- FV2：`npm test` 连跑 3 次全部通过，无残留进程；`chmod 644` 副本里默认参数和 Node 20 模拟参数各跑一次，全部通过。
- FV3：`node tests/integration/bridge-dsh.mjs`、`node tests/integration/adapter-dsh.mjs` 都 `RESULT: 通过`。
- FV4：所有 dsh 内部调用仍只出现在 `dsh-bridge/lib/dsh-api.js`（S2 的自动检查照旧通过）。
- FV5：汇报写明产品改动、持久化文件的位置和格式、与 docs/protocol.md 是否一致（不一致的写出应改成什么，不要改 docs/）。

## 隔离和安全

遵守 RUNBOOK“派发 dsh 任务”的全部规定和 S2 任务书的隔离规则：被测 dsh 只在临时 `DSH_HOME` 里运行，`--port 0 --no-open`；不读写 `~/.dsh`，不读 `.env`，不连接用户的 dsh Web（`~/.dsh/agent-collab/bridge-web.json` 不要读）；不调用真实模型。可以只读 dsh 安装目录里的源码。不执行 git commit、git push、切分支；不改 docs/ 和 AGENTS.md；只停止自己 spawn 的进程（按 PID）；遇到需要越权（审批）的操作：不要申请，记为发现。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；各问题的原因核实（读到的 dsh 源码位置）和改法；FV1–FV5 的结果和证据，修改前失败信息的原文；你开过的所有后台任务及其结束情况；没做完的项和疑问。
