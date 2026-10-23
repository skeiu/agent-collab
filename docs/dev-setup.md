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

## 构建

```bash
npm run build
# 等价于
node scripts/build.mjs
```

第 0 阶段的构建脚本是骨架：定位仓库根目录后，逐项打印尚未实现的步骤（生成 SKILL.md、打包桥接 .tgz、组装运行时），不产出文件，退出码 0。

【已验证】2026-10-23：`npm test` 与 `npm run build` 在 Linux、Node.js 22 上通过，退出码 0。Node 20 及 Windows、macOS 由 CI 验证，【未验证】（尚未推送）。

## 1a 阶段的手动安装步骤

暂无，第 1a 阶段补充。
