本文件：第 1a 阶段实现第 S1 步（基础模块）交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-23，用户同日派发。所依据的实现决定 1、6、7 已经用户确认（[1a-impl-plan.md](../1a-impl-plan.md)）。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md，再读 docs/context/RUNBOOK.md 的“派发 dsh 任务”和 docs/context/1a-impl-plan.md。docs/PLAN.md 只读这些章节：§3 的 D3、§5.5、§7.1、§7.2、§11.3、§12.1、§12.2、§13（先用 `grep -n '^#' docs/PLAN.md` 定位，不要全文读）。

## 第 0 步：沙箱自检（必须先做）

运行下面两条命令，把输出原样写进汇报：

    pgrep -af dsh
    cat /proc/1/cmdline | tr '\0' ' '

输出里有用户日常运行的 dsh Web 进程（不是你自己沙箱里的进程），说明沙箱没有隔离进程：立即停止，只汇报这一步。

## 任务

实现下面几个不依赖桥接的基础模块，全部用 Node ≥ 20 的内置模块，ESM（`.mjs`），不加任何依赖。

1. `core/jsonrpc.mjs`：换行分隔的 JSON-RPC 2.0 对端，建在一对可读、可写流上。发请求并按 id 匹配响应；发通知；按方法名注册处理收到的请求和通知，没注册的请求回 `-32601`；收到无法解析的行回 `-32700` 并继续处理后续行；对端关闭时，所有未完成的请求以错误结束。正确处理一个数据块里有多条消息、一条消息跨多个数据块、多字节 UTF-8 字符被切开的情况。
2. `core/acp-client.mjs`：基于 jsonrpc.mjs 的 ACP v1 客户端（实现决定 1：自写，不附带 SDK）。
   - 两种连接：TCP（`host`、`port`）和 stdio（自己 spawn 子进程，参数 `command`、`args`、`env`、`cwd`）。
   - 方法：`initialize`、`session/new`、`session/resume`、`session/prompt`、`session/cancel`（ACP 里是通知）、`session/set_config_option`、`session/close`；另提供通用的扩展请求和扩展通知（方法名以 `_` 开头）。所有方法都允许传 `_meta`。
   - 事件：`session/update` 和其他通知按到达顺序交给调用方注册的回调。
   - 收到 `session/request_permission`：按创建客户端时给的策略（`deny` 或 `allow`）选对应 `kind` 的选项应答；`fs/*`、`terminal/*` 请求回 `-32601`，`initialize` 里也声明不支持这两类能力。
   - `close()`：断开连接；stdio 模式下结束自己 spawn 的子进程（按 PID，不按名字找）。
   - 方法名、参数和返回字段**以 dsh 安装目录里 `@agentclientprotocol/sdk` 的类型定义为准**（只读查看，不要复制它的代码）；在汇报里列出你核对了哪些字段、和 PLAN.md §5.5、§9.2 不一致的地方。
3. `tests/fixtures/fake-acp-agent.mjs`：测试用的假 ACP 代理，支持 stdio 和 TCP 两种模式。按测试给的脚本行为：`session/prompt` 时发若干 `session/update`、可选地发一次 `session/request_permission` 并把应答写进后续的 update、最后返回 `stopReason`；收到 `session/cancel` 时以 `cancelled` 结束当前 prompt。
4. `core/schema-check.mjs`：零依赖的精简 JSON Schema 校验器，配置和汇报共用。只支持 `type`（含类型数组）、`enum`、`minimum`、`maximum`、`properties`、`required`、`additionalProperties`（布尔或子 schema）、`items`；`title`、`description`、`default` 和所有 `x-` 开头的键忽略。遇到不支持的关键字直接抛错，不静默跳过。错误要带 JSON Pointer 形式的路径。
5. `config/config.schema.json` 和 `core/config.mjs`（PLAN.md §12.1、§12.2）：
   - schema 覆盖 §12.2 的全部配置项。每项有类型、`default`、可选值或范围，以及 `x-title: { zh, en }`、`x-description: { zh, en }`、`x-group`、`x-scopes`（允许出现的级别，取 `global`、`project`、`task`）。schema 顶层有整数 `version`。默认值只写在 schema 里，**不建 `config/defaults.json`**（决定 6）。“跟随工具自己的设置”“不限”用 `null` 表示；`reasoningEffort` 的取值暂定 `follow`、`low`、`medium`、`high`、`max`。按执行端设置的项放在 `executors.<名称>` 下，顶层同名项是所有执行端的默认值（§12.2 表后说明）。
   - **项目级覆盖的限制（决定 7）**：仓库里的 `.agent-collab.json` 可能来自不可信的仓库，所以下面这些项的 `x-scopes` 不含 `project`：`permissionPreset`、`unattendedApproval`、`allowedRoots`、`env`、`inheritEnv`、`executors.*.command`、`executors.*.env`、`dsh.*`、`autoSync`、`runRetentionDays`。其余项三级都允许。项目文件里出现不允许的项时，报错并指出键名，该项不生效，其余项照常生效。
   - `config.mjs` 提供：读取并合并三级配置（全局 `<AGENT_COLLAB_HOME>/config.json`、项目 `<仓库>/.agent-collab.json`、单个任务的对象；对象逐层合并、数组整体替换；文件不存在不算错，JSON 不合法或不符合 schema 时报错并带文件路径）；按执行端名取出合并后的执行端选项；校验后原子写入配置文件。读取时用默认值补齐缺失项，但不回写文件。
