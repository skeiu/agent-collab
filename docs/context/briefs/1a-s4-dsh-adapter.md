本文件：第 1a 阶段实现第 S4 步（dsh 适配器、探测、基础版 doctor，附带 S3 的一处遗留）交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-24【已确认】用户 2026-10-24，由 Claude 在 dsh Web 派发。依据：PLAN.md §4.3、§5、§9、§10、§11.3–11.5、§11.8、§11.9、§12.2；protocol.md 第 1–3 节、第 6 节；本稿同时起草了 PLAN.md §4.3、§11.5，protocol.md §3“dsh 适配器另外约定”、§6 `doctor` 的补充，以及 1a-impl-plan.md S4 验收标准的一处措辞，用户审阅后同意【已确认】用户 2026-10-24。S1–S3 留给本步的事项：`AcpClient` 断开后要调用 `close()`（S2）；实时和重新接上两条路径的最终文字要一致（S3 CI 修复）；`model` 的两种写法和 `inheritEnv` 按真实 dsh 核对（S1）；`run cancel` 结束工作进程那条路径没有处理 `lock_unreadable`（S3 winlock）。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”、docs/context/1a-impl-plan.md 的“步骤”和“各步验收标准”，再读 docs/protocol.md 的“通用约定”、第 1–4 节和第 6 节的 `doctor`。docs/PLAN.md 只读：§4.3、§5.4–5.7、§9.1、§9.4、§9.5、§10、§11.3–11.5、§11.8、§11.9、§12.2（先用 `grep -n '^#' docs/PLAN.md` 定位，不要全文读）。experiments/1a/12-acp-overlay/ 是覆盖层的实测，tests/integration/dsh-harness.mjs 是临时 dsh 环境的现成脚手架，可以参考或复用。

现有模块直接用：`core/acp-client.mjs`、`core/jsonrpc.mjs`、`core/config.mjs`、`core/executor.mjs`、`core/platform.mjs`、`core/git.mjs`、`core/rundir.mjs`。测试用的 `tests/fixtures/fake-dsh.mjs` 加 `dsh-bridge/lib/index.js` 的 `apply` 可以在进程里跑起一个真的桥接（`tests/bridge.test.mjs` 就是这样用的）。

## 第 0 步：沙箱自检（必须先做）

同 S3 原任务书（docs/context/briefs/1a-s3-runtime.md）第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 任务

全部用 Node ≥ 20 的内置模块，ESM，不加依赖。

1. **`core/detect.mjs`**：PLAN.md §4.3 里和 dsh 有关的探测，每项都可以注入（环境变量、平台、文件系统位置、登录 shell 的探测函数），方便测试。
   - dsh 命令：`executors.dsh.command`，否则在 PATH 上找 `dsh`。从它解析出入口 `.js` 文件：POSIX 上跟随符号链接，或识别 npm 生成的 shell 包装；Windows 上解析 npm 生成的 `.cmd` 包装（`%dp0%\…\bin.js` 这类写法）。解析不出入口时如实报告原因，不猜。
   - dsh 版本：入口所在包的 `package.json`，读不到时再运行 `--version`。dsh 包目录由入口推出，后面找 YAML 库要用。
   - `DSH_HOME`：依次是配置 `dsh.home`、当前环境的 `DSH_HOME`、登录 shell 环境里的 `DSH_HOME`、`~/.dsh`。登录 shell 只在 POSIX 上探测（`$SHELL -l -c …`，带超时，失败当作没有）；Windows 上跳过并说明。`inheritEnv` 为 `login-shell` 时，执行端和自动启动的 dsh Web 用同一个探测函数取得的环境。
   - 发现文件：读 `$DSH_HOME/agent-collab/bridge-<profile>.json`，判断在线（文件存在、格式对、`pid` 存活、没有 `problem`、协议范围和本运行时有交集）；不在线时给出原因。
   - 桥接是否装进了 profile：看 `$DSH_HOME/profiles/<profile>/package.json` 的依赖里有没有桥接包（包名取 `dsh-bridge/package.json` 的 `name`）。先在临时 `DSH_HOME` 里 `dsh plugin add` 一次，核实 dsh 实际把它记在哪个字段，汇报。
   - 另外在 dsh 安装目录（只读）里再查一遍：有没有能判断“某个 profile 的 dsh Web 正在运行”的文件或机制。Claude 粗查没找到（PLAN.md §4.3 的【待核实】）。找到了就汇报依据，先不用。
