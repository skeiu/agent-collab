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
| `AGENT_COLLAB_TEST_CANCEL_POLL_MS` | 工作进程检查 `cancel.request` 的间隔（500）；`run cancel` 轮询状态的间隔也用它（100） |
| `AGENT_COLLAB_TEST_CANCEL_TIMEOUT_MS` | `run cancel` 等工作进程确认的时长（10000） |
| `AGENT_COLLAB_TEST_KILL_GRACE_MS` | `run cancel` 发 SIGTERM 后等多久再发 SIGKILL（2000） |
| `AGENT_COLLAB_TEST_WAIT_POLL_MS` | `run wait` 轮询状态的间隔（200） |
| `AGENT_COLLAB_TEST_ATTACH_GRACE_MS` | `run wait` 两次启动新工作进程的最小间隔（1500） |
| `AGENT_COLLAB_TEST_WATCH_POLL_MS` | `watch` 轮询事件的间隔（100） |
| `AGENT_COLLAB_TEST_STATE_WRITE_FAIL_ONCE` | 设为 `1` 时让工作进程第一次写 `state.json` 失败，测试写入失败不退出 |

`AGENT_COLLAB_FAKE_EXECUTOR`（假执行端的 `host:port`）只由测试传给假适配器，运行时不读它。每个用例在系统临时目录下新建 git 仓库和 `AGENT_COLLAB_HOME`，结束时按 PID 结束自己启动的工作进程和假执行端。【已验证】2026-10-24，Linux、Node 22：`node --test` 连跑 12 次 137/137，跑完无残留进程。

## 集成测试

`tests/integration/` 下的脚本需要真实工具，不进入 `node --test`；用下面的命令单独运行（前置条件：Linux、Node.js ≥ 20、PATH 上有 `dsh`）：

| 脚本 | 用途 | 运行命令 |
|---|---|---|
| `acp-client-dsh.mjs` | 在临时 `DSH_HOME` 里用一个不可达的假服务商启动 `dsh --profile acp`，依次执行 `initialize`、`session/new`、`session/close` | `node tests/integration/acp-client-dsh.mjs` |
| `bridge-dsh.mjs` | 在临时 `DSH_HOME` 里安装桥接和测试插件，用假 LLM 服务跑通发现文件、会话、工具、审批、取消、Web 内停止和重连补发；需要 PATH 上有 `dsh`，`pnpm` 或 `corepack`（corepack 首次取得 pnpm 会联网下载），不需要真实模型 | `node tests/integration/bridge-dsh.mjs` |

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
