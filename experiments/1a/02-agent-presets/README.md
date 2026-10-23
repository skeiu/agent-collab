# 02 — agentPresets 的预设 id 与 mount 签名

**对应 §17 第 2 项**（PLAN.md §5.4、§9.5）。

## 目的

在被测 dsh Web 里实际取得 `agentPresets` 服务，列出全部预设 id，并确认 `mount` 的签名；再与 dsh 安装目录中的 `dsh-agent-preset-registry` 源码对照。

## 运行方法

```sh
node experiments/1a/02-agent-presets/run.mjs
```

前置条件：Linux、Node.js ≥ 20、PATH 上有 `dsh`；没有全局 pnpm 时需要 corepack（脚本会在临时目录生成 pnpm shim，首次可能需要联网获取 pnpm）。脚本只使用临时 `DSH_HOME`，启动 `dsh web --port 0 --no-open`，结束删除临时目录。

## 结论：成立

2026-10-23 实测：预设 id 为 `standard`、`ptc`、`minimal`、`cordis`。`mount` 是两参数异步方法 `mount(ctx, id)`，返回 `{ id: generation.mount.presetId }`；源码 `dsh-agent-preset-registry/lib/index.js` 与实测一致。`ptc` 也是内置预设，PLAN §5.4 列举的四个 id 之外还有它，回填时补上即可。

依据：`run.mjs` 输出的预设列表、`mount.length === 2`，以及源码中的 `async mount(ctx, id)`。
