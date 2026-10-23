本文件：PLAN.md §17 第 15 项（dsh 桌面版能否装桥接）Windows 探针交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-23，待派发。分工：dsh 在 Linux 开发机上写探针并在 Linux 上空跑；Windows 上由那台机器上的 Claude Code 会话按 README 执行（用户 2026-10-23 指定），只有看侧栏、在桌面版界面里操作这类 Claude 做不了的步骤由用户做；这边的 Claude 对照结果文件验收。用户 2026-10-23 同意测试插件可以装进 Windows 上真实的 `desktop` profile（那台机器的 dsh 没有任何数据），要求装之前备份、做完卸载并核对已恢复原样。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md，再读 docs/context/RUNBOOK.md 的“派发 dsh 任务”。docs/PLAN.md 只读这些章节：§5.4、§5.6、§9.1、§14.7、§17 第 15 项（先用 `grep -n '^#' docs/PLAN.md` 定位，不要全文读）。参考 experiments/1a/ 下的 02-agent-presets、03-workspace-registry、06-session-shell-env、07-hot-reload，以及 _shared/harness.mjs。

## 已知线索（Claude 2026-10-23 读 dsh 0.2.1-rc.2 的 npm 包得到，桌面版本身未验证）

- npm 装的 `dsh` 拒绝 `--profile desktop`，报 `profile "desktop" is managed exclusively by the Electron application`（`lib/bin.js` 的 `rejectElectronProfile`）。
- 但 `runCli()` 有一个 `manageDesktopProfile` 选项。README 说桌面版自带的命令入口（carrier）会打开它，从而可以对已初始化的 `desktop` profile 执行 `dsh plugin`；npm 启动的不打开。
- `dsh plugin --profile desktop` 要求先打开过一次桌面版来初始化 profile，并且运行时桌面版要完全退出（`lib/plugin-*.js` 的 `requireDesktopProfile`）。
- profile 目录是 `<DSH_HOME>/profiles/desktop`，`DSH_HOME` 依次取显式配置、环境变量 `DSH_HOME`、`~/.dsh`（`dsh-home-paths`）。桌面版用的是不是同一个 `DSH_HOME`，未验证。
- 插件管理器文档写着：Desktop 的包管理操作由 Desktop shell 负责。桌面版界面里可能也能装插件。

## 第 0 步：沙箱自检（必须先做）

运行下面两条命令，把输出原样写进汇报：

    pgrep -af dsh
    cat /proc/1/cmdline | tr '\0' ' '

输出里有用户日常运行的 dsh Web 进程（不是你自己沙箱里的进程），说明沙箱没有隔离进程：立即停止，只汇报这一步。

## 任务

在 `experiments/1a/15-desktop-windows/` 下写一套探针：

- 测试插件 `plugin/`；
- 分阶段的驱动脚本 `run.mjs`；
- `README.md`（中文，按步骤写）：执行者是 Windows 上的 Claude Code，也要让人能照着做。每步标明【自动】（执行者运行命令即可）或【需要人】（要用户在桌面版界面里看或操作），写明要做什么、成功的判断、要记录什么。

脚本只用 Node 内置模块，**同一份代码要能在 Windows 和 Linux 上运行**：路径用 `path` 拼接；启动命令用 `process.execPath` 运行解析出的 `.js` 入口，或在 Windows 上正确处理 `.cmd`；不写死任何路径。

### 测试插件

- 加载后在 `127.0.0.1` 的随机端口上监听。
- 把 `{ port, token, pid, profile, dshVersion, startedAt }` 写到 `<DSH_HOME>/agent-collab/probe-<profile>.json`。
- 用换行分隔的 JSON 提供几条命令，每条都要带令牌：
  - `ping`；
  - `services`：哪些服务能拿到，包括 `agents`、`agentPresets`、`agentDefaultModel`、`sessions`、`shellEnv`、`permissionPresets`、`ctx.get('workspaceRegistry')`；
  - `presets`：工具预设的 id 列表；
  - `createSession { cwd, title }`：建一个会话，在 setup 里 `mount` 上 `standard`，用 `shellEnv` 注入 `DSH_AGENT_COLLAB_ROLE=executor`，再挂到 `cwd` 对应的工作区，返回会话 id 和工作区 id。**不发消息，不调用模型**；
  - `info`：`process.platform`、`process.version`、`process.execPath`、`DSH_HOME` 的解析结果、profile 名。
- 每次命令和加载过程都写一行日志到 `<DSH_HOME>/agent-collab/probe.log`。
- 插件卸载（scope 释放）时删除发现文件。

### `run.mjs` 的阶段（`node run.mjs <阶段>`）

每个阶段把结果追加到 `experiments/1a/15-desktop-windows/results-<主机平台>.json`（这个文件不提交；在 `.gitignore` 里加一行忽略它），并打印摘要。