2. **`core/adapters/dsh.mjs`**：按 protocol.md 第 3 节实现接口，含 §3 新加的“dsh 适配器另外约定”。连接顺序按 PLAN.md §11.5（本稿改过第 2、3 条）：
   - **选连接方式**（每次 `start`、`resume`、`attach` 各自选）：`dsh.transport` 为 `acp` 直接 acp。为 `auto` 或 `bridge` 时：发现文件在线且 `initialize` 成功 → 桥接。否则 profile 里装了桥接且 `autoStartWeb` 为 true → 自动启动 Web 并等发现文件。都不行时，`auto` 退回 acp，`bridge` 抛 `executor_unavailable`。`unauthorized`、`protocol_incompatible`、发现文件带 `problem` 都算桥接不可用。
   - **自动启动 Web**：用 `process.execPath` 运行解析出的入口，参数 `--profile <dsh.profile>`；`openBrowserOnStart` 为 false 时加 `--no-open`；再追加 `dsh.webArgs`。设置 `DSH_HOME`；detached、unref，Windows 上加 `windowsHide`。标准输出和错误写进 `AGENT_COLLAB_HOME` 下的日志文件（0600，里面有带令牌的地址），路径在汇报里写明，由 Claude 回填 PLAN.md §7.2。等一个 `startedAt` 晚于本次启动、`pid` 存活的发现文件，最多 60 秒（测试用 `AGENT_COLLAB_TEST_WEB_START_TIMEOUT_MS` 缩短）。等到之前 Web 退出了，或者超时，都按桥接不可用处理，`warning` 里写明原因和 Web 的 pid（超时的那个不结束，它是用户的 Web 了）。同一 `DSH_HOME` 加 profile 的自动启动要串行：用 `AGENT_COLLAB_HOME` 下独占创建的互斥文件，拿不到就只等发现文件，保证两个任务同时派发时只启动一个 Web。
   - **桥接模式**：TCP 连发现文件里的地址；`initialize` 带令牌、协议范围、运行时版本（取根目录 `package.json` 的 `version`）。`session/new` 按 protocol.md §2.3 填写：
     - `title` 拼成 `[collab] <runId> <title>`；
     - `options.agentPreset` 是默认值 `agent-collab` 时传 `null`，交给桥接按 §9.5 选，好让它不可用时退回 `standard`；其他值照传；
     - `env` 只传 `DSH_` 开头的键，其他键各写一条 `warning` 后丢弃，并总会带上 `DSH_AGENT_COLLAB_ROLE: "executor"`；
     - `model`、`reasoningEffort` 见下面的“模型”。
     
     通知按 protocol.md 第 4 节转成统一事件，`cursor` 为 `{ seq, sub }`；`seq` 为 `null` 的通知不带 `cursor`。一轮的结果取 `session/prompt` 的返回；`attach` 接上仍在进行的一轮时，没有 `session/prompt` 的返回，以 `_agentCollab/status` 的 `turn_end` 结束这一轮。
   - **acp 模式**：用 `process.execPath` 运行入口，参数 `--profile acp --patch <覆盖层>`，`cwd` 为仓库根目录。环境以 `inheritEnv` 选定的环境为底，加上配置的 `env`、`AGENT_COLLAB_ROLE=executor`、`DSH_AGENT_COLLAB_ROLE=executor`、`DSH_PERMISSION_MODE=<permissionPreset>`、`DSH_HOME`。
     - 覆盖层按 PLAN.md §11.5：从 `$DSH_HOME/profiles/<dsh.profile>/cordis.patch.yml` 挑出 `llm-*` 和 `agent-default-model` 条目，加上 `acp` 条目的 `provider`、`model`。
     - YAML 用 dsh 安装目录里自带的 `yaml` 包（1a 实现决定 2，见 docs/context/DECISIONS.md）：先查 dsh 自己怎么加载 patch，尽量和它的解析方式一致，`!!js` 这类标签必须原样保留；找不到库时 acp 模式不可用，报告原因。挑条目的逻辑写成对解析结果操作的纯函数，单独测试。
     - 覆盖层写在 `AGENT_COLLAB_HOME` 下的私有目录（0700/0600），`close()` 时删除；不修改 acp profile 的任何文件。
     - 审批交给 `AcpClient` 的 `permissionPolicy`（`unattendedApproval` 为 `deny` 时 `deny`，为 `allow` 时 `allow`），每次都写一对 `approval` 事件（`pending` 和带结果的 `resolved`）。
     - `stopReason` 换算成 `endReason`；`stoppedBy` 在本连接发过 `session/cancel` 时为 `client`，否则为 `null`。换算表写在汇报里。
     - `attach` 返回 `attached: false`；`resume` 另起一个子进程，先 `session/resume` 再发消息。dsh-acp 有没有用量，有就转成 `usage` 事件。
   - **模型**（S1 留下的疑问）：`options.model` 可能是字符串或 `{ provider, model }`，`reasoningEffort` 是 `follow`、`low`、`medium`、`high`、`max` 之一。先查 dsh 的 `agent-default-model`、ACP `session/set_config_option` 的 `model` 和 `reasoning_effort` 实际接受什么值（experiments/1a/12-acp-overlay 里看到的当前值是 `["example-provider","example-model"]` 这样的数组）。再定映射：
     - 字符串写法：建议按第一个 `/` 拆成服务商和模型；拆不开时写 `warning`，跟随 dsh 的设置；
     - `follow` 映射为 `null`；
     - 其余档位映射到 dsh 最接近的档位，映射不了的写 `warning`。
     
     桥接模式下通过 `session/new` 传入；acp 模式下配置里明确指定了才用 `session/set_config_option` 设置，没指定就用覆盖层带来的默认模型。实测结论和映射表写进汇报，由 Claude 回填 PLAN.md 和 protocol.md。
   - **最终文字**：写一个函数，从一轮的统一事件按 protocol.md 第 3 节算 `finalText`。实时一轮和 `attach` 带回的结果都用它，且输入是同样的统一事件。桥接模式下，`attach` 的补发要覆盖这一轮的全部事件，但只把 `sinceCursor` 之后的事件交给 `onEvent`。
   - **断开**：`AcpClient` 发出 `close` 时调用 `client.close()`（S2 留下：`JsonRpcPeer` 只发 `close`，不回收底层的 socket 或子进程），进行中的一轮以错误结束；`close()` 可以重复调用。
   - `capabilities()`：桥接模式 `liveView`、`humanApproval`、`resume` 为 true；acp 模式 `liveView`、`humanApproval` 为 false；`images` 按 `initialize` 的结果；`structuredOutput` 为 false。连接方式还没定时，按“会走的那一种”回答，或在汇报里说明你的做法。
