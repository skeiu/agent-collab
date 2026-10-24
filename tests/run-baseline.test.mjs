// 本文件：S3 的基线、补丁和违规测试（AC2、AC3）：未跟踪文件和被忽略文件按 D21 处理，用户的 index 和 ref 不动，受保护路径和 HEAD、分支变化都记成违规。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertExit,
  createContext,
  makeReport,
  readJson,
  run,
  runCli,
  startFakeExecutor,
  turnWithReport,
} from './helpers/run-harness.mjs';

async function runTask(ctx, script, options = {}) {
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport(), { steps: script })] }, { name: options.name });
  const briefPath = path.join(ctx.root, 'brief-' + (options.name ?? 'exec') + '.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const argv = ['run', 'start', '--brief', briefPath, '--executor', 'fake'];
  for (const item of options.protected ?? []) argv.push('--protected', item);
  const start = await runCli(ctx, argv, { executor });
  assertExit(start, 0);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor });
  assertExit(wait, 0);
  await executor.stop();
  const runDir = start.json.runDir;
  return {
    runId: start.json.runId,
    runDir,
    state: await readJson(path.join(runDir, 'state.json')),
    summary: await readJson(path.join(runDir, 'summary.json')),
  };
}

test('基线：派发前的未跟踪文件和被忽略文件不进补丁，执行端新建的未跟踪文件进补丁，用户的 index 和 ref 不动', async (t) => {
  const ctx = await createContext('baseline');
  t.after(() => ctx.cleanup());

  // 派发前：设计端预先写的测试文件、用户原有的未跟踪文件、被忽略的文件。
  await fsp.mkdir(path.join(ctx.repo, 'tests'), { recursive: true });
  await fsp.writeFile(path.join(ctx.repo, 'tests', 'designer.test.mjs'), '// 设计端预先写的验收测试\n');
  await fsp.writeFile(path.join(ctx.repo, 'notes.txt'), '用户原有的未跟踪文件\n');
  await fsp.writeFile(path.join(ctx.repo, '.gitignore'), 'ignored.log\n');
  await fsp.writeFile(path.join(ctx.repo, 'ignored.log'), '被忽略的日志\n');
  await run('git', ['add', '.gitignore'], { cwd: ctx.repo });
  await run('git', ['commit', '-qm', 'add gitignore'], { cwd: ctx.repo });

  const indexBefore = await fsp.readFile(path.join(ctx.repo, '.git', 'index'));
  const refsBefore = (await run('git', ['for-each-ref'], { cwd: ctx.repo })).stdout;

  const { runDir } = await runTask(ctx, [
    { kind: 'write', path: 'src/feature.js', content: 'export const b = 2;\n' },
    { kind: 'event', event: { type: 'tool_call', callId: 'c1', name: 'write', input: { file_path: 'src/feature.js' } } },
  ]);

  const patch = await fsp.readFile(path.join(runDir, 'patch-1.diff'), 'utf8');
  assert.match(patch, /src\/feature\.js/, '执行端新建的未跟踪文件应在补丁里');
  assert.doesNotMatch(patch, /notes\.txt/, '派发前就有的未跟踪文件不应出现在补丁里');
  assert.doesNotMatch(patch, /designer\.test\.mjs/, '设计端预先写的测试不应出现在补丁里');
  assert.doesNotMatch(patch, /ignored\.log/, '被忽略的文件不应出现在补丁里');
  assert.doesNotMatch(patch, /README\.md/, '没改的文件不应出现在补丁里');

  const indexAfter = await fsp.readFile(path.join(ctx.repo, '.git', 'index'));
  assert.ok(indexBefore.equals(indexAfter), '用户的 .git/index 被改动了');
  const refsAfter = (await run('git', ['for-each-ref'], { cwd: ctx.repo })).stdout;
  assert.equal(refsAfter, refsBefore, 'git for-each-ref 的输出变了');

  const summary = await readJson(path.join(runDir, 'summary.json'));
  assert.deepEqual(summary.violations, []);
  assert.deepEqual(summary.changes.files, [{ path: 'src/feature.js', change: 'A', added: 1, deleted: 0 }]);
  assert.match(summary.changes.stat, /1 file changed/);
});

