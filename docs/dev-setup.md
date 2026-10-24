本文件：开发前置条件，以及运行测试和构建的命令。开发或调试本项目时读；前置条件、命令或 1a 阶段的手动安装步骤变化时更新。

# 开发准备

## 前置条件

- Node.js ≥ 20（用 `node --version` 确认）。项目只用 Node 内置模块，不需要 `npm install`，仓库里没有任何依赖。
- git：用于版本控制和查看改动。

## 运行测试

```bash
npm test
# 等价于
node --test --test-timeout=60000
```

`--test-timeout=60000` 让每个测试文件最多运行 60 秒：用例卡住，或用例结束后留下的计时器让文件进程不退出，都会在 60 秒内记为失败并报出该测试文件，避免整条 CI 一直不结束。【已验证】2026-10-24，Node 22 上两种情形都按文件超时失败；用例先抛错再挂住时，还会报出该用例名和错误。

测试会自己创建临时目录，只使用系统临时目录（`os.tmpdir()`），不依赖开发机的特有配置。

### 运行时测试用的环境变量

`tests/run-*.test.mjs` 用假执行端（`tests/fixtures/fake-executor.mjs`，独立进程）和假适配器测试 `run`、`watch`，并用下面的环境变量缩短等待时间。这些变量只给测试用，正式配置项不受影响；`AGENT_COLLAB_TEST_ADAPTER` 以外的变量不设时用括号里的默认值。

| 变量 | 作用 |
|---|---|
| `AGENT_COLLAB_TEST_ADAPTER` | 适配器模块的绝对路径，代替按执行端名查找 `core/adapters/<name>.mjs` |
| `AGENT_COLLAB_TEST_IDLE_TIMEOUT_MS` | 卡死阈值（`idleTimeoutMinutes` × 60000） |
| `AGENT_COLLAB_TEST_STALL_POLL_MS` | 工作进程检查卡死的间隔（5000） |
| `AGENT_COLLAB_TEST_CANCEL_POLL_MS` | 工作进程检查 `cancel.request` 的间隔（500） |
| `AGENT_COLLAB_TEST_CANCEL_WAIT_POLL_MS` | `run cancel` 自己轮询状态的间隔（100）；和上一项分开，测试可以只冻结其中一边 |
| `AGENT_COLLAB_TEST_CANCEL_TIMEOUT_MS` | `run cancel` 等工作进程确认的时长（10000） |
| `AGENT_COLLAB_TEST_KILL_GRACE_MS` | `run cancel` 发 SIGTERM 后等多久再发 SIGKILL（2000） |
| `AGENT_COLLAB_TEST_WAIT_POLL_MS` | `run wait` 轮询状态的间隔（200） |
| `AGENT_COLLAB_TEST_ATTACH_GRACE_MS` | `run wait` 两次启动新工作进程的最小间隔（1500） |
| `AGENT_COLLAB_TEST_WATCH_POLL_MS` | `watch` 轮询事件的间隔（100） |
| `AGENT_COLLAB_TEST_STATE_WRITE_FAIL_ONCE` | 设为 `1` 时让工作进程第一次写 `state.json` 失败，测试写入失败不退出 |
| `AGENT_COLLAB_TEST_PAUSE_AFTER_START_MS` | 工作进程 `start` 返回后、写 `sessionId` 之前暂停的毫秒数（0），露出“会话已建、`sessionId` 还没落盘”的窗口 |
| `AGENT_COLLAB_TEST_SUMMARY_DELAY_MS` | 收尾时写 `summary.json` 之前暂停的毫秒数（0） |
| `AGENT_COLLAB_TEST_PAUSE_BEFORE_RELEASE_MS` | 收尾时终态写盘之后、释放仓库锁之前暂停的毫秒数（0） |
| `AGENT_COLLAB_TEST_WEB_START_TIMEOUT_MS` | dsh 适配器自动启动 Web 后等发现文件的时长（60000） |

`AGENT_COLLAB_FAKE_EXECUTOR`（假执行端的 `host:port`）只由测试传给假适配器，运行时不读它。

