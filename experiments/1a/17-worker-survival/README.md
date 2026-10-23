# 17 — Claude 会话结束后，独立工作进程能否存活

对应 PLAN.md §17 第 17 项（D20）。

## 目的

确认从 Claude Code 会话的 Bash 启动的工作进程，在会话结束后能否继续运行；对照 Bash 工具的 `run_in_background`。

## 运行方法

    PROBE_MODEL=<可用的模型名> node experiments/1a/17-worker-survival/run.mjs [detached|bg-tool]...

- `detached`：会话用 `launch-detached.mjs` 启动 `worker.mjs`（`detached: true`、`stdio: 'ignore'`、`unref()`），立即回复；脚本在 `claude -p` 退出后 10 秒内看心跳是否增加。
- `bg-tool`：会话用 Bash 工具的 `run_in_background` 启动 `worker.mjs`；看 `claude -p` 何时退出。

工作进程每秒写一次心跳，60 秒后自行退出；脚本等它退出后再删临时目录。

## 前置条件

PATH 上有 `claude` 和 `node`；调用时加 `--permission-mode default --allowedTools 'Bash(node:*)'`，命令要以 `node` 开头才能匹配。每种方式调用一次模型。

## 结论（2026-10-23，Linux，CLI `-p` 模式）

- `detached`：成立。`claude -p` 7 秒后退出，退出后 10 秒内心跳从 3 次增加到 13 次，进程一直存活。
- `bg-tool`：`claude -p` 等后台任务跑完（约 68 秒）才退出；这种后台任务和会话绑在一起，不能当作独立工作进程。
- Desktop（2026-10-23，用户操作）：在 Code 标签页新开会话，让它运行 `node experiments/1a/17-worker-survival/launch-detached.mjs .desktop-probe desktop 180` 后立即删除会话；工作进程继续写心跳直到 180 秒结束，父进程变为 `systemd --user`。成立。
- 未验证：Windows 上怎么脱离父进程（本机测不了）。
