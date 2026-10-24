# RUNBOOK

本文件：有依据的操作、前置条件和验证步骤。执行对应操作或验收前读；方法变化时更新。未执行过的命令标【未验证】，实际执行并核实后标【已验证】并注明日期。文档中的步骤不构成执行授权。

## 状态说明

产品功能尚未实现（第 1a 阶段技术验证已完成）。目前有依据的是：文档维护、提交前检查本机信息、派发 dsh 任务的隔离步骤、测试和构建命令（[dev-setup.md](../dev-setup.md)）、重跑第 1a 阶段的实验。规划中的安装和产品验收流程见 [PLAN.md](../PLAN.md) §14、§15。

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

## 派发 dsh 任务（R6 隔离要求）

依据 [RISKS.md](RISKS.md) R6：写代码的 dsh 会话跑在用户日常的 dsh Web 里，被测的 dsh 必须与它隔离。第 1a 阶段起所有交给 dsh 的任务都按下面执行；任务书原文存在 [briefs/](briefs/)，派发时让 dsh 读文件执行。

1. **派任务前**：在 dsh Web 里把这个会话的权限切到 `workspace-write`，确认显示的是 `workspace-write` 后再贴任务书。由谁操作见下面“Claude 在内置浏览器里派发”。
2. **第一步自检**：任务书第一步运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报。看到用户日常的 dsh Web 进程，说明沙箱没有隔离进程，**停下来汇报**，由用户决定是否继续。
3. **被测 dsh 一律用临时环境**：`DSH_HOME` 设为 `os.tmpdir()` 下新建的目录，`dsh web` 加 `--port 0 --no-open`，从输出里解析实际端口。脚本运行任何 `dsh` 命令前都要断言 `DSH_HOME` 位于临时目录下，否则退出。
4. **缓存重定向到临时目录**：`COREPACK_HOME`、`npm_config_cache`、`PNPM_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`、`XDG_RUNTIME_DIR`（pnpm 12 把 store 操作锁建在这里，2026-10-23 验收时发现）。
5. **只停自己启动的进程**：按自己 spawn 得到的 PID 停止，禁止 `kill`/`pkill`/`killall`/`fuser` 按名字或端口找进程。
6. **不碰用户的 dsh**：不读写 `~/.dsh`（包括其中的凭据、`.env`、会话），不访问 dsh 的默认端口，不对默认 `DSH_HOME` 运行任何 `dsh` 命令。
   - **需要真实模型时的例外**（用户 2026-10-23 为第 1a 阶段第 2 批同意，以后沿用须在任务书里写明）：可以**只读**真实 web profile 的 `cordis.patch.yml`，从中挑出 `llm-*` 和 `agent-default-model` 条目，复制进临时 `DSH_HOME`；可以在临时 `DSH_HOME` 里建符号链接 `.env`，指向真实的 `$DSH_HOME/.env`，由被测 dsh 自己读取。实验代码和执行端都不得打开、打印或复制 `.env` 的内容，也不得写真实 `DSH_HOME` 里的任何文件。
7. **审批**：dsh 发出的越权审批一律拒绝；需要越权才能做的实验，记为发现并汇报。

**Claude 在内置浏览器里派发**（用户 2026-10-24 同意，边界如下）：

- 登录：dsh Web 要带令牌的地址才能进；由用户在 Claude 桌面版的内置浏览器里打开一次，登录状态会保留。Claude 不填令牌，也不从 dsh 的文件里找令牌。dsh Web 重启换了令牌时，请用户重新打开。
- 派发什么：只派用户定稿的任务书；用户说“定稿”即同意 Claude 派发，每次派发在对话里说明。
- 怎么派：每个任务开新会话，先切 `workspace-write`，在页面上确认生效后再发“读 docs/context/briefs/<文件> 并按它执行。”；验收时照旧从会话日志的 `permission/preset` 核实。
- 审批：任务书范围外的一律拒绝；看不准是否越权的，停下问用户；Claude 不点批准。
- 不碰：其他会话、dsh 的设置、profile 和模型、dsh Web 进程本身。
- 等待：在后台等会话日志不再更新，不反复截图；跑完从页面读汇报，再按下面的核对和验收方法自己重跑。验收结论和提交授权仍归用户。

**派发后的核对（Claude 验收时做）**：派任务前记下用户 dsh Web 的 PID、`~/.dsh/profiles/*` 下 `package.json` 和 `cordis.patch.yml` 的哈希、插件目录（用到例外时再加 `.env` 的哈希和修改时间，只存在 Claude 的临时目录）；完成后对比，并按下面“核对 dsh 会话做了什么”查权限事件、执行过的命令和汇报。【已验证】2026-10-23：第 1a 阶段三次派发均按此执行。

## 构建、测试、运行

命令见 [docs/dev-setup.md](../dev-setup.md)，这里只记验收方法。

### 第 0 阶段验收（在临时目录重跑）

```bash
T=$(mktemp -d) && tar --exclude=.git -cf - . | tar -xf - -C "$T" && cd "$T" && git init -q -b main && npm test && npm run build && git status --porcelain
```

判断：测试全部通过，build 退出 0，`git status` 里只有复制过去的未跟踪文件（build 不产出文件）。【已验证】2026-10-23：Linux、Node 22，tmpfs 临时目录，3/3 通过。Node 20 和 Windows、macOS 靠 CI 验证。

### 重跑第 1a 阶段的实验

每个实验一条命令；为与 dsh 沙箱条件一致并多一层保护，用 bwrap 包一层（独立 PID 空间和 `/tmp`，其余只读）：

```bash
bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp -- node experiments/1a/02-agent-presets/run.mjs
```

判断：最后一行 `RESULT:` 与 `experiments/1a/REPORT.md` 一致。【已验证】2026-10-23：第 1 批 7 项全部重跑一致（harness 修好 `XDG_RUNTIME_DIR` 后）。

各实验的特殊条件：

- 18：首次要联网下载 pnpm。
- 08、17（Claude 侧）：不用 bwrap，直接在终端运行；需要 PATH 上有 `claude`，会调用模型，用 `PROBE_MODEL=<模型名>` 指定便宜的模型（继承的默认模型名可能不可用）。08 全部用例约 0.02 美元。17 每种方式约 1 分钟。Desktop 关会话的存活测试要用户在 Desktop 里操作，步骤见 `experiments/1a/17-worker-survival/README.md`。【已验证】2026-10-23。
- 04（第 2 批）：会真实调用用户网关上的模型，需要 `AC_REAL_DSH_HOME=<用户的 dsh 目录>`，可选 `AC_TEST_MODEL`；按上面的 bwrap 命令运行（家目录只读）。跑前跑后都要按“派发 dsh 任务”的核对方法对比 `~/.dsh` 和 `.env`。【已验证】2026-10-23：约 18 秒，结论与报告一致。

### 核对 dsh 会话做了什么

dsh 会话日志在 `$DSH_HOME/sessions/<工作目录编码>/session-<id>/session.v4.jsonl.zstd`，用 `zstd -dc` 解压到临时目录后按事件类型查看：`permission/preset`、`sandbox/mode`、`approval/policy` 是权限变化；`tool/ptc-dispatch-start` 带执行过的命令；最后一条 `assistant/message` 是汇报。【已验证】2026-10-23，dsh 0.2.1-rc.2。

## 产品验收

按 PLAN.md §15 的 T1–T26 进行，全部在临时目录新建的 git 仓库里做；集成测试使用临时的 `DSH_HOME`、`AGENT_COLLAB_HOME` 和 PATH（PLAN.md 附录 B）。具体步骤待实现后补充。【未验证】