test('违规：改受保护文件、改受保护目录下的文件、提交、切分支分别被记录', async (t) => {
  const ctx = await createContext('violations');
  t.after(() => ctx.cleanup());

  await fsp.writeFile(path.join(ctx.repo, 'protected.txt'), '受保护\n');
  await fsp.mkdir(path.join(ctx.repo, 'guard'), { recursive: true });
  await fsp.writeFile(path.join(ctx.repo, 'guard', 'keep.txt'), '受保护目录\n');
  await fsp.writeFile(path.join(ctx.repo, 'work.txt'), '工作文件\n');
  await fsp.writeFile(path.join(ctx.repo, 'configured.txt'), '配置里保护的\n');
  await fsp.writeFile(path.join(ctx.repo, '.agent-collab.json'), JSON.stringify({ protectedPaths: ['configured.txt'] }) + '\n');
  await run('git', ['add', '-A'], { cwd: ctx.repo });
  await run('git', ['commit', '-qm', 'fixtures'], { cwd: ctx.repo });

  // 1) 改受保护文件 + 改受保护目录下的文件 + 改配置里声明的受保护文件
  const first = await runTask(ctx, [
    { kind: 'append', path: 'protected.txt', content: '被改了\n' },
    { kind: 'write', path: 'guard/new.txt', content: '受保护目录里的新文件\n' },
    { kind: 'append', path: 'configured.txt', content: '配置保护的也被改了\n' },
  ], { name: 'protected', protected: ['protected.txt', 'guard/'] });
  const protectedKinds = first.summary.violations.filter((item) => item.kind === 'protected_path').map((item) => item.path).sort();
  assert.deepEqual(protectedKinds, ['configured.txt', 'guard/', 'protected.txt']);
  assert.deepEqual(first.state.protectedPaths.slice().sort(), ['configured.txt', 'guard/', 'protected.txt']);
  assert.equal(first.state.status, 'done', '违规不应改变任务状态');

  // 2) 执行端提交
  const second = await runTask(ctx, [
    { kind: 'append', path: 'work.txt', content: '改动\n' },
    { kind: 'git', args: ['commit', '-qam', 'executor commit'] },
  ], { name: 'commit' });
  assert.deepEqual(second.summary.violations.map((item) => item.kind), ['head_moved']);
  assert.equal(second.state.status, 'done');

  // 3) 执行端切分支
  const third = await runTask(ctx, [
    { kind: 'git', args: ['checkout', '-qb', 'executor-branch'] },
  ], { name: 'branch' });
  const kinds = third.summary.violations.map((item) => item.kind).sort();
  assert.ok(kinds.includes('branch_changed'), JSON.stringify(third.summary.violations));
  assert.equal(third.state.status, 'done');
});

test('已跟踪且匹配 .gitignore 的文件被执行端修改：进补丁和 changes，受保护时记 protected_path，用户 index 不变（RW4）', async (t) => {
  const ctx = await createContext('ignored-tracked');
  t.after(() => ctx.cleanup());
  await fsp.writeFile(path.join(ctx.repo, '.gitignore'), 'secret.conf\n');
  await fsp.writeFile(path.join(ctx.repo, 'secret.conf'), 'v=1\n');
  await run('git', ['add', '.gitignore'], { cwd: ctx.repo });
  await run('git', ['add', '-f', 'secret.conf'], { cwd: ctx.repo });
  await run('git', ['commit', '-qm', 'tracked ignored'], { cwd: ctx.repo });

  const indexBefore = await fsp.readFile(path.join(ctx.repo, '.git', 'index'));
  const { runDir, summary, state } = await runTask(ctx, [
    { kind: 'append', path: 'secret.conf', content: 'v=2\n' },
  ], { name: 'ignored', protected: ['secret.conf'] });

  const patch = await fsp.readFile(path.join(runDir, 'patch-1.diff'), 'utf8');
  assert.match(patch, /secret\.conf/, '被跟踪又被忽略的文件应出现在补丁里');
  assert.deepEqual(summary.changes.files, [{ path: 'secret.conf', change: 'M', added: 1, deleted: 0 }]);
  assert.equal(summary.violations.length, 1);
  assert.equal(summary.violations[0].kind, 'protected_path');
  assert.equal(summary.violations[0].path, 'secret.conf');
  assert.match(summary.violations[0].detail, /secret\.conf/);
  assert.equal(state.status, 'done');

  const indexAfter = await fsp.readFile(path.join(ctx.repo, '.git', 'index'));
  assert.ok(indexBefore.equals(indexAfter), '用户的 .git/index 被改动了');
});

