# 12 — 从 web profile 用户层生成 acp 覆盖层

**对应 §17 第 12 项**（PLAN.md §11.5）。

## 目的

在临时 `DSH_HOME` 里手工写一个假的 web profile 用户层：一个 `llm-pi-ai` 服务商条目（base URL 指向不可达地址、不写 key）和 `agent-default-model`；按 PLAN §11.5 挑出这些条目，加上 `acp` 条目的 provider/model，生成覆盖层，用 `dsh --profile acp --patch <覆盖层>` 验证加载和 `session/new` 返回的当前模型。

## 运行方法

```sh
node experiments/1a/12-acp-overlay/run.mjs
```

前置条件：Linux、Node.js ≥ 20、PATH 上有 `dsh`；不需要模型调用和 API key。

## 结论：成立

2026-10-23 实测：覆盖层正常加载，ACP `initialize` 返回 `deepseek-harness-acp` / protocol 1；`session/new` 成功，`configOptions` 的 `model` 当前值为 `["example-provider","example-model"]`，正是覆盖层指定的 provider/model。挑选规则在本实验里是“顶层块 id 以 `llm-` 开头或为 `agent-default-model`”，另加 `acp` 行；这是一个简化的顶层块选择器，真实实现仍应使用可靠的 YAML 解析并处理 profile 用户层的全部条目形态。
