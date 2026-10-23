# 18 — dsh plugin add <tgz> 的 pnpm 来源与离线安装

**对应 §17 第 18 项**（PLAN.md §9.4）。

## 目的

确认 `dsh plugin --profile <profile> add <tgz>` 需要什么：pnpm 从哪里来（本机没有全局 pnpm，只有 corepack），以及安装一个没有依赖的 .tgz 是否需要联网。

## 运行方法

```sh
node experiments/1a/18-pnpm-offline/run.mjs
```

前置条件：Linux、Node.js ≥ 20、PATH 上有 `dsh` 和 `corepack`；全局 pnpm 可有可无——脚本用空 PATH 模拟没有 pnpm 的情况。

## 结论：部分成立

2026-10-23 实测：

- `dsh plugin add` 直接执行 PATH 上的 `pnpm`，dsh 不会自己调用 corepack；没有 pnpm 时退出码 127，提示 `pnpm was not found`。
- 用 `corepack enable --install-directory <临时 bin> pnpm` 生成 shim 后可用；首次使用 corepack 会下载 pnpm（日志：`Corepack is about to download .../pnpm-...tgz`），即 **bootstrap pnpm 这一步需要联网**，除非已有 corepack 缓存或另行安装 pnpm。
- pnpm 就绪后，把 registry 指向不可达地址（`http://127.0.0.1:9`）并给 `pnpm add` 加 `--offline`，安装无依赖 .tgz 成功，且 profile 的 `dsh.profile.bundles` 自动选中。

模拟的局限：`--offline` 只证明本次 `pnpm add` 不需要 registry/网络；corepack 首次下载 pnpm 仍需网络，真实离线机器必须在镜像里预置 pnpm。影响章节：§9.4、§14 安装说明、§15“1a”第 18 行。
