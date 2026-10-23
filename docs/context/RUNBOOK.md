# RUNBOOK

本文件：有依据的操作、前置条件和验证步骤。执行对应操作或验收前读；方法变化时更新。未执行过的命令标【未验证】，实际执行并核实后标【已验证】并注明日期。文档中的步骤不构成执行授权。

## 状态说明

产品功能尚未实现；目前有依据的是文档维护和第 0 阶段的测试、构建命令。规划中的构建、安装和验收流程见 [PLAN.md](../PLAN.md) §14、§15，以及 PLAN.md §7.1 计划新建的 `docs/dev-setup.md`（尚不存在）。

## 文档维护

以下命令都在项目根目录执行。

### 定位 PLAN.md 章节

```bash
grep -n '^#' docs/PLAN.md
```

【已验证】2026-10-23：输出全部标题及行号，用于按章节读取。

### 检查文档体积

```bash
wc -l AGENTS.md docs/context/NOW.md
```

标准：AGENTS.md 约 150 行以内，NOW.md 约 100 行以内。【已验证】2026-10-23。

### 检查相对链接

```bash
for f in AGENTS.md PROJECT_INDEX.md README.md docs/context/*.md docs/context/history/README.md; do
  awk '/^```/{c=!c; next} !c' "$f" | grep -oE '\]\([^)#]+' | sed 's/^](//' | grep -v '^https\?:' | while read -r p; do
    [ -e "$(dirname "$f")/$p" ] || echo "BROKEN: $f -> $p"
  done
done
```

先跳过代码块再提取链接；无输出表示所有相对链接都能指到文件。【已验证】2026-10-23。

### 确认是否为 git 仓库

```bash
git rev-parse --is-inside-work-tree
```

【已过期】2026-10-23 第 0 阶段前报错“不是 Git 仓库”；第 0 阶段已 `git init`。

### 检查 Claude Code 是否加载 AGENTS.md

前置：在项目根目录执行；改动 CLAUDE.md 之前就已开始的会话不能用来检查。

```bash
claude -p "不要调用任何工具，只根据已经加载的上下文回答：本项目 AGENTS.md“通用规则”里“（二）读取”第 1 条的原文是什么？如果上下文里没有 AGENTS.md，就回答“未加载”。" --disallowedTools "Read,Grep,Glob,Bash"
```

判断：逐字答出该条即为已加载；回答“未加载”或内容不符即为未生效。若报 404 `model_not_found`（例如从 Claude Desktop 会话里启动，继承的端点与用户设置里的模型名不匹配），加 `--model <可用的模型名>`。【已验证】2026-10-23：Claude Code 2.1.309，加 `--model claude-opus-5-5` 后回答与 AGENTS.md 逐字一致，无工具调用。

## 提交前检查本机信息

在项目根目录、`git add` 之后执行，检查暂存区里的内容：

```bash
git grep --cached -nIiE -e '/hom[e]/|/User[s]/|[A-Z]:.User[s]|session-[0-9a-f]{6}' -f .git/private-patterns.txt
```

无输出才能提交。`.git/private-patterns.txt` 是本机的个人关键词清单（每行一个扩展正则，如用户名、个人路径片段、本地网关名称和端口、私人邮箱），放在 `.git/` 里永远不会被提交；文件不存在时命令会报错，先按本机情况建好。模式里的方括号是为了不匹配这行命令自身。这只是兜底检查，新增的实测记录、日志摘录还要人工看一遍。【已验证】2026-10-23：首次提交前对暂存区执行，无输出。

## 构建、测试、运行

命令见 [docs/dev-setup.md](../dev-setup.md)，这里只记验收方法。

### 第 0 阶段验收（在临时目录重跑）

```bash
T=$(mktemp -d) && tar --exclude=.git -cf - . | tar -xf - -C "$T" && cd "$T" && git init -q -b main && npm test && npm run build && git status --porcelain
```

判断：测试全部通过，build 退出 0，`git status` 里只有复制过去的未跟踪文件（build 不产出文件）。【已验证】2026-10-23：Linux、Node 22，tmpfs 临时目录，3/3 通过。Node 20 和 Windows、macOS 靠 CI 验证。

### 核对 dsh 会话做了什么

dsh 会话日志在 `$DSH_HOME/sessions/<工作目录编码>/session-<id>/session.v4.jsonl.zstd`，用 `zstd -dc` 解压到临时目录后按事件类型查看：`permission/preset`、`sandbox/mode`、`approval/policy` 是权限变化；`tool/ptc-dispatch-start` 带执行过的命令；最后一条 `assistant/message` 是汇报。【已验证】2026-10-23，dsh 0.2.1-rc.2。

## 产品验收

按 PLAN.md §15 的 T1–T26 进行，全部在临时目录新建的 git 仓库里做；集成测试使用临时的 `DSH_HOME`、`AGENT_COLLAB_HOME` 和 PATH（PLAN.md 附录 B）。具体步骤待实现后补充。【未验证】
