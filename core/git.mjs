// 本文件：git 基线、补丁和违规检查（D21；docs/protocol.md 5.3）。工作进程与 run start 共用；做法变化时更新。

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 运行 git，返回 { code, stdout, stderr }；不抛错（除非启动失败）。 */
export function git(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function gitOk(args, options) {
  const result = await git(args, options);
  if (result.code !== 0) {
    const error = new Error('git ' + args.join(' ') + ' 失败：' + (result.stderr.trim() || ('退出码 ' + result.code)));
    error.code = 'GIT_FAILED';
    error.exitCode = result.code;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

/** 求仓库根目录（realpath 之后）；不是 git 仓库时返回 null。 */
export async function findRepoRoot(cwd) {
  const result = await git(['rev-parse', '--show-toplevel'], { cwd });
  if (result.code !== 0) return null;
  const root = result.stdout.trim();
  if (!root) return null;
  return fsp.realpath(root);
}

/** 当前 HEAD 和分支；空仓库的 HEAD 为 null，分离 HEAD 的分支为 null。 */
export async function readHead(repoRoot) {
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoRoot });
  const branch = await git(['symbolic-ref', '--short', '--quiet', 'HEAD'], { cwd: repoRoot });
  return {
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
  };
}

/** 用户自己的 index 文件路径（相对 cwd 的返回值按仓库根目录解析）；没有时返回 null。 */
async function userIndexFile(repoRoot) {
  const result = await git(['rev-parse', '--git-path', 'index'], {
    cwd: repoRoot,
    env: { ...process.env, GIT_INDEX_FILE: undefined },
  });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

/**
 * 拍工作区快照：用临时 index 把当前工作区（含未跟踪文件、不含被忽略的新文件）写成 tree 对象。
 * 临时 index 从用户 index 的副本开始（只读用户 index），这样被跟踪又被 .gitignore 匹配的文件也在快照里，
 * git add 还能用上 stat 缓存。不改分支、不写 ref、不动用户的 .git/index；临时文件放在仓库之外，用完即删。
 */
export async function snapshotWorktree(repoRoot, options = {}) {
  const root = await fsp.realpath(repoRoot);
  const ownDir = !options.tempDir;
  const tempDir = options.tempDir ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-collab-index-'));
  const indexFile = path.join(tempDir, 'index-' + crypto.randomBytes(6).toString('hex'));
  const userIndex = await userIndexFile(root);
  if (userIndex) {
    try {
      await fsp.copyFile(userIndex, indexFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await gitOk(['add', '-A', '--', '.'], { cwd: root, env });
    const tree = (await gitOk(['write-tree'], { cwd: root, env })).trim();
    const { head, branch } = await readHead(root);
    return { tree, head, branch, repoRoot: root };
  } finally {
    for (const file of [indexFile, indexFile + '.lock']) {
      try {
        await fsp.unlink(file);
      } catch {
        // 临时 index 可能未被创建。
      }
    }
    if (ownDir) {
      try {
        await fsp.rmdir(tempDir);
      } catch {
        // 目录非空或已不存在，忽略。
      }
    }
  }
}

/** 两个 tree 之间的补丁（含新建文件，二进制文件用 --binary）。 */
export async function diffTrees(repoRoot, fromTree, toTree) {
  return gitOk(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', fromTree, toTree], { cwd: repoRoot });
}

/** 按 NUL 切分 git -z 的输出（路径里有空格、引号、中文都不受影响）。 */
function splitNul(text) {
  return String(text).split('\u0000');
}

/** 解析 `git diff --numstat -z` 的输出，返回 新路径 → { added, deleted }。改名记录是“added\\tdeleted\\t”加旧路径、新路径两个字段。 */
function parseNumstatZ(text) {
  const counts = new Map();
  const tokens = splitNul(text);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const added = token.slice(0, firstTab) === '-' ? 0 : Number(token.slice(0, firstTab));
    const deleted = token.slice(firstTab + 1, secondTab) === '-' ? 0 : Number(token.slice(firstTab + 1, secondTab));
    let key = token.slice(secondTab + 1);
    if (key === '') {
      // 改名：`added\tdeleted\t` NUL 旧路径 NUL 新路径 NUL
      const to = tokens[index + 2] ?? '';
      index += 2;
      key = to;
    }
    if (!key) continue;
    counts.set(key, { added, deleted });
  }
  return counts;
}

/** 两个 tree 之间的改动统计：files[] 和 stat 文字。路径用 -z 原样解析，不做引号转义。 */
export async function changesBetween(repoRoot, fromTree, toTree) {
  const nameStatus = await gitOk(['diff', '-M', '--name-status', '-z', '--no-color', '--no-ext-diff', fromTree, toTree], { cwd: repoRoot });
  const numstat = await gitOk(['diff', '-M', '--numstat', '-z', '--no-color', '--no-ext-diff', fromTree, toTree], { cwd: repoRoot });
  const stat = await gitOk(['diff', '-M', '--stat', '--no-color', '--no-ext-diff', fromTree, toTree], { cwd: repoRoot });

  const counts = parseNumstatZ(numstat);

  const files = [];
  const tokens = splitNul(nameStatus);
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = tokens[index + 1];
      const to = tokens[index + 2];
      index += 2;
      const count = counts.get(to) ?? { added: 0, deleted: 0 };
      files.push({ path: to, change: 'R', from, added: count.added, deleted: count.deleted });
    } else if (status.startsWith('A') || status.startsWith('M') || status.startsWith('D') || status.startsWith('T')) {
      const target = tokens[index + 1];
      index += 1;
      const change = status.startsWith('D') ? 'D' : status.startsWith('A') ? 'A' : 'M';
      const count = counts.get(target) ?? { added: 0, deleted: 0 };
      files.push({ path: target, change, added: count.added, deleted: count.deleted });
    }
  }
  return { files, stat: stat.trimEnd() };
}

/** 把受保护路径当字面量传给 git：`*`、`?` 不按通配符解释；以 `/` 结尾仍按目录匹配。 */
function literalPathspec(value) {
  return ':(literal)' + value;
}

/** 列出两个 tree 之间在给定路径下的改动文件（路径原样返回）。 */
export async function changedPathsUnder(repoRoot, fromTree, toTree, pathspec) {
  const output = await gitOk(
    ['diff', '--name-only', '-z', '--no-color', '--no-ext-diff', fromTree, toTree, '--', literalPathspec(pathspec)],
    { cwd: repoRoot },
  );
  return splitNul(output).filter(Boolean);
}

/**
 * 检查违规：受保护路径有变化 → protected_path；HEAD 变了 → head_moved；分支变了 → branch_changed。
 * 违规只记录，不改变任务状态。
 */
export async function checkViolations({ repoRoot, baseline, currentTree, protectedPaths }) {
  const violations = [];
  for (const protectedPath of protectedPaths ?? []) {
    if (typeof protectedPath !== 'string' || protectedPath === '') continue;
    const files = await changedPathsUnder(repoRoot, baseline.tree, currentTree, protectedPath);
    if (files.length > 0) {
      violations.push({
        kind: 'protected_path',
        path: protectedPath,
        detail: '改动了 ' + files.join(', '),
      });
    }
  }
  const { head, branch } = await readHead(repoRoot);
  if (head !== (baseline.head ?? null)) {
    violations.push({
      kind: 'head_moved',
      detail: 'HEAD 从 ' + String(baseline.head ?? null) + ' 变为 ' + String(head ?? null),
    });
  }
  if (branch !== (baseline.branch ?? null)) {
    violations.push({
      kind: 'branch_changed',
      detail: '分支从 ' + String(baseline.branch ?? null) + ' 变为 ' + String(branch ?? null),
    });
  }
  return violations;
}