3. **`core/doctor.mjs`** 和 `bin/collab.mjs` 的 `doctor` 命令：按 protocol.md 第 6 节（含本稿补的 `id`、`level`、`webRunning`、`installed`、退出码、人看的格式和 `--deep`）。`git` 用 `core/git.mjs`，`activeRun` 用 `core/rundir.mjs` 的锁和运行目录；桥接在线时连上 `initialize` 取 `agentPresets`，然后断开。`doctor` 只读，不启动 Web，不写任何文件。
4. **S3 的遗留**：`core/run.mjs` 的 `run cancel` 在工作进程不响应、按 PID 结束它之后收尾时，`releaseLock` 抛 `lock_unreadable` 会让命令以错误退出，可状态已经记成了 `cancelled`。改成和“对停下的任务取消”那条路径一样：捕获这个错误，在 stderr 提示一句“锁未释放，留给下一次获取时按旧锁处理”，仍然输出 `{ ok: true, runId, status: "cancelled" }`、退出码 0。其他错误照旧抛出。

## 测试

### 单元测试（进 `node --test`）

不需要真的 dsh。建一个假的 dsh 安装（`tests/fixtures/` 下新建，例如 `fake-dsh-cli.mjs`）：
- 放在临时目录里，做成“包目录 + 入口 .js + PATH 上的 `dsh` 包装”的样子；
- 自带一个只给测试用的极简“YAML 库”：用 JSON 当 YAML（JSON 是 YAML 的子集），只验证接线，真正的 YAML 解析在集成测试里验；
- `--profile web` 时在进程里用 `fake-dsh.mjs` 加桥接的 `apply` 跑一个桥接，写出发现文件；
- `--profile acp` 时当 ACP stdio 代理，可以复用 `fake-acp-agent.mjs` 的做法；
- 每次被调用都把参数、关键环境变量和 `--patch` 文件的内容记进测试给的记录文件。

