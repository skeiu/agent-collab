本文件：开发前置条件，以及运行测试和构建的命令。开发或调试本项目时读；前置条件、命令或 1a 阶段的手动安装步骤变化时更新。

# 开发准备

## 前置条件

- Node.js ≥ 20（用 `node --version` 确认）。项目只用 Node 内置模块，不需要 `npm install`，仓库里没有任何依赖。
- git：用于版本控制和查看改动。

## 运行测试

```bash
npm test
# 等价于
node --test
```

测试会自己创建临时目录，只使用系统临时目录（`os.tmpdir()`），不依赖开发机的特有配置。

## 集成测试

`tests/integration/` 下的脚本需要真实工具，不进入 `node --test`；用下面的命令单独运行（前置条件：Linux、Node.js ≥ 20、PATH 上有 `dsh`）：

| 脚本 | 用途 | 运行命令 |
|---|---|---|
| `acp-client-dsh.mjs` | 在临时 `DSH_HOME` 里用一个不可达的假服务商启动 `dsh --profile acp`，依次执行 `initialize`、`session/new`、`session/close` | `node tests/integration/acp-client-dsh.mjs` |
| `bridge-dsh.mjs` | 在临时 `DSH_HOME` 里安装桥接和测试插件，用假 LLM 服务跑通发现文件、会话、工具、审批、取消、Web 内停止和重连补发；需要 PATH 上有 `dsh`，`pnpm` 或 `corepack`（corepack 首次取得 pnpm 会联网下载），不需要真实模型 | `node tests/integration/bridge-dsh.mjs` |

脚本只使用系统临时目录，不调用模型；最后一行输出 `RESULT: 通过` 或 `RESULT: 不通过 — 原因`，退出码非 0 表示失败。运行结束后临时目录会删除，自己启动的进程会按 PID 结束。`tests/fixtures/` 下是测试用的假对端，也不会被 `node --test` 当成测试运行。

## 构建

```bash
npm run build
# 等价于
node scripts/build.mjs
```

构建脚本定位仓库根目录后逐项执行：目前只实现“打包桥接 .tgz”，把 `dsh-bridge/` 打成 `dist/dsh-bridge-<版本>.tgz`（可用 `--out <目录>` 改输出位置）；生成 SKILL.md 和组装运行时仍报告尚未实现。

【已验证】2026-10-23：`npm test` 与 `npm run build` 在 Linux、Node.js 22 上通过，退出码 0。Node 20 及 Windows、macOS 由 CI 验证，【未验证】（尚未推送）。

## 1a 阶段的手动安装步骤

暂无，第 1a 阶段补充。
