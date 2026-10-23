# 03 — workspaceRegistry.create 的复用行为与 attachSession

**对应 §17 第 3 项**（PLAN.md §5.4）。

## 目的

对已存在的路径重复调用 `workspaceRegistry.create`，判断是复用还是报错；并验证返回的 workspace 实体上的 `attachSession(sessionId)` 是否可用。`workspaceRegistry` 只在运行时用 `ctx.get` 按需取得，不写进插件 `inject`。

## 运行方法

```sh
node experiments/1a/03-workspace-registry/run.mjs
```

前置条件同实验 02。

## 结论：成立

2026-10-23 实测：同一目录连续两次 `create` 返回相同 id，第二次的 `title` 参数被忽略（保留第一次的标题），workspace 列表仍为 1 条。`attachSession(sessionId)` 是 workspace 实体的方法；会话的 header cwd 与 workspace 路径一致时挂入成功，`sessionIds` 包含该会话。依据：`run.mjs` 输出的两个 id、title、listCount，以及 `sessionIds`。