测试经 `bin/collab.mjs run start --executor dsh` 走完整的工作进程，用临时的 `AGENT_COLLAB_HOME`、`DSH_HOME`、PATH 和 git 仓库，配置里设 `openBrowserOnStart: false`。

### 集成测试 `tests/integration/adapter-dsh.mjs`（不进 `node --test`，一条命令运行，最后一行 `RESULT: 通过|不通过` 加一句说明）

用真的 dsh 和假 LLM 服务，按 RUNBOOK“派发 dsh 任务”第 3、4 条建临时环境：
- 临时 `DSH_HOME`，运行前断言它在临时目录下；
- dsh Web 一律 `--port 0 --no-open`，自动启动的场景用配置 `dsh.webArgs: ["--port", "0"]`、`openBrowserOnStart: false`；
- 缓存目录重定向到临时目录。

假 LLM 让执行端写一个文件，再给出合法的汇报 JSON。在临时 git 仓库里依次跑：
- I1：Web 已开、桥接在线 → 任务 `done`，`transport` 为 `bridge`；
- I2（T7）：Web 没开、profile 里装了桥接 → 适配器自动启动 Web，任务 `done`；
- I3（T8）：profile 里没装桥接 → 不启动 Web，退回 acp，任务 `done`。`events.jsonl` 有退回的 `warning`；acp 会话用的是 web profile 用户层里的假 LLM 服务商和默认模型；web profile 的 `cordis.patch.yml` 里事先放一个带 `!!js` 的条目，覆盖层里它原样保留；acp profile 的配置文件前后哈希不变（dsh 第一次运行时自己建的模板文件除外，汇报里列出）；
- 每个场景各跑一次 `doctor --json`，结果和场景一致。

结束后按 PID 停掉所有 dsh Web（包括适配器自动启动的那个，pid 从发现文件里取），删除临时目录。docs/dev-setup.md 的集成测试表由 Claude 回填，你在汇报里给出前置条件和运行命令。

## 验收标准

