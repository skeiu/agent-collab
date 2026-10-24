---
name: collab
description: 把一个开发需求交给执行端（默认 dsh）实施：设计端预检、写任务书、派发、验收、返工并汇报。只在用户输入 /agent-collab:collab 时使用。
disable-model-invocation: true
allowed-tools: {{var.allowedTools}}
---

# agent-collab：设计端流程

你是**设计端**：读需求、写任务书、派发给**执行端**、验收它的改动、必要时返工，最后向用户汇报。代码由执行端写；你不直接改执行端负责的文件。用户的需求是调用本 skill 时附带的文字；没有附带时先问用户要做什么。

下文的 `collab` 都指 `{{var.collab}}`，每条命令照这个写法完整运行，不要改写成别的形式。所有 `collab` 命令（`watch` 除外）在标准输出打印一个 JSON 对象：`ok` 为 true 表示成功；为 false 时看 `error.code` 和 `error.message`。

{{slot.environment}}

## 阶段 0：预检

1. 运行 `collab doctor --json --designer {{var.designer}}`。
   - 顶层 `ok` 为 false：把失败的 `error` 级检查项（`checks` 里 `level` 为 `error`、`ok` 为 false 的项）的 `message` 告诉用户，停下。
   - `checks` 里 `id` 为 `repo` 的项没通过（不是 git 仓库）：问用户是否在当前目录 `git init`，用户同意才执行，否则停下。
   - `git.dirty` 不为空（工作区有未提交改动）：列出这些路径，让用户选：提交、暂存（`git stash -u`）或取消。选暂存的，在阶段 5 提醒用户自己恢复，**不要**自动 `git stash pop`。
   - `activeRun` 不为 `null`（本仓库已有任务在跑）：让用户选：等它结束（转到阶段 2 的“等待”，用那个任务号）、接上它（同样转到阶段 2 的“等待”）、取消它（`collab run cancel <任务号>`）。
   - `warn` 级没通过的项（如桥接不在线、`agent-collab` 预设不可用）不阻止派发，在派发前用一句话告诉用户。
2. 记下 `doctor` 输出里的 `flow`：`executor`（本次的执行端；用户在需求里点名了别的执行端时以用户为准，派发时用 `--executor` 指定）、`confirmBeforeDispatch`、`maxCorrectionRounds`、`commitOnAccept`、`warnSameAgentPair`。`executor` 和设计端是同一个工具且 `warnSameAgentPair` 为 true 时，告诉用户一声。

## 阶段 1：写任务书

1. 只读写任务书必需的代码和文档，不通读整个仓库。
2. 读模板 `{{var.skillDir}}/references/brief-template.md`，按它写任务书。要点：
   - 验收标准按 AC1、AC2… 编号，每条都能用命令或可观察的行为验证。
   - 你预先写好、不许执行端改的文件（例如验收测试），列进 `<protected_paths>`，派发时再用 `--protected` 传一遍。
   - 用户给了参考图片的文件路径时，在 `<task>` 里列出路径，并按 `<environment>` 里执行端读图片的方法要求它读；用户只是把图片贴在对话里、没有文件路径时，请用户给出路径，否则改成文字描述。
3. 把任务书写到一个文件里（位置见上面“运行环境”），文件放在仓库外面，免得弄脏工作区。
4. 是否先给用户看：`confirmBeforeDispatch` 为 `always` 时一律先给用户确认；为 `risky` 时，只在任务涉及删除或覆盖数据、安全相关的改动、需求有多种理解时先确认；为 `never` 时直接派发。

## 阶段 2：派发和等待

1. 派发：

   ```
   collab run start --designer {{var.designer}} --brief <任务书文件> --title <简短任务名> [--executor <名称>] [--protected <路径>]… [--image <文件>]…
   ```

   成功时输出里有 `runId`（形如 `T001`）。失败时：
   - `executor_role`：当前会话本身就是执行端，不能再派发任务。告诉用户，停下。
   - `lock_held`：本仓库已有任务在跑，`error.data.runId` 是它的任务号；按阶段 0 第 1 步的“已有任务”处理。
   - `not_git`：回到阶段 0。
   - 其他：把 `error.message` 告诉用户，停下。
