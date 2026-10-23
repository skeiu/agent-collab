本文件：第 1a 阶段实现第 S2 步（dsh 桥接插件）交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-23，待用户派发。依据：接口契约 [docs/protocol.md](../../protocol.md)【已确认】用户 2026-10-23；实现决定 1、4（[1a-impl-plan.md](../1a-impl-plan.md)）。和 S3 互不依赖、不改同一批文件，但都在同一个工作目录里，同时做时 `npm test` 会跑到对方写到一半的测试，所以按 S2、S3 的顺序一步验收完再派下一步。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”、docs/context/1a-impl-plan.md，再读 docs/protocol.md 的“通用约定”和第 1、2 节（这是本步的接口，全部要实现）。docs/PLAN.md 只读：§5.4、§5.6、§7.1 里 `dsh-bridge/` 那几行、§9 全部、§11.4、§11.9（先用 `grep -n '^#' docs/PLAN.md` 定位，不要全文读）。

dsh 内部服务的用法以 experiments/1a/ 的实测为准，可以直接参考并复制其中的代码（是本仓库自己的代码）：01（整份复制 `standard` 预设）、02（`agentPresets.mount`）、03（`workspaceRegistry`）、04（审批和提问事件、`approval/request` 应答者）、06（`shellEnv.register`），结论在 experiments/1a/REPORT.md；临时环境的建法参考 experiments/1a/_shared/harness.mjs。不要从 experiments/ 导入，需要的部分复制过来。

## 第 0 步：沙箱自检（必须先做）

运行下面两条命令，把输出原样写进汇报：

    pgrep -af dsh
    cat /proc/1/cmdline | tr '\0' ' '

输出里有用户日常运行的 dsh Web 进程（不是你自己沙箱里的进程），说明沙箱没有隔离进程：立即停止，只汇报这一步。

## 第 1 步：假 LLM 服务探针（实现决定 4，先做，有结论再往下）

写 `tests/fixtures/fake-llm.mjs`：一个 Node HTTP 服务，监听 `127.0.0.1` 的随机端口，按 OpenAI 兼容的 chat completions 接口应答（dsh 服务商条目用 `api: openai-completions` 加 `baseURL` 指向它）。按测试给的脚本逐次返回：一段文字，或一次工具调用（如调用 dsh 的 shell 工具执行一条命令、写一个文件），或文字加工具调用。dsh 实际用流式还是非流式、请求里带了哪些字段，以抓到的请求为准实现，并在汇报里写明。

探针：在临时 `DSH_HOME` 里写一个指向假服务的服务商条目和默认模型，用 `dsh --profile acp --patch <覆盖层>` 加 S1 的 `AcpClient` 发一次 prompt，确认：(a) 纯文字回复能正常结束；(b) 脚本里的工具调用会被 dsh 真正执行，执行结果出现在 dsh 发给假服务的下一次请求里。

- 成立：后面的桥接集成测试全部用它。
- 不成立：停下，汇报原因和抓到的请求，不要改用真实模型（真实模型要用户另行同意）。

## 第 2 步：桥接插件 `dsh-bridge/`

文件（PLAN.md §7.1）：

- `package.json`：`"type": "module"`；版本号和仓库根目录 `package.json` 的 `version` 相同（D22）；声明 `dsh.bundle.patch`；写明支持的 dsh 版本范围（目前只实测过 0.2.1-rc.2，范围从它开始，到下一个次版本之前）。PLAN.md 写的是用 `peerDependencies` 声明，**先确认它不会让 pnpm 安装时去下载 dsh**（pnpm 默认会自动安装 peer 依赖）；会下载的话改用一个自定义字段，汇报里写明，由 Claude 回填 PLAN.md。不能有任何 `dependencies`。
- `cordis.patch.yml`：插入桥接插件，并按 experiments/1a/01 的做法加工具预设 `agent-collab`：整份复制 dsh 自带 `standard` 的插件列表，去掉 `tool-ask-user`（PLAN.md §9.5）。
- `lib/index.js`：cordis 插件入口。
- `lib/acp-server.js`：ACP 方法实现。
- `lib/jsonrpc.js`：和 `core/jsonrpc.mjs` 内容完全相同的一份（桥接装进 dsh profile 后拿不到 `core/`）。
- `lib/dsh-api.js`：**所有** dsh 内部服务的调用都只出现在这个文件里；`index.js`、`acp-server.js` 只调用它导出的函数，不直接碰 `ctx` 和 dsh 的服务对象。这样单元测试可以换一个假的 dsh-api。

行为按 PLAN.md §9 和 protocol.md 第 1、2 节，下面只列容易漏的点：

