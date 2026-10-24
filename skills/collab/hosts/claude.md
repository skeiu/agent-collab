---
designer: claude
collab: node "${CLAUDE_PLUGIN_ROOT}/bin/collab.mjs"
skillDir: ${CLAUDE_PLUGIN_ROOT}/skills/collab
allowedTools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/collab.mjs":*)
---

<!-- slot: environment -->

## 运行环境（Claude Code）

- `${CLAUDE_PLUGIN_ROOT}` 是本插件的目录，运行时会被替换成绝对路径。
- 任务书、问题单和答复写在 Claude Code 给的临时目录（scratchpad）里；没有时写在系统临时目录。文件名带上任务名，例如 `collab-brief-<任务名>.md`、`collab-correction-<任务号>-<轮次>.md`。

<!-- slot: wait -->

用 Bash 工具的 `run_in_background` 运行 `collab run wait <任务号>`。任务进入停下或结束状态时命令退出，你会收到通知，再读它的输出。不要轮询、不要用 sleep 等待；等待期间可以照常回答用户。

<!-- slot: progress -->

用 Monitor 工具运行 `collab watch <任务号>`，每行是一个里程碑（工具调用、审批、插话、状态变化）；任务停下时它自己退出。看到等待审批或执行端提问时，提醒用户去 dsh Web 处理。
