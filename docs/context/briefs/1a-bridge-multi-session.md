本文件：S6 用真实 dsh Web 验收时发现的三个缺陷的修复任务书原文（交给 dsh）：同一个 Web 进程里第二个任务建不了会话；新工作区被命名成任务标题；建会话失败后工作进程不退出。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿并在 dsh Web 派发，用户未逐份审阅。依据：2026-10-25 凌晨 S6 在用户的 dsh Web（装了桥接）里实测，见下文。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”、S2 任务书 docs/context/briefs/1a-s2-bridge.md（隔离和安全规则照旧有效），再读 docs/protocol.md §2.3 和 docs/PLAN.md §5.4（先用 `grep -n '^#' docs/PLAN.md` 定位）。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书（docs/context/briefs/1a-s4-dsh-adapter.md）第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程（不在 bwrap 里、命令行是 `dsh web` 的那个）就停止。

## 缺陷一：第二个会话建不了

现象（真实 dsh 0.2.1-rc.2 的 Web，同一进程里先跑完一个任务，再在同一仓库 `run start` 第二个任务）：`worker.log` 里是

```
JsonRpcError: failed to create session with agent-collab or standard: bash env key "DSH_AGENT_COLLAB_ROLE" is already owned by contributor "agent-collab-<第一个会话的 id>"; contributor "agent-collab-<第二个会话的 id>" cannot also own it
```

原因：`dsh-bridge/lib/dsh-api.js` 的 `registerSessionEnv` 每个会话都以 `agent-collab-<会话 id>` 的名字调 `shellEnv.register`，声明同一个键 `DSH_AGENT_COLLAB_ROLE`。dsh 的 `ShellEnvRegistry`（`@deepseek-ai/dsh-shell-env/lib/index.js` 的 `register`）规定每个键只能有一个提供者，而第一个会话的注册要等它的 agent 卸载才释放，会话跑完后仍挂在 Web 里，所以之后所有会话都失败（退到 `standard` 预设也一样）。假 dsh 不检查这一点，桥接集成测试只建过一个会话，所以没测出来。

要求：一个 Web 进程里同时或先后建任意多个 agent-collab 会话都能成功，每个会话的 shell 里 `DSH_AGENT_COLLAB_ROLE`（以及桥接注入的其他变量）的值只来自它自己的 `session/new`，不串到别的会话、也不出现在非 agent-collab 的会话里；会话关闭后不再给它注入。做法由你定，例如整个桥接只注册一个提供者，`resolve(execution)` 按 `execution.agent` 查一张“会话 → 变量”的表，会话建立时登记、关闭或 agent 卸载时删除。注意提供者的生命周期挂在哪个上下文上：挂在某个会话的上下文上，那个会话卸载时会把别的会话的注入一起带走。先读 dsh 的 `ShellEnvRegistry` 和桥接现有代码，确认 `shellEnv` 服务从哪个上下文取得、`register` 的释放跟着谁。

## 缺陷二：新工作区以任务标题命名

现象：对一个 dsh Web 里还没有工作区的仓库派发任务，侧栏里新建的工作区名字是 `[collab] T001 <任务名>`，之后这个仓库的所有会话（包括人自己开的）都挂在这个名字下。原因：`acp-server.js` 调 `this.dsh.attachWorkspace(cwd, meta.title, sessionId)`，把会话标题当成了工作区标题；`workspaceRegistry.create(path, title)` 对已有路径沿用第一次的标题，所以名字会一直留着。

要求：新建工作区时，名字和人在 dsh Web 里自己打开这个目录时得到的一样（先查 dsh 自己建工作区时怎么取名，例如目录名；查不到就用 `path.basename(cwd)`，并在汇报里说明）。已有工作区不改名。会话标题照旧是 `[collab] T001 <任务名>`。

## 缺陷三：建会话失败后工作进程不退出

现象：上面缺陷一让 T002 的 `session/new` 失败，`worker.log` 记了“任务结束：failed（executor_error）”，但工作进程 21 分钟后仍在，`ss -tnp` 显示它还连着桥接的端口。之后 `run cancel` 把任务记为 `cancelled`，进程照样不退。

原因（Claude 读代码定位，请核实）：`core/adapters/dsh.mjs` 的 `startBridge` 在 `client.newSession` 抛错时没有关闭 `client`，此时 `current` 还没赋值，`close()` 也就关不到它；连接一直开着，事件循环不空，进程不退出。同文件的 `resume` 在 `resumeSession` 失败时是先 `client.close()` 再抛错的。`startAcp` 在 `newSession` 失败时是否同样留下子进程，一并检查。

要求：`start` 的任何一步失败，适配器自己建立的连接和子进程都要关掉；工作进程写完终态后能正常退出。

## 测试

- 缺陷三：假 dsh 让 `session/new` 返回错误，`run start` 之后任务为 `failed`（`executor_error`），工作进程在几秒内退出（按 `state.json`/`worker.log` 里的 pid 检查），不留连接。acp 模式同样一条。
- 假 dsh（`tests/fixtures/fake-dsh.mjs` 等）的 `shellEnv` 改成和真 dsh 一样检查“一个键只能有一个提供者”和提供者名字唯一，这样单元测试能发现缺陷一；`workspaceRegistry` 按真 dsh 的规则（同一路径沿用第一次的标题）。
- 单元测试：同一个假 Web 里先后、同时建两个会话都成功，各自的 shell 环境里 `DSH_AGENT_COLLAB_ROLE` 正确，非 agent-collab 会话里没有；关闭一个会话后另一个仍有注入；新工作区的名字是目录名而不是会话标题。
- 集成测试 `tests/integration/bridge-dsh.mjs`（真 dsh、临时 `DSH_HOME`、假 LLM）：在同一个 Web 里再建第二个会话（同一 cwd 和另一个 cwd 各一次），跑一轮带 shell 调用的 prompt，核对注入的环境变量；核对新工作区的名字。

## 验收标准

- BM1：修改前，新的单元测试和集成测试的两会话场景失败（汇报失败信息原文，应能看到“already owned by contributor”或等价错误），缺陷三的用例失败（工作进程不退出）；修改后都通过。
- BM2：`node tests/integration/bridge-dsh.mjs`、`node tests/integration/adapter-dsh.mjs` 都 `RESULT: 通过`。
- BM3：`npm test` 连跑 3 次全部通过，无残留进程；按 RUNBOOK“按 CI 的条件重跑测试”在 `chmod 644` 副本里默认参数和 Node 20 模拟参数各跑一次，全部通过。
- BM4：所有 dsh 内部调用仍只出现在 `dsh-bridge/lib/dsh-api.js`（S2 的自动检查照旧通过）。
- BM5：桥接版本号是否要提升、`protocol.md` 是否要改，写进汇报（不要改 docs/）。

## 隔离和安全

遵守 RUNBOOK“派发 dsh 任务”的全部规定和 S2 任务书的隔离规则：被测 dsh 只在临时 `DSH_HOME` 里运行，`--port 0 --no-open`；不读写 `~/.dsh`，不读 `.env`，不连接用户的 dsh Web（`~/.dsh/agent-collab/bridge-web.json` 不要读）；不调用真实模型。可以只读 dsh 安装目录里的源码。不执行 git commit、git push、切分支；不改 docs/ 和 AGENTS.md；只停止自己 spawn 的进程（按 PID）；遇到需要越权（审批）的操作：不要申请，记为发现。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；两个缺陷的原因核实（读到的 dsh 源码位置）和改法；BM1–BM5 的结果和证据，修改前失败信息的原文；你开过的所有后台任务及其结束情况；没做完的项和疑问。