假执行端的脚本（JSON）除了按轮次列出步骤，还支持：步骤 `{ "kind": "wait_for_attach", "ms"? }`（停在这一轮里，直到这一轮收到过一次 `attach`，用来保证“接上时这一轮还在进行中”）；顶层开关 `afterTurnEnd: { triggerFile | ms, event, timeoutMs? }`（一轮结束后等触发文件出现或固定毫秒，再补发一条事件）和 `emitSessionOnStart`（`start` 期间自己发 `session` 事件）。一轮结束时，若脚本的 `end.finalText` 不能从这一轮的 text 事件按 [protocol.md](protocol.md) §3 的规则算出，假执行端会补一条 text 事件，使 `turn_end` 消息和补发的事件给出同一份最终文字。传了 `--record <文件>` 时，另外写 `<文件>.starts.jsonl`、`<文件>.attaches.jsonl`（每次 `attach` 时这一轮是否在跑）和 `<文件>.commands.jsonl`（收到的命令）。每个用例在系统临时目录下新建 git 仓库和 `AGENT_COLLAB_HOME`，结束时按 PID 结束自己启动的工作进程和假执行端。对 `run start`、`run wait`、`run status` 返回的任务状态，测试用 `tests/helpers/run-harness.mjs` 的 `assertTaskStatus` 断言。断言失败时会带上这次命令的 stdout、stderr 和运行目录的诊断：`status`、`statusReason`、`worker.log` 最后 40 行、最近 10 条事件的类型。这样 CI 失败时，直接看日志就能定位。【已验证】2026-10-24，Linux、Node 22：`npm test` 连跑 3 次 155/155，跑完无残留进程。

dsh 适配器的测试（`tests/detect.test.mjs`、`dsh-adapter`、`dsh-autostart`、`dsh-acp`、`doctor`）不用真 dsh：`tests/helpers/fake-dsh-install.mjs` 在临时目录里装一个假的 dsh 包（入口 `tests/fixtures/fake-dsh-cli.mjs`），`--profile web` 时在进程里跑真的桥接（`tests/fixtures/fake-dsh.mjs` 加 `dsh-bridge/lib/index.js`）并写发现文件，`--profile acp` 时当 ACP stdio 代理；`tests/helpers/dsh-case.mjs` 准备临时仓库、`AGENT_COLLAB_HOME`、`DSH_HOME` 和配置。假 dsh 自己读的变量 `FAKE_DSH_REPO_ROOT`、`FAKE_DSH_RECORD`（记录参数、环境和 `--patch` 内容的文件）、`FAKE_DSH_STATE_FILE`、`FAKE_DSH_TURNS`（按轮次的脚本）、`FAKE_DSH_PRESETS`、`FAKE_DSH_DEFAULT_MODEL`、`FAKE_DSH_WEB_MODE`（Web 正常、提前退出或不写发现文件）只由测试设置。【已验证】2026-10-25，Linux、Node 22：`npm test` 连跑 3 次 197/197，跑完无残留进程。

## 集成测试

`tests/integration/` 下的脚本需要真实工具，不进入 `node --test`；用下面的命令单独运行（前置条件：Linux、Node.js ≥ 20、PATH 上有 `dsh`）：

| 脚本 | 用途 | 运行命令 |
|---|---|---|
| `acp-client-dsh.mjs` | 在临时 `DSH_HOME` 里用一个不可达的假服务商启动 `dsh --profile acp`，依次执行 `initialize`、`session/new`、`session/close` | `node tests/integration/acp-client-dsh.mjs` |
| `bridge-dsh.mjs` | 在临时 `DSH_HOME` 里安装桥接和测试插件，用假 LLM 服务跑通发现文件、会话、工具、审批、取消、Web 内停止和重连补发；需要 PATH 上有 `dsh`，`pnpm` 或 `corepack`（corepack 首次取得 pnpm 会联网下载），不需要真实模型 | `node tests/integration/bridge-dsh.mjs` |
| `adapter-dsh.mjs` | 经 `bin/collab.mjs run start --executor dsh` 跑三个场景并各做一次 `doctor`：I1 桥接在线；I2 Web 没开、profile 装了桥接，自动启动 Web；I3 profile 没装桥接，退回 `dsh --profile acp`（核对覆盖层里的 `!!js` 原样保留、web profile 的 `cordis.patch.yml` 不变）。前置条件同上一行，用假 LLM 服务 | `node tests/integration/adapter-dsh.mjs` |

脚本只使用系统临时目录，不调用模型；最后一行输出 `RESULT: 通过` 或 `RESULT: 不通过 — 原因`，退出码非 0 表示失败。运行结束后临时目录会删除，自己启动的进程会按 PID 结束。`tests/fixtures/` 下是测试用的假对端，也不会被 `node --test` 当成测试运行。

## 构建

```bash
npm run build
# 等价于
node scripts/build.mjs
```

构建脚本定位仓库根目录后逐项执行：目前只实现“打包桥接 .tgz”，把 `dsh-bridge/` 打成 `dist/dsh-bridge-<版本>.tgz`（可用 `--out <目录>` 改输出位置）；生成 SKILL.md 和组装运行时仍报告尚未实现。

【已验证】2026-10-23：`npm test` 与 `npm run build` 在 Linux、Node.js 22 上通过，退出码 0。Linux、macOS、Windows 上 Node 20 和当前 LTS 的 `npm test` 由 CI 验证：【已验证】2026-10-24，CI 运行 40056577654（`a67780f`）6 组全部通过；集成测试和构建不在 CI 里。

## 1a 阶段的手动安装步骤

暂无，第 1a 阶段补充。
