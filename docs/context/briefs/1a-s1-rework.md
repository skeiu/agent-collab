本文件：第 1a 阶段 S1（基础模块）验收后交给 dsh 的返工任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-23。第 1 条的做法“项目级只能收紧”【已确认】用户 2026-10-23，已回填 PLAN.md §12.2。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S1 原任务书 docs/context/briefs/1a-s1-foundation.md（隔离和安全规则照旧有效）。docs/PLAN.md 只读 §12.1、§12.2。

## 第 0 步：沙箱自检（必须先做）

同 S1 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

S1 的 AC1–AC9 经 Claude 重跑全部通过（含外层 bwrap 下的集成脚本）。审读代码后有下面几处要改，都在 S1 已有文件里。

## 任务

1. **项目级配置不能放宽安全相关的项**（PLAN.md §12.2“项目级只能收紧的项”）。现在项目文件 `.agent-collab.json` 能把下面几项往不安全的方向改：
   - `protectedPaths`：数组整体替换，项目文件写 `[]` 就清空了用户在全局设的保护路径；
   - `confirmBeforeDispatch`：项目文件写 `never`，派发前就不再确认；
   - `freshReviewForRisky`：项目文件写 `false`，关掉用户开的高风险复审；
   - `commitOnAccept`：项目文件写 `true`，验收通过后自动提交。

   做法（用户 2026-10-23 确认）：项目级对这 4 项只能收紧：
   - `protectedPaths`：项目级的值与前面各级的值取并集（去重，保持先全局后项目的顺序），不替换；
   - `confirmBeforeDispatch`：按 `never` < `risky` < `always` 取较严的一个；
   - `freshReviewForRisky`：项目级只有 `true` 生效；
   - `commitOnAccept`：项目级只有 `false` 生效。

   在 schema 里用一个 `x-` 键标注收紧规则（键名和取值形状你定，写进 schema 文件开头的 `description`），`config.mjs` 按标注处理，不按键名写死。项目文件往放宽方向改时，和越权项一样：返回一条错误（新的错误类型，或 `ConfigScopeError` 加一个原因字段，你定），该项按前面各级的值，其余项照常生效。单个任务级不受此限制。
2. **stdio 连接的环境变量**：`AcpClient.connectStdio` 现在总是把 `options.env` 叠在 `process.env` 上，调用方没法给子进程一份干净的环境（PLAN.md §12.2 的 `inheritEnv`、`env` 要靠它实现）。改为：传了 `env` 就原样作为子进程的完整环境；没传才用 `process.env`。相应地改测试里的调用。
3. **默认值只写在 schema 里**（实现决定 6）：`getExecutorOptions` 里 `reasoningEffort` 的 `?? 'high'` 去掉，依赖 `applyDefaults` 补齐的值；其他地方如有写死的默认值，一并去掉。
4. **TCP 模式的测试补全**：桥接走 TCP，所以 `tests/acp-client.test.mjs` 在 TCP 模式下也要覆盖 `session/cancel` 后 `stopReason` 为 `cancelled`、权限请求按 `deny` 和 `allow` 两种策略应答、`fs/*` 请求回 `-32601`（S1 原 AC2 要求两种模式都覆盖）。
5. **单行长度上限**：`JsonRpcPeer` 的读缓冲现在没有上限，对端一直不发换行就会一直涨。加一个构造参数 `maxLineBytes`（默认 16 MiB）：未完成的一行超过上限时，以一个带明确 `code` 的错误关闭连接，拒绝所有未完成的请求。加对应测试。
6. **去掉别名**：同一功能只留一个导出名，后续步骤只用这一个。删除：`sendRequest`、`sendNotification`、`handleRequest`、`handleNotification`、`createPeer`、`sessionNew` 等 6 个 `session*` 别名、`createAcpClient`、`readConfig`、`writeConfig`、`parseReport`、`getAgentCollabHome`。保留的名字以模块里带注释的主函数为准；测试里用到别名的地方改成主名。

## 验收标准

- RW1：第 1 条的测试覆盖：4 项各有一个“项目级放宽被忽略并报错”和一个“项目级收紧生效”的用例；`protectedPaths` 并集的顺序和去重；单个任务级可以放宽；收紧规则来自 schema 标注（测试读 schema 断言 4 项都有标注）。
- RW2：第 2 条有测试：传 `env` 时子进程看不到父进程里另设的变量。
- RW3：`grep -n "'high'" core/` 没有结果；第 3 条的执行端选项测试仍通过。
- RW4：第 4 条的 3 种情况在 TCP 模式下各有用例并通过。
- RW5：第 5 条有测试：超长行触发关闭，未完成请求以该错误结束；正常长度的消息不受影响。
- RW6：第 6 条列出的名字在 `core/` 和 `tests/` 里都不再出现（汇报里给出 grep 命令和结果）。
- RW7：`npm test` 全部通过，`npm run build` 退出码 0；`node tests/integration/acp-client-dsh.mjs` 最后一行仍是 `RESULT: 通过`；S1 原 AC9 的其余要求（无依赖、职责说明、无写死路径和端口）仍满足。

## 非目标

- 不改 `config.schema.json` 的其他项，不改汇报 schema。
- 不做 S2 及以后的内容。

## 隔离和安全

同 S1 原任务书“隔离和安全”一节，全部照旧；违反任何一条都算不通过。

## 汇报

在对话里汇报：第 0 步的原样输出；修改的文件清单；逐条 RW 的结果和证据（命令及输出摘要）；第 1 条你选的 `x-` 键名和形状；`npm test` 结果和集成脚本最后一行；没做完的项、遇到的问题和你的疑问。