- DA1 detect：入口解析覆盖 POSIX 符号链接、POSIX shell 包装、Windows `.cmd` 包装（`.cmd` 的解析写成纯函数，所有平台都测）；`DSH_HOME` 的四级优先顺序各一个用例；发现文件的不存在、`pid` 不存活、带 `problem`、格式错、协议无交集各一个用例；桥接是否装进 profile，装了和没装各一个用例。
- DA2 桥接模式：任务 `done`。`session/new` 收到的参数符合 protocol.md §2.3：标题格式、`agentPreset` 为默认值时传 `null`、`env` 只有 `DSH_` 键且带 `DSH_AGENT_COLLAB_ROLE`、被丢弃的键各有一条 `warning`。统一事件和桥接发出的通知一一对应，`cursor` 正确。在 dsh Web 里停止的一轮记为 `stopped_by_human`；`run cancel` 后记为 `cancelled`。
- DA3 最终文字一致：脚本让一轮先调用工具、再出一段文字 A，此时按 PID 结束工作进程；这一轮在工作进程不在期间再出文字 B 并结束。`run wait` 接上后，汇报按 A+B 提取，和同一脚本不杀工作进程时算出的 `finalText` 相同；`events.jsonl` 不缺不重。另一个用例：接上时这一轮仍在进行，以 `turn_end` 通知结束，结果正确。
- DA4 断开：一轮进行中桥接断开连接 → 任务以 `failed` 结束、`statusReason` 说明原因；适配器调用了 `client.close()`，底层 socket 已销毁，测试进程没有遗留句柄（`node --test` 能正常退出）。反证：副本里去掉这次 `close()` 调用，这个用例失败，汇报断言原文。
- DA5 自动启动：没装桥接时不启动 Web，退回 acp 并有 `warning`；装了桥接、`autoStartWeb` 为 true 时只启动一次，参数含 `--profile`、`--no-open` 和 `webArgs`，等到发现文件后任务 `done`；`autoStartWeb` 为 false 时退回 acp；启动的 Web 提前退出、等发现文件超时，各一个用例，都退回 acp，`warning` 写明原因；两个仓库同时派发、都需要自动启动时，只启动一个 Web；`transport` 为 `bridge` 而桥接不可用时，任务 `failed`，原因里有 `executor_unavailable`。
- DA6 acp 模式：
  - 子进程的参数和环境符合任务 2：两个防套娃变量、`DSH_PERMISSION_MODE`、`DSH_HOME`，`inheritEnv` 的两种取值各一个用例；
  - 覆盖层的内容符合挑选规则，挑选函数的单元测试覆盖：只有服务商、只有默认模型、两者都有、有无关条目、配置明确指定了模型；
  - 覆盖层在 `close()` 后被删除；
  - 审批按 `unattendedApproval` 的两种取值应答，并写出成对的 `approval` 事件；
  - 续接（`run resume`）另起子进程，`session/resume` 后发消息，任务正常结束；
  - 工作进程被结束后 `run wait` 记为 `failed`（`worker_lost`）。
- DA7 doctor：`--json` 输出符合 protocol.md 第 6 节。下列情形各一个用例，`checks` 的 `id`、`level`、`ok` 和退出码都对：
  - 一切正常；
  - 不是 git 仓库；
  - 工作区有改动；
  - 找不到 dsh；
  - 桥接不在线（装了和没装各一个，`webRunning` 分别为 `false`、`null`）；
  - 发现文件带 `problem`；
  - `agent-collab` 预设不可用；
  - 本仓库有进行中的任务；
  - `transport` 为 `bridge` 且桥接不在线（`bridge` 升为 `error`、顶层 `ok` 为 false、退出码 1）。
  
  不带 `--json` 时每项一行；`--deep` 退出码 2。`doctor` 前后临时 `DSH_HOME`、`AGENT_COLLAB_HOME` 下的文件列表不变。