1. `env`：记录下面这些情况，任何一项找不到都只记录，不报错：
   - 平台、Windows 版本、Node 版本；
   - PATH 上的 `dsh`、`pnpm`、`node`，用 `where` 或 `which` 查；
   - `DSH_HOME` 环境变量；默认 `DSH_HOME` 下有哪些 profile、有没有 `profiles/desktop/package.json`；
   - 桌面版的安装目录：环境变量 `AC_DESKTOP_DIR` 给了就用它；否则在 Windows 的常见安装位置（`%LOCALAPPDATA%\Programs`、`%ProgramFiles%`）下只列出一级目录名里含 `deepseek`、`dsh`、`harness` 的项（不区分大小写），不递归遍历整个磁盘；
   - 在找到的安装目录里，找 `name` 为 `@deepseek-ai/dsh` 的 `package.json`，以及看起来是命令入口的文件，记录相对安装目录的路径和版本。
2. `launch [--home <目录>]` 和 `quit`：启动和退出桌面版，供后面各阶段调用，也可以单独运行。
   - `launch`：启动 `env` 阶段找到的桌面版可执行文件（可用环境变量 `AC_DESKTOP_EXE` 指定）。用 `detached` 启动；给了 `--home` 时设置 `DSH_HOME`。把 PID 记进结果文件。
   - `quit`：只结束 `launch` 记下的那个 PID 及其子进程（Windows 上 `taskkill /PID <pid> /T`，必要时加 `/F`）。然后按 PID 确认它们都已退出（`tasklist /FI "PID eq <pid>"`），最多等 30 秒。
   - 桌面版如果是用户自己打开的（不是 `launch` 起的），`quit` 不去结束它，只提示请用户从界面或托盘完全退出。**不按进程名查找或结束任何进程。**
   - 退出后桌面版可能仍有托盘进程。`quit` 要按 PID 核对 `launch` 记下的进程树是否都已退出，没退干净就如实记录。
3. `isolate-check`：判断桌面版是否认 `DSH_HOME` 环境变量。
   - 在 `os.tmpdir()` 下建一个临时目录。
   - 用 `launch --home <临时目录>` 启动，等 20 秒后 `quit`。
   - 检查临时目录下有没有出现 `profiles/desktop`。
   - 认就记录“可隔离”；后面各阶段都支持 `--home <目录>`，默认用真实的默认 `DSH_HOME`。
4. `install`：
   - `profiles/desktop/package.json` 还不存在时，先 `launch` 打开一次桌面版来初始化，等 20 秒后 `quit`。
   - 要求桌面版已完全退出。脚本只能确认 `launch` 记下的进程已退出；桌面版是用户自己打开过的，README 要标【需要人】，请用户确认已经完全退出。
   - 先备份 `profiles/desktop/package.json` 和 `cordis.patch.yml` 到实验目录下的 `backup/`（不提交，加进 `.gitignore`），并记录哈希。
   - 用 `npm pack` 打出测试插件的 `.tgz`。
   - 依次尝试：
     1. 桌面版自带的命令入口执行 `plugin --profile desktop add <tgz>`；
     2. 没有可用入口时，记录原因，并在 README 里请用户试桌面版界面里的插件安装功能，能否装本地 `.tgz` 由用户回答。
   - 记录用的命令、退出码、输出（截断）、是否需要 pnpm 和联网，以及 `package.json` 的 `dsh.profile.bundles` 前后变化。
5. `check`：先 `launch`（不带 `--home`）启动桌面版，然后：
   - 等发现文件出现（超时 60 秒）。
   - 连上插件，依次执行 `ping`、`info`、`services`、`presets`。
   - 在临时目录下建一个工作区目录，执行 `createSession`。
   - 打印会话标题和工作区路径。README 标【需要人】：请用户在桌面版侧栏里确认能否看到它，并截图。执行者如果有截屏能力，可以自己看。
   - 再执行一次 `createSession`，验证同一工作区复用。
6. `uninstall`：
   - 先 `quit`，确认桌面版已完全退出。
   - 用 `install` 阶段成功的那条路径卸载测试插件（界面安装的就请用户在界面里卸载）。
   - 对比 `package.json`、`cordis.patch.yml` 和备份的哈希；不一致时打印差异，不要自动用备份覆盖，由用户决定。
   - 删除发现文件、日志和本探针建的临时目录（只删自己建的，删前确认在 `os.tmpdir()` 或 `<DSH_HOME>/agent-collab/` 下）。
7. `report`：读结果文件，按下面“要回答的问题”逐条输出结论，最后一行 `RESULT: 成立|不成立|部分成立` 加一句结论。

### 要回答的问题

