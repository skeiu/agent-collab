本文件：`b2f69a7` 推送后 CI 仍在 macOS LTS、Windows Node 20 失败的修复任务书原文（交给 dsh）：桥接断开记成 `worker_lost`。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿，用户未逐份审阅。依据：CI 运行 40116306368（`b2f69a7`）：四组通过；macOS LTS、Windows Node 20 各 1 项失败，都是 `tests/dsh-adapter.test.mjs`“桥接断开：进行中的一轮以 failed 结束，statusReason 说明原因”。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”、上一份任务书 docs/context/briefs/1a-ci-fix2-macos-windows.md（隔离和安全规则照旧有效）。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书（docs/context/briefs/1a-s4-dsh-adapter.md）第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程（不在 bwrap 里、命令行是 `dsh web` 的那个）就停止。

## 现象（上一轮加的诊断打出来的，macOS LTS）

```
[..30.615Z] 工作进程启动，pid 5152，任务 T001，状态 starting
[..30.674Z] [adapter] dsh 连接断开：JSON-RPC peer closed
file:///.../core/adapters/dsh.mjs:385
        turn.reject(Object.assign(new Error(message), { code: 'dsh_disconnected' }));
Error: dsh 连接断开：JSON-RPC peer closed
    at AcpClient.<anonymous> (core/adapters/dsh.mjs:385:35)
    ...
    at JsonRpcPeer._onEnd (core/jsonrpc.mjs:97:30) {
  code: 'dsh_disconnected'
}
Node.js v24.21.0
[..32.539Z] 工作进程启动，pid 5300，任务 T001，状态 running
[..32.566Z] 任务结束：failed（worker_lost）
```

Windows Node 20 上是同一个堆栈，只是消息为 `read ECONNRESET`。上一轮对第 8 项“迟到的 socket 错误”的修复是对的，但不是这次失败的原因。

## 原因（Claude 读代码的判断，请核实）

工作进程启动后约 60 毫秒连接就断了（测试在这时结束假 Web）。`core/adapters/dsh.mjs` 的 `makeTurn` 返回的 `Promise.race([promptPromise, turn.guard])` 在 `adapter.start` 返回后，`core/worker.mjs` 要先写状态等（第 536 行赋给 `turnPromise`，到循环里 `await turnPromise` 之间有异步操作）才去等它。连接恰在这段时间断开，`turn.reject` 让这个 Promise 拒绝时还没有处理函数，Node 15 起未处理的拒绝会结束进程，工作进程来不及写终态，`run wait` 只能记成 `worker_lost`。`resume`、`attach` 返回的那一轮 Promise 有同样的窗口。

## 任务

1. 先写一个能稳定复现的测试（不靠时序碰运气）：例如直接用 `createAdapter`，让假桥接在回完 `session/new` 后立刻断开，拿到 `turn` 后等一会儿再去 `await`，断言没有 `unhandledRejection` 且 `await` 得到 `code: 'dsh_disconnected'` 的错误；或在工作进程层面用测试变量让工作进程在 `start` 返回后、等这一轮之前停一下。修改前它失败，修改后通过。
2. 修改产品代码，使适配器返回的每个“这一轮”的 Promise 在被等待之前拒绝也不会成为未处理的拒绝，而且拒绝原因原样交给之后等待它的人（不能吞掉）。`start`、`resume`、`attach` 三条路径都要覆盖。改法由你定，改动越小越好。
3. 检查 `core/worker.mjs` 和适配器里有没有别的“先拿到 Promise、过一会儿才等”的地方有同样问题，一并改，汇报里列出。
4. 工作进程本身不应因任何未处理的拒绝而悄悄退出、不写终态：看看工作进程有没有 `process.on('unhandledRejection')` / `uncaughtException` 兜底；没有的话，按 docs/protocol.md 的规定（终态、`worker.log`）提出你的建议写进汇报，先不实现。

只改 `core/`、`tests/` 里直接相关的代码。

## 验收标准

- FX1：第 1 步的测试修改前失败（汇报失败信息原文）、修改后通过。
- FX2：`npm test` 连跑 3 次全部通过，无残留测试进程；按 RUNBOOK“按 CI 的条件重跑测试”在 `chmod 644` 副本里默认参数和 Node 20 模拟参数各跑一次，全部通过。
- FX3：`node tests/integration/adapter-dsh.mjs` `RESULT: 通过`。
- FX4：汇报写明产品改动（文件、函数、改前改后的行为、与 docs/protocol.md 是否一致；不一致的写出 protocol.md 应改成什么，不要改 docs/）。
- macOS、Windows 上的效果由 Claude 推送后看 CI。

## 隔离和安全

同上一份任务书。被测 dsh 只在临时 `DSH_HOME` 里运行；不读写 `~/.dsh`，不读 `.env`，不连接用户的 dsh Web（`~/.dsh/agent-collab/bridge-web.json` 不要读）；不调用真实模型。不执行 git commit、git push、切分支；不改 docs/ 和 AGENTS.md；只停止自己 spawn 的进程（按 PID）；遇到需要越权（审批）的操作：不要申请，记为发现。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；原因核实；FX1–FX4 的结果和证据；你开过的所有后台任务及其结束情况；没做完的项和疑问。