- DA8 集成：`node tests/integration/adapter-dsh.mjs` 按 RUNBOOK“重跑第 1a 阶段的实验”里的 bwrap 命令运行（你的会话里套不了 bwrap 就直接运行，汇报里说明），最后一行 `RESULT: 通过`；I1–I3 和每个场景的 `doctor` 都通过；结束后临时目录已删除，没有残留的 dsh 进程。S1、S2 的 `tests/integration/acp-client-dsh.mjs`、`bridge-dsh.mjs` 仍然通过。
- DA9 S3 遗留：在 Linux 上造一个读不出来的锁（例如工作进程被冻住期间，把 `active.lock` 换成同名目录），走 `run cancel` 按 PID 结束工作进程的路径：退出码 0，输出 `ok: true`、`cancelled`，stderr 有提示，`active.lock` 目录还在，`state.json` 为 `cancelled`。反证：副本里去掉这次捕获，用例失败，汇报断言原文。
- DA10 回归：`npm test` 连跑 3 次全部通过，本步新增的测试合计在 60 秒内跑完；每次跑完没有残留的 `fake-executor`、`fake-dsh-cli`、`run.mjs --worker` 进程（用 `pgrep` 时别匹配到命令自己所在的 shell）。`npm run build` 退出码 0；仓库仍然没有任何依赖；每个新文件开头有一行职责说明；不出现写死的路径和端口（测试里的临时目录和随机端口除外）；测试不读写真实的 `~/.agent-collab` 和 `~/.dsh`。
- Windows、macOS 上的效果这边测不了，由 Claude 提交推送后看 CI。

## 非目标

- 不做完整版 `doctor`（端点和模型、图片能力、运行时目录权限、`--deep` 冒烟）、`setup.mjs`、`installed.json`（1b）。acp profile 目录是否因我们而出现，只在汇报里说明观察到的情况，不记录。
- 不做 codex、claude 适配器（第 2 阶段）；不处理 `images`，参考图路径由 S5 的 skill 写进任务书。
- 桥接断开后的自动重连不做：工作进程还活着时断开就以错误结束这一轮，工作进程不在时由 `run wait` 的 `attach` 接上。
- 不改 `dsh-bridge/`、`core/worker.mjs`、`core/rundir.mjs`、`core/events.mjs`、`scripts/build.mjs`。确实要改时只改最小的一处，并在汇报里单列理由。发现桥接的 bug 只汇报，不修。

## 隔离和安全（违反任何一条都算不通过）

- 遵守 RUNBOOK“派发 dsh 任务”的全部规定。被测 dsh 只在临时 `DSH_HOME` 里运行，`--port 0 --no-open`，不访问 dsh 的默认端口；不读写 `~/.dsh`，不读 `.env`；不调用真实模型，只用假 LLM 服务（本步没有 R6 的真实模型例外）。可以只读 dsh 安装目录里的源码和文档。
- 测试只在系统临时目录下建 git 仓库、`AGENT_COLLAB_HOME`、`DSH_HOME`；不在本仓库里运行 `run start`。
- 只停止自己 spawn 的进程（按 PID；自动启动的 Web 按发现文件里的 pid）；不执行 kill/pkill/killall/fuser 按名字或端口找进程。
- 遇到需要越权（审批）的操作：不要申请，记为发现。
- 不在本仓库执行 git commit、git push、切分支（测试在临时仓库里做这些可以）；不修改 docs/ 下的任何文件（包括 PLAN.md、protocol.md、dev-setup.md 和 docs/context/）和 AGENTS.md。发现与它们不一致的地方，写进汇报。新增 `AGENT_COLLAB_TEST_*` 变量时在汇报里列出，由 Claude 回填 dev-setup.md。

## 汇报

在对话里汇报：
- 第 0 步的原样输出；
- 新建或修改的文件清单；
- 逐条 DA 的结果和证据（命令及输出摘要），反证的断言原文；
- 任务 1 的三处核实：桥接记在 profile `package.json` 的哪个字段、有没有标记 Web 实例的机制、YAML 库和 `!!js` 的处理办法；
- 任务 2 的模型和思考强度的实测与映射表、`stopReason` 的换算表、acp 模式有没有用量；
- 自动启动 Web 的日志文件和覆盖层所在的位置；
- 你加的 `AGENT_COLLAB_TEST_*` 变量；
- 集成测试的前置条件和运行命令；
- `npm test` 的结果和本步测试的耗时；
- 你开过的所有后台任务及其结束情况，清理检查的方法和结果；
- 和 PLAN.md、protocol.md 不一致或没写清楚的地方；没做完的项和疑问。