test('中文路径、跨目录改名、带空格的路径和受保护路径里的 * 按字面处理（RW5）', async (t) => {
  const ctx = await createContext('paths');
  t.after(() => ctx.cleanup());
  // Windows 文件名不能含 *，建 star*file.txt 会在 writeFile 时直接 ENOENT；只在非 Windows 上测这一部分，
  // 中文、空格、跨目录改名和“受保护路径里的 * 不能按通配符匹配”照测。
  const canUseStar = process.platform !== 'win32';
  if (!canUseStar) {
    t.diagnostic('Windows 文件名不能含 *：跳过 star*file.txt 的建文件和改名断言，保留星号按字面匹配的断言');
  }
  const lines = (changedLine) =>
    Array.from({ length: 20 }, (_, index) => (index === changedLine ? 'line changed' : 'line ' + index)).join('\n') + '\n';

  await fsp.mkdir(path.join(ctx.repo, 'src', 'a'), { recursive: true });
  await fsp.writeFile(path.join(ctx.repo, 'src', 'a', 'f.js'), lines(-1));
  await fsp.writeFile(path.join(ctx.repo, '中文 文件.txt'), '一\n');
  if (canUseStar) await fsp.writeFile(path.join(ctx.repo, 'star*file.txt'), 'x\n');
  await fsp.writeFile(path.join(ctx.repo, 'starXfile.txt'), 'x\n');
  await fsp.mkdir(path.join(ctx.repo, 'dir with space'), { recursive: true });
  await fsp.writeFile(path.join(ctx.repo, 'dir with space', 'file name.txt'), 'y\n');
  await run('git', ['add', '-A'], { cwd: ctx.repo });
  await run('git', ['commit', '-qm', 'paths'], { cwd: ctx.repo });

  const steps = [
    { kind: 'write', path: 'src/b/f.js', content: lines(5) },
    { kind: 'delete', path: 'src/a/f.js' },
    { kind: 'append', path: '中文 文件.txt', content: '二\n' },
    { kind: 'append', path: 'starXfile.txt', content: 'xx\n' },
    { kind: 'append', path: 'dir with space/file name.txt', content: 'yy\n' },
  ];
  if (canUseStar) steps.splice(3, 0, { kind: 'append', path: 'star*file.txt', content: 'xx\n' });

  const { summary } = await runTask(ctx, steps, { name: 'paths', protected: ['中文 文件.txt', 'star*file.txt', 'dir with space/'] });

  const rename = summary.changes.files.find((item) => item.change === 'R');
  assert.deepEqual(rename, { path: 'src/b/f.js', change: 'R', from: 'src/a/f.js', added: 1, deleted: 1 });
  const chinese = summary.changes.files.find((item) => item.path === '中文 文件.txt');
  assert.ok(chinese, '中文路径应原样出现：' + JSON.stringify(summary.changes.files));
  assert.equal(chinese.added, 1);
  const spaced = summary.changes.files.find((item) => item.path === 'dir with space/file name.txt');
  assert.ok(spaced, '带空格的路径应原样出现：' + JSON.stringify(summary.changes.files));

  const protectedViolations = summary.violations.filter((item) => item.kind === 'protected_path');
  const chineseViolation = protectedViolations.find((item) => item.path === '中文 文件.txt');
  assert.equal(chineseViolation.detail, '改动了 中文 文件.txt');
  if (canUseStar) {
    const starViolation = protectedViolations.find((item) => item.path === 'star*file.txt');
    assert.match(starViolation.detail, /star\*file\.txt/);
  }
  assert.equal(protectedViolations.some((item) => item.path === 'starXfile.txt'), false, '受保护路径里的 * 不能按通配符匹配');
  assert.ok(summary.changes.files.some((item) => item.path === 'starXfile.txt' && item.change === 'M'));
});