1. **发现文件**：只在 web 组合包里启动监听（没有 `workspaceRegistry` 服务的 profile 里不监听、不写文件）。`DSH_HOME`、profile 名和 dsh 版本从 dsh 自己那里取（在 dsh-api.js 里写明取法），不要自己拼 `~/.dsh`。目录 0700、文件 0600，原子写入；插件卸载、dsh Web 退出时删除。dsh 版本不在支持范围时照样写文件，带 `problem`，不接受连接。
2. **认证**：令牌用 `crypto.randomBytes(32)` 的 base64url，比较用 `timingSafeEqual`。令牌不对或缺失回 `-32001` 后断开；`initialize` 之前的其他请求同样处理。
3. **多个连接**：允许同时有多个客户端连接。每个连接只收到它自己 `session/new` 或 `session/resume` 过的会话的通知。客户端断开**不取消**会话。
4. **`session/new`**：`cwd` 必须是存在的绝对路径，`env` 的键必须以 `DSH_` 开头，否则 `-32602`。权限按 PLAN.md §11.9：在当前预设表里找“沙箱 + 审批”匹配的预设，找到就 `permissionPresets.set`，找不到就直接设两个开关；返回的 `permission.presetName` 照实填。`agentPreset` 为 `null` 时用 `agent-collab`，它挂不上时退回 `standard` 并在 `presetFallback` 里写明原因；调用方明确指定而不存在时回 `-32005`。
5. **`session/prompt`**：同一会话同时只允许一个，第二个回 `-32004`。用 `agent.followup` 发消息，等根会话空闲**并且**所有子任务结束（`subagents.waitForChildren`）才返回。记下自己发出的用户消息，转发 `user/message` 时跳过它们，只转发人在 Web 里发的（带 `source: "dsh-web-human"`）。
6. **`stoppedBy`**：本连接发过 `session/cancel` 后结束的轮次为 `client`；没有发过 cancel 却以“被取消”结束的为 `human`。dsh 的 `turn/end` 里到底有哪些 `reason.kind`，以实测为准，写进汇报。
7. **`session/resume`**：会话在本进程里活着用 `agents.get`，否则 `agents.resume`。带 `sinceSeq` 时先用 `session.eventAt` 把序号大于它的事件按原顺序转发完，**再**返回结果；返回里的 `pendingApprovals`、`pendingQuestions` 由桥接自己按“已 asked 未 decided”维护（PLAN.md §9.3，不看 `agent.status`）。
8. **通知**：按 protocol.md §2.7 的映射表。每条带 `seq`、`sub`、`at`；工具输入和输出每个字段超过 8 KiB 时截断并加 `truncated: true`，回复文字不截断。
9. **只观察，不应答**：桥接不注册 `approval/request`、`user-questions/request` 的处理函数，也不发 `session/request_permission` 给客户端。
10. **`_agentCollab/models`** 和 `initialize` 返回的 `agentPresets`（含 `agentCollabInSync`：比对 `agent-collab` 和当前 dsh 的 `standard` 去掉 `tool-ask-user` 后是否一致）都要实现。

protocol.md 里标【未验证】的字段（`endReason` 的取值、`usage` 在 dsh 事件里的字段名），按实测实现，汇报里列出 dsh 事件的实际字段，由 Claude 回填 protocol.md。发现 protocol.md 有做不到或说不通的地方，按能做到的最接近的方式实现，写进汇报，不要改 protocol.md。

## 第 3 步：构建

`scripts/build.mjs` 的“打包桥接 .tgz”一步改为真正实现：把 `dsh-bridge/` 打成 `dsh-bridge-<版本>.tgz`。默认输出到仓库的 `dist/`（已在 `.gitignore` 里），支持 `--out <目录>` 改输出位置。其余两步仍报“尚未实现”。要在三个平台都能跑（Windows 上 npm 是 `npm.cmd`）。相应修改 `tests/build.test.mjs`：测试用 `--out` 指向临时目录，断言产物存在、包里有上面列出的文件、没有多余文件。

## 第 4 步：测试

- **单元测试**（进 `node --test`，不需要 dsh）：在 `tests/fixtures/` 下写一个假的 dsh-api（用内存里的假会话按脚本产生 dsh 事件），把桥接的监听和 ACP 服务跑起来，用 S1 的 `AcpClient` 走 TCP 去连。覆盖：
  - 发现文件的字段、权限（POSIX）和删除；带 `problem` 时拒绝连接；
  - 令牌错误、缺失、`initialize` 前发请求都被断开；协议版本没有交集回 `-32002`；
  - `session/new` 的参数校验、预设选择和退回、权限的两种设法；
  - prompt 期间的通知映射、`seq`/`sub`、截断；自己发的消息不回显，人发的带 `dsh-web-human`；
  - 同一会话第二个 prompt 回 `-32004`；`stoppedBy` 的 `client`、`human`、`null` 三种情况；
  - 断开重连后 `session/resume` 带 `sinceSeq` 补发：客户端按 `(seq, sub)` 去重后不缺不重；补发在返回之前完成；`pendingApprovals` 正确；
  - 两个连接各自只收到自己的会话的通知；断开不取消会话；
  - `lib/jsonrpc.js` 和 `core/jsonrpc.mjs` 内容相同；
  - `lib/index.js`、`lib/acp-server.js` 里没有对 dsh 服务的直接调用（例如断言它们不引用 `ctx`，按你的实现方式选一个能自动检查的办法）。
