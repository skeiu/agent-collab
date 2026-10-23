# 01 — 基于 standard 派生去掉 tool-ask-user 的工具预设

**对应 §17 第 1 项**（PLAN.md §9.5、§15“1a”第 1 行）。

## 目的

验证能否在插件的 bundle 补丁里基于 `standard` 派生一个去掉 `tool-ask-user` 的工具预设，而不是整份复制 `standard` 的插件列表。同时实际装入一个复制版预设，确认它存在、不含 `tool-ask-user`、其余与 `standard` 一致。

## 运行方法

```sh
node experiments/1a/01-preset-derive/run.mjs
```

前置条件同实验 02。插件源码在 `plugin/`；`plugin/cordis.patch.yml` 里的 `preset-agent-collab` 是从当前 dsh 的 `dsh-web-app/presets/standard.patch.yml` 复制、去掉 `tool-ask-user` 一行后的列表，并另外放了两条故意失败的“派生”写法（向 `preset-standard` 插入子行、按嵌套 id 覆盖子行）。

## 结论：不成立（派生不可行，复制可行）

2026-10-23 实测：`agent-collab` 预设能注册且不 broken；其定义与 `standard` 在去掉 `tool-ask-user` 后逐字一致。派生侧没有可用语法：

- `dsh-agent-preset` 的 Config 只有 `id/name/description/order/plugins`（`plugins` 为必填数组），没有 `extends` 或继承字段；
- loader 补丁的嵌套 id 匹配只递归原始 `group: true` 的行；`preset-standard` 在配置里不是 group（它是 `dsh-agent-preset` 自己管理的 EntryGroup），所以向它 `insert` 子行会被跳过，`preset-standard:tool-ask-user` 也匹配不到；
- 实测中 `standard` 的 `tool-ask-user` 未被改动。

因此只能整份复制列表（本实验的复制版可工作），dsh 升级后需要同步维护；或者按 §15 的后备方案只靠任务书约束并转发提问。影响章节：§9.5、§15“1a”第 1 行、§17 第 1 项。