1. 桌面版自带的命令入口在哪、怎么调用；它能否在桌面版退出时给 `desktop` profile 装本地 `.tgz`；需不需要 pnpm、要不要联网。
2. 桌面版界面能否装本地 `.tgz`（用户回答）。
3. 装上后，桌面版重启时插件能否加载；§5.4 列的服务能否拿到；预设 id 是否和 Web 一致。
4. 插件能否监听回环端口、写发现文件，外部的 Node 进程能否连上。
5. 插件建的会话能否出现在桌面版侧栏对应的工作区下；同一路径的工作区是否复用。
6. 桌面版是否认 `DSH_HOME` 环境变量，也就是能否用临时目录隔离测试。
7. 只装了桌面版时，机器上有没有可用的 Node 和命令行 `dsh`（影响 PLAN.md D3 和 §11.5 的自动启动、退回 acp）。
8. 卸载后 profile 是否恢复原样。

## Linux 上的空跑（交付前必须做）

- npm 装的 dsh 不能管 `desktop` profile，所以空跑用临时 `DSH_HOME` 和 `web` profile 代替：`run.mjs` 加一个 `--profile <名称>` 参数，默认 `desktop`。
- 空跑时用 `dsh plugin --profile web add` 安装；`launch` 和 `quit` 在空跑里改成按 harness 的做法以 `--port 0 --no-open` 启动、按 PID 停止被测 dsh Web，代替桌面版。
- 依次跑 `install`、`check`、`uninstall`、`report`，证明插件和脚本本身没问题。空跑脚本 `dry-run-linux.mjs` 一条命令跑完，最后一行 `RESULT:`。
- `env` 和 `isolate-check` 阶段在 Linux 上只需不报错。

## 验收标准

- AC1：第 0 步按要求执行并原样汇报。
- AC2：`node experiments/1a/15-desktop-windows/dry-run-linux.mjs` 用 RUNBOOK“重跑第 1a 阶段的实验”里的 bwrap 命令运行，最后一行是 `RESULT: 成立`。空跑覆盖：插件加载、发现文件、令牌校验（错误令牌被拒绝）、六类服务探测、`createSession` 的会话挂了 `standard` 预设并带上环境变量、工作区复用、卸载后 `package.json` 和 `cordis.patch.yml` 的哈希恢复。结束后临时目录已删除，没有残留进程。
- AC3：`run.mjs` 和插件里没有写死的路径、端口、用户名；Windows 的分支（`where`、`.cmd`、`%LOCALAPPDATA%`）有代码审查得到的说明，在汇报里列出“只在 Windows 上才走到、Linux 空跑覆盖不到的分支”。
- AC4：README.md 让 Windows 上一个没有本项目背景的 Claude Code 会话（或一个人）能照着做完，内容包括：
  - 前置条件：装 Node ≥ 20 的方法、拿到代码的方法；
  - 每个阶段的命令，cmd 和 PowerShell 都给，命令都是非交互的；
  - 每步的【自动】或【需要人】标记，以及成功的判断；
  - 出错时怎么办，哪些情况要停下来问用户；
  - 最后怎么确认已恢复原样、要交回哪些文件；
  - 执行者要遵守的安全规则（本节最后一条）。
- AC5：`npm test` 仍然全部通过；实验文件不会被 `node --test` 当成测试；结果文件和备份目录被 `.gitignore` 忽略。

## 隔离和安全（违反任何一条都算不通过）

- 在 Linux 上：遵守 RUNBOOK“派发 dsh 任务”的全部规定，不使用第 6 条的例外。
- 不读写用户 Linux 上的 `~/.dsh`；不访问 dsh 的默认端口；只停止自己 spawn 的进程（按 PID）。
- 探针在 Windows 上会修改真实的 `desktop` profile（用户已同意）。所以：
  - 只在 `install` 和 `uninstall` 两个阶段写 profile；
  - 写之前必须备份；
  - 不读、不复制、不打印 `.env` 和任何凭据文件；
  - 不调用模型；
  - 不修改桌面版安装目录里的任何文件。
- Windows 上的执行者只结束 `launch` 自己启动的进程（按 PID）。只在 `install`、`uninstall` 时写 `desktop` profile，不碰其他 profile 和凭据，不调用模型，不提交、不推送。这些规则 README 里要写明。
- 结果文件里不写用户名和个人路径：路径一律用 `%USERPROFILE%`、`%LOCALAPPDATA%`、`<DSH_HOME>`、`<安装目录>` 这类符号形式输出。
- 遇到需要越权（审批）的操作：不要申请，记为发现。
- 不执行 git commit、git push；不修改 docs/PLAN.md、AGENTS.md 和 docs/context/ 下的任何文件。发现与 PLAN.md 不一致的地方，写进汇报。

## 汇报

在对话里汇报：

- 第 0 步的原样输出；
- 新建或修改的文件清单；
- 逐条 AC 的结果和证据；
- 空跑的最后几行输出；
- Linux 空跑覆盖不到的 Windows 分支清单；
- `npm test` 的结果；
- 清理检查的方法和结果；
- 没做完的项、遇到的问题和你的疑问。

不写 REPORT.md：Windows 结果出来后由 Claude 汇总。