- **集成测试** `tests/integration/bridge-dsh.mjs`（不进 `node --test`，一条命令运行，最后一行 `RESULT: 通过|不通过` 加一句说明）：在临时 `DSH_HOME` 里用假 LLM 服务，依次：构建 `.tgz` 到临时目录 → `dsh plugin --profile web add` → `dsh --profile web --port 0 --no-open` 启动 → 检查发现文件 → 错误令牌被断开 → 用 `AcpClient` 连上 → `session/new`（检查挂到对应工作区、挂上 `agent-collab` 预设、`DSH_AGENT_COLLAB_ROLE` 注入了：让假 LLM 调 shell 执行 `echo $DSH_AGENT_COLLAB_ROLE`，看工具结果）→ `session/prompt` 收到通知 → 写工作区外的文件触发审批，收到 `approval_pending`，被应答后收到 `approval_resolved` → `session/cancel` 结束轮次，`stoppedBy` 为 `client` → 断开重连 `session/resume` 补发不缺不重 → 停止 dsh Web 后发现文件被删除。
  - 集成测试里没有人来批准，也没有人点停止：可以在临时 `DSH_HOME` 里另装一个只用于测试的 dsh 插件（放在 `tests/fixtures/` 下，参照 experiments/1a/04），由它应答审批、报告工作区和预设、在 dsh 内部取消会话来模拟“在 Web 里点停止”（检查 `stoppedBy` 为 `human`）。真人在 Web 里操作的情况由 S6 的 T3、T6 验证。
  - pnpm 按 harness 的做法：PATH 上有就用，没有就用 corepack 装到临时目录（首次会联网下载 pnpm，这一点写进 dev-setup.md）。
- `docs/dev-setup.md` 的“集成测试”表格加上 `bridge-dsh.mjs` 一行，写明前置条件。

## 验收标准

- AC1：第 1 步的探针有结论，汇报里附抓到的请求格式；不成立时本任务到此为止。
- AC2：`dsh-bridge/` 的文件和第 2 步一致；版本号和根目录相同（有测试）；没有 `dependencies`；dsh 版本范围的声明方式不会让 pnpm 联网下载 dsh（汇报里给出依据）。
- AC3：`npm run build` 产出 `dist/dsh-bridge-<版本>.tgz`，`--out` 生效；`tests/build.test.mjs` 不往仓库里写文件。
- AC4：第 4 步单元测试列出的每一项都有用例，全部通过。
- AC5：`node tests/integration/bridge-dsh.mjs` 用 RUNBOOK“重跑第 1a 阶段的实验”里的 bwrap 命令运行（你的会话里套不了 bwrap 就直接运行，汇报里说明），最后一行是 `RESULT: 通过`；结束后临时目录已删除，没有残留进程。
- AC6：dsh 内部服务的调用只出现在 `dsh-bridge/lib/dsh-api.js`（有自动检查）。
- AC7：汇报里列出 dsh 事件的实际字段：`turn/end` 的 `reason.kind` 有哪些值、用量在哪个事件的哪个字段、人在 Web 里停止和本连接取消在事件上有什么区别、`assistant/chunk` 和思考内容分别是什么事件。
- AC8：`npm test` 全部通过，`npm run build` 退出码 0；S1 的 `tests/integration/acp-client-dsh.mjs` 仍然通过；仓库仍然没有任何依赖；每个新文件开头有一行职责说明；不出现写死的路径和端口（测试里的临时目录和随机端口除外）。

## 非目标

- 不做运行时的 `run.mjs`、`watch.mjs`、`bin/collab.mjs`（S3），不做 `adapters/dsh.mjs`、自动启动 Web、退回 acp、`doctor`（S4）。
- 不改 `core/` 下 S1 的模块，`core/jsonrpc.mjs` 有 bug 要改时先汇报，不要只改桥接那一份。
- 不做 Windows、macOS 上的集成测试（单元测试和构建要在三平台通过）。
- 不处理 dsh 桌面版。

## 隔离和安全（违反任何一条都算不通过）

- 遵守 RUNBOOK“派发 dsh 任务”的全部规定。本步不需要真实模型，**不使用第 6 条的例外**：不读真实 `DSH_HOME` 下的任何文件，不建 `.env` 链接。
- 被测 dsh 一律用临时 `DSH_HOME`，脚本运行任何 `dsh` 命令前断言它在系统临时目录下；`dsh web` 一律加 `--port 0 --no-open`；缓存重定向到临时目录（RUNBOOK 第 4 条）。
- 只停止自己 spawn 的进程（按 PID）；不执行 kill/pkill/killall/fuser 按名字或端口找进程；不访问 dsh 的默认端口。
- 遇到需要越权（审批）的操作：不要申请，记为发现。
- 不执行 git commit、git push；不修改 docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。发现与它们不一致的地方，写进汇报。

## 汇报

在对话里汇报：第 0 步的原样输出；第 1 步探针的结论和抓到的请求格式；新建或修改的文件清单；逐条 AC 的结果和证据（命令及输出摘要）；AC7 的 dsh 事件字段；dsh 版本范围的声明方式和依据；`npm test` 的结果；集成脚本的最后几行输出；清理检查的方法和结果；和 PLAN.md、protocol.md 不一致的地方；没做完的项、遇到的问题和你的疑问。