6. `skills/collab/references/report-schema.json` 和 `core/report.mjs`（PLAN.md §13）：
   - schema 字段：`status`（`done`/`partial`/`blocked`）、`summary`、`criteria[]`（`id`、`met` 布尔、`evidence`）、`commands[]`（`command`、`exit_code` 整数或 null、`result`）、`files_changed[]`（字符串）、`deviations[]`（字符串）、`blocked_checks[]`（`check`、`error`）、`open_questions[]`（字符串）、`human_inputs[]`（`message`、`handling`）。全部必填，数组可以为空，不允许额外字段。
   - `report.mjs`：从一段回复文字里提取唯一的 ```json 代码块并解析；没有代码块、有多个代码块、JSON 不合法、不符合 schema，分别返回不同的错误类型；再提供按 schema 校验的函数。
7. `core/platform.mjs`（只做本步用到的部分）：解析 `AGENT_COLLAB_HOME`（未设置时为用户目录下的 `.agent-collab`）；建只让本人读写的目录（0700）和文件（0600），Windows 上跳过权限设置；原子写文件（同目录临时文件再改名）；判断 PID 是否存活。
8. `tests/integration/acp-client-dsh.mjs`：用真 dsh 检验 ACP 客户端，一条命令运行，不进 `node --test`。在临时 `DSH_HOME` 里按 experiments/1a/12-acp-overlay 的做法写一个不可达的假服务商（不调用模型），用 `dsh --profile acp --patch <覆盖层>` 启动，依次 `initialize`、`session/new`、`session/close`，最后一行输出 `RESULT: 通过|不通过` 加一句说明。临时环境的建法可以参考 experiments/1a/_shared/harness.mjs，但要把需要的部分复制到 `tests/integration/` 下，不要从 experiments/ 导入。
9. `docs/dev-setup.md`：加一节“集成测试”，写明 `tests/integration/` 下脚本的用途、运行命令和前置条件（PATH 上有 dsh）。

## 验收标准

- AC1：jsonrpc.mjs 的单元测试覆盖任务第 1 条列出的每种情况，全部通过。
- AC2：acp-client.mjs 对 fake-acp-agent.mjs 的单元测试在 stdio 和 TCP 两种模式下都通过，覆盖：initialize、session/new、prompt 期间按顺序收到全部 update、cancel 后 `stopReason` 为 `cancelled`、权限请求按 `deny` 和 `allow` 两种策略应答、`fs/*` 请求回 `-32601`、stdio 模式 `close()` 后子进程不再存活。
- AC3：`node tests/integration/acp-client-dsh.mjs` 用 RUNBOOK“重跑第 1a 阶段的实验”里的 bwrap 命令运行，最后一行是 `RESULT: 通过`；结束后临时目录已删除，没有残留进程。
- AC4：schema-check.mjs 对每个支持的关键字各有通过和不通过的用例；不支持的关键字抛错；错误路径正确。
- AC5：一个测试把 §12.2 的配置项清单写死在测试里，断言 schema 恰好覆盖这些项，每项都有 `default`、`x-title`、`x-description`、`x-group`、`x-scopes`；schema 的默认值能通过 schema 自身的校验；决定 7 列出的项 `x-scopes` 不含 `project`。
- AC6：config.mjs 的测试覆盖：三级覆盖顺序、数组整体替换、项目文件里出现不允许的项时报错且不生效、不合法的 JSON 报错带文件路径、文件缺失不报错、写入前校验、写入是原子的、POSIX 上写出的文件权限为 0600、按执行端名合并选项。测试只用临时目录，不碰真实的 `~/.agent-collab`。
- AC7：report.mjs 的测试覆盖一份合法汇报和每一种错误类型。
- AC8：platform.mjs 的测试覆盖 `AGENT_COLLAB_HOME` 生效与默认值、目录和文件权限（Windows 上跳过权限断言）、原子写成功后不留临时文件、PID 存活判断。
- AC9：`npm test` 全部通过，`npm run build` 退出码 0；`tests/fixtures/` 和 `tests/integration/` 下的文件不会被 `node --test` 当成测试运行；仓库仍然没有任何依赖；每个新文件开头有一行职责说明；不出现写死的路径和端口（测试里的临时目录和随机端口除外）。

## 非目标

- 不做桥接、运行时的工作进程、适配器、doctor、skill（后续步骤）。
- 不定义桥接的 `_meta.agentCollab` 字段和 `_agentCollab/status` 通知的具体格式（另有接口契约），客户端只需能透传 `_meta`、接收任意扩展通知。
- 不建 LICENSE、NOTICE。

## 隔离和安全（违反任何一条都算不通过）

- 遵守 RUNBOOK“派发 dsh 任务”的全部规定。本步不需要真实模型，**不使用第 6 条的例外**：不读真实 `DSH_HOME` 下的任何文件，不建 `.env` 链接。
- 只停止自己 spawn 的进程（按 PID）；不执行 kill/pkill/killall/fuser 按名字或端口找进程；不访问 dsh 的默认端口。
- 遇到需要越权（审批）的操作：不要申请，记为发现。
- 不执行 git commit、git push；不修改 docs/PLAN.md、AGENTS.md 和 docs/context/ 下的任何文件。发现与 PLAN.md 不一致的地方，写进汇报。

## 汇报

在对话里汇报：第 0 步的原样输出；新建或修改的文件清单；逐条 AC 的结果和证据（命令及输出摘要）；ACP 字段核对结果（任务第 2 条）；`npm test` 的结果；集成脚本的最后几行输出；清理检查的方法和结果；没做完的项、遇到的问题和你的疑问。
