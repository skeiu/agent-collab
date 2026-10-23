# 07 — 装/更新插件后 dsh Web 是否热重载

**对应 §17 第 7 项**（PLAN.md §5.6、§14.5）。

## 目的

在 dsh Web 运行期间安装一个新 bundle 插件，再安装同包的新版本（版本号加一、行为改变），判断是否不重启就生效，还是必须重启。

## 运行方法

```sh
node experiments/1a/07-hot-reload/run.mjs
```

前置条件同实验 02。`plugin/index.js` 只是占位说明；`run.mjs` 会按版本生成实际插件入口，v1 与 v2 的差异在入口里体现。

## 结论：部分成立

2026-10-23 实测：

- 运行中的 Web 安装新 bundle：插件被热加载（日志出现 v1 的 `apply`，Web PID 未变）。
- 同包更新到 v2（`dsh.profile.bundles` 不变，只有包文件和依赖版本变化）：30 秒内没有出现 v2 的 `apply`；重启 Web 后出现，且 v2 的行为文件存在。

因此新装 bundle 可热加载，CLI 的 `dsh plugin add` 同包更新需要重启（或走 Plugin Manager 的显式 replace/remove+add 流程）。对 1b 自动同步的影响：§5.6、§14.5、§15“1a”第 7 行，更新路径要在文档和 `installed.json` 里记录“更新后重启 dsh Web”，不能假设 CLI 更新会自动生效。