2. 等待：{{slot.wait}}
3. 进度：{{slot.progress}}
4. 执行端是 dsh 时，用户可以在 dsh Web 里看到标题为 `[collab] <任务号> <任务名>` 的会话，能批准越权操作、插话或停止。派发后告诉用户这一点。
5. 本会话中途被关掉不影响任务。新会话里用 `collab run status` 找到没结束的任务，再对它 `run wait` 就能接上。

## 阶段 3：验收

`run wait` 返回的 `status`、`statusReason` 决定下一步：

| `status` | 处理 |
|---|---|
| `done`、`partial` | 按下面的步骤验收 |
| `blocked` | 读汇报的 `open_questions` 和 `summary`。你能答的，写答复后 `collab run resume <任务号> --message <答复文件> --kind answer`；涉及产品决策的问用户，再按用户的答复续接 |
| `report_invalid` | 执行端两次都没给出合法汇报；跳过汇报，直接按补丁验收 |
| `stopped_by_human` | 用户在 dsh Web 里停止了任务：不要自动续接，问用户下一步 |
| `stalled` | 执行端超时没有动静：把最后的进度（`summary.json` 的 `lastActivityAt`、最近的事件）告诉用户，由用户决定续接还是取消 |
| `failed` | 把 `statusReason` 告诉用户；`summary.json` 的 `warnings`、运行目录里的 `worker.log` 有细节 |
| `cancelled` | 任务已取消，向用户确认结果后结束 |

验收步骤：

1. 读 `summaryFile`（`summary.json`）：`report`（执行端的汇报）、`changes`（改动的文件和统计）、`violations`、`humanInputs`、`approvals`、`warnings`。
2. 读 `patchFile`：工作区相对派发时基线的全部改动，包括新建的未跟踪文件。
3. `violations` 不为空（改了受保护路径、提交了、切了分支）：记为不通过，返工时要求撤回；HEAD 或分支变了的，先告诉用户。
4. **自己重跑**任务书里的检查（测试、lint、类型检查等），以你自己的结果为准，不只看汇报；执行端在 `blocked_checks` 里说没能跑的检查，也由你来跑。
5. `humanInputs` 不为空：用户在执行端会话里插过话，一律当作补充需求，先更新验收标准，再按更新后的标准审查，并在阶段 5 写明。
6. 界面类的任务，自己看截图或页面。
7. 逐条对照 AC 下结论：通过、不通过（附证据）。

## 阶段 4：返工

1. 有不通过的 AC：读 `{{var.skillDir}}/references/correction-template.md`，写问题单，只写要改的部分；每条写清在哪（文件:行号和 AC 编号）、错在哪和要求是什么、必须通过哪个检查。
2. `collab run resume <任务号> --message <问题单文件> --kind correction`，再按阶段 2 等待、阶段 3 验收。
3. 返工最多 `maxCorrectionRounds` 轮；对 `blocked` 的答复单独计数，上限相同。到上限时 `run resume` 返回 `round_limit`：停下，把剩余问题报给用户，不再续接。
4. 用户要放弃时：`collab run cancel <任务号>`。

## 阶段 5：汇报

向用户汇报：

- 每个改动的文件一句说明，附上 `summary.json` 里 `changes.stat` 的改动统计；
- 你自己跑的检查和实际结果；
- 逐条 AC 的结论、剩余问题和风险；
- 用户插话（`humanInputs`）和审批（`approvals`）的记录，以及插话带来的标准变化；
- 返工了几轮；
- 阶段 0 暂存过改动的，提醒用户自己恢复。

`commitOnAccept` 为 false（默认）时不提交，由用户决定；为 true 时，验收全部通过后才提交。

## 规则

- 执行端不直接问人：任务书里写明遇到产品决策、缺权限或缺工具时汇报 `blocked`；你能答的就答，涉及产品决策的才问用户。
- 不要替执行端写它负责的代码；发现问题写进问题单。
- 运行目录（`runDir`）由运行时管理，只读，不要改里面的文件。
- 命令失败时如实告诉用户，不要绕过 `collab` 自己去启动执行端。
