本文件：S4（[1a-s4-dsh-adapter.md](1a-s4-dsh-adapter.md)）验收后的小返工任务书原文（交给 dsh）。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿并在 dsh Web 派发，用户未逐份审阅。依据：Claude 2026-10-25 对 S4 的验收（DA1–DA10 重跑通过，见 [1a-impl-plan.md](../1a-impl-plan.md)“进展”）。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S4 原任务书 docs/context/briefs/1a-s4-dsh-adapter.md（隔离和安全规则照旧有效）。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

S4 的 DA1–DA10 Claude 重跑都通过（`npm test` 3 次 195/195，三个集成脚本通过，DA4、DA9 反证成立）。审查代码时发现三处小问题：

- `core/adapters/dsh.mjs` 的 `loadYamlLibrary` 找不到 `js-yaml` 时退到 `yaml` 包，而 `yaml` 分支不带 `!!js` 类型：解析时 `!!js` 标量变成普通字符串，写回覆盖层后标签丢失，dsh 会把表达式原文当字符串用（例如鉴权头），而且没有任何提示。另外 `buildAcpOverlay` 在 web profile 没有 `cordis.patch.yml` 的分支里先建了覆盖层目录再加载 YAML 库，加载失败时目录留在 `overlays/` 下。
- `core/doctor.mjs` 不带 `--json` 的输出里，`info` 级检查项没通过时也印成 `WARN`。
- `core/doctor.mjs` 的 `bridgePresets` 里 `protocol`、`protocolMin`、`clientVersion` 写成了字面量，和适配器用的 `SUPPORTED_PROTOCOL`、`SUPPORTED_PROTOCOL_MIN`、`package.json` 的版本不是同一个来源。

## 任务

1. **YAML 只用 `js-yaml`**：`loadYamlLibrary` 去掉 `yaml` 包的分支，只从 dsh 包目录解析 `js-yaml` 并构造 `JsExpr` schema；找不到或接口不对时抛 `code` 为 `overlay_yaml_unavailable` 的错误，消息说明 acp 模式不可用。`buildAcpOverlay` 在任何一步失败时都不留下覆盖层目录（先拿到 YAML 库、生成内容，再建目录写文件；或失败时删掉已建的目录）。文件头的说明随之更新。
2. **doctor 文字输出**：通过的项印 `OK`；没通过的按 `level` 印 `FAIL`（error）、`WARN`（warn）、`INFO`（info）。`--json` 的输出不变。
3. **doctor 连接桥接的参数**：`bridgePresets` 的 `initialize` 用 `core/detect.mjs` 的 `SUPPORTED_PROTOCOL`、`SUPPORTED_PROTOCOL_MIN`，`clientVersion` 和 `clientInfo.version` 用仓库 `package.json` 的版本（和适配器一致）。

## 验收标准

- SR1：新增用例：假 dsh 安装里只有 `yaml`、没有 `js-yaml` 时，acp 模式（`transport: acp`）的任务 `failed`，`statusReason` 为 `overlay_yaml_unavailable`，`AGENT_COLLAB_HOME/overlays/` 下没有残留目录；web profile 没有 `cordis.patch.yml`、YAML 库也找不到时同样没有残留。反证：副本里恢复 `yaml` 分支，第一个用例失败，汇报断言原文。原有覆盖层用例（含 `!!js` 原样保留）仍通过。
- SR2：`tests/doctor.test.mjs` 增加断言：没装桥接（`webRunning: null`）时文字输出里 `dsh_web` 那行以 `[INFO]` 开头，`bridge` 那行以 `[WARN]` 开头。
- SR3：`tests/doctor.test.mjs`、`node tests/integration/adapter-dsh.mjs` 仍通过（集成测试按 S4 原任务书的方式运行）。
- SR4：回归：`npm test` 连跑 3 次全部通过，每次跑完没有 `fake-executor`、`fake-dsh-cli`、`run.mjs --worker` 进程（用 `pgrep` 时别匹配到命令自己所在的 shell）；`npm run build` 退出码 0，构建产生的 `dist/` 删掉。

## 隔离和安全

同 S4 原任务书。不执行 git commit、git push、切分支；只改 `core/adapters/dsh.mjs`、`core/doctor.mjs` 和 `tests/` 下的文件，不改其他产品代码、docs/ 下的任何文件和 AGENTS.md。只停止自己 spawn 的进程（按 PID）。遇到需要越权（审批）的操作：不要申请，记为发现。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 SR 的结果和证据（命令及输出摘要），反证的断言原文；你开过的所有后台任务及其结束情况；没做完的项和疑问。
