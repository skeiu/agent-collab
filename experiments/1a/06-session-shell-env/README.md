# 06 — 给单个会话的 shell 注入环境变量

**对应 §17 第 6 项**（PLAN.md §11.4）。

## 目的

验证能否只给某一个 dsh 会话的 shell 注入环境变量（例如 `AGENT_COLLAB_ROLE=executor`），不影响同一 dsh Web 里的其他会话。先读源码找注入点，再用真实 bash 工具调用验证，不跑模型。

## 运行方法

```sh
node experiments/1a/06-session-shell-env/run.mjs
```

前置条件同实验 02。

## 结论：部分成立

2026-10-23 实测：注入点是 `dsh-shell-env` 的 `ctx.shellEnv.register`。在 Agent 的 `setup` 里注册 contributor（resolver 按 `execution.agent` 匹配当前 Agent），同一个 dsh Web 中会话 A 的 bash 输出为 `executor`，会话 B 无输出；注册随 Agent scope 释放。`dsh-shell-env` 只允许 `DSH_*` 键，普通键 `AGENT_COLLAB_ROLE` 会被拒绝，因此 PLAN 的变量名要改成 `DSH_AGENT_COLLAB_ROLE`（或接受只能约束任务书）。

对 PLAN.md 的影响：§11.4“通过 `_meta.agentCollab.env` 注入”改为通过 Agent setup 的 `shellEnv` contributor，键名加 `DSH_` 前缀；§15“1a”第 6 行、§17 第 6 项相应回填。
