// 本文件：core/config.mjs 的单元测试。覆盖三级合并、默认值、项目级限制、错误、原子写入和权限；配置规则变化时更新。

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ConfigFileError,
  ConfigScopeError,
  ConfigTightenError,
  applyDefaults,
  configSchema,
  getExecutorOptions,
  loadConfig,
  mergeConfigs,
  saveConfig,
  validateConfig,
} from '../core/config.mjs';
import { ValidationError } from '../core/schema-check.mjs';

async function makeSandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-collab-config-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  return {
    root,
    home,
    repo,
    async writeJson(file, data) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data, null, 2));
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('文件缺失不算错，读取时用 schema 默认值补齐', async () => {
  const box = await makeSandbox();
  try {
    const { config, errors, sources } = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.deepEqual(errors, []);
    assert.equal(configSchema.version, 1);
    assert.equal(config.dsh.profile, 'web');
    assert.equal(config.reasoningEffort, 'high');
    assert.equal(config.permissionPreset, 'workspace-write');
    assert.deepEqual(config.executorByDesigner, { claude: 'dsh', dsh: 'claude', codex: 'dsh' });
    assert.deepEqual(config.executors, {});
    assert.equal(sources.global, path.join(box.home, 'config.json'));
    assert.equal(sources.project, path.join(box.repo, '.agent-collab.json'));
    assert.equal(validateConfig(config).valid, true);
  } finally {
    await box.cleanup();
  }
});

test('三级覆盖顺序：任务 > 项目 > 全局', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.home, 'config.json'), { model: 'global-model', protectedPaths: ['g1', 'g2'] });
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { model: 'project-model', protectedPaths: ['p1'] });
    const project = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.equal(project.config.model, 'project-model');
    assert.deepEqual(project.config.protectedPaths, ['g1', 'g2', 'p1']);
    const task = await loadConfig({ home: box.home, repoDir: box.repo, taskConfig: { model: 'task-model' } });
    assert.equal(task.config.model, 'task-model');
    assert.deepEqual(task.config.protectedPaths, ['g1', 'g2', 'p1']);
    const global = await loadConfig({ home: box.home, repoDir: null });
    assert.equal(global.config.model, 'global-model');
    assert.deepEqual(global.config.protectedPaths, ['g1', 'g2']);
  } finally {
    await box.cleanup();
  }
});

test('任务级数组整体替换；项目级 protectedPaths 按并集处理', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.home, 'config.json'), { protectedPaths: ['a', 'b'] });
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { protectedPaths: ['c'] });
    const { config } = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.deepEqual(config.protectedPaths, ['a', 'b', 'c']);
    const task = await loadConfig({ home: box.home, repoDir: box.repo, taskConfig: { protectedPaths: ['d'] } });
    assert.deepEqual(task.config.protectedPaths, ['d']);
  } finally {
    await box.cleanup();
  }
});

test('项目级不允许的项报错、不生效，其余项照常生效', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), {
      permissionPreset: 'danger-full-access',
      warnSameAgentPair: false,
      unattendedApproval: 'allow',
      allowedRoots: ['/tmp'],
      env: { SECRET: 'x' },
      inheritEnv: 'login-shell',
      autoSync: false,
      runRetentionDays: 1,
      dsh: { profile: 'custom' },
      executors: { codex: { command: '/tmp/codex', env: { X: '1' }, model: 'kept-model' } },
    });
    const { config, errors } = await loadConfig({ home: box.home, repoDir: box.repo });
    const keys = errors.map((error) => error.keyPath).sort();
    assert.deepEqual(keys, [
      'allowedRoots',
      'autoSync',
      'dsh.profile',
      'env',
      'executors.codex.command',
      'executors.codex.env',
      'inheritEnv',
      'permissionPreset',
      'runRetentionDays',
      'unattendedApproval',
    ]);
    assert.ok(errors.every((error) => error instanceof ConfigScopeError));
    assert.equal(config.permissionPreset, 'workspace-write');
    assert.equal(config.unattendedApproval, 'deny');
    assert.equal(config.allowedRoots, null);
    assert.deepEqual(config.env, {});
    assert.equal(config.inheritEnv, 'designer');
    assert.equal(config.autoSync, true);
    assert.equal(config.runRetentionDays, 30);
    assert.equal(config.dsh.profile, 'web');
    assert.equal(config.warnSameAgentPair, false);
    assert.equal(config.executors.codex.model, 'kept-model');
    assert.equal(config.executors.codex.command, null);
    assert.deepEqual(config.executors.codex.env, {});
  } finally {
    await box.cleanup();
  }
});

test('protectedPaths：项目级并集保持先全局后项目顺序并去重，空数组视为放宽', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.home, 'config.json'), { protectedPaths: ['global-a', 'shared'] });
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { protectedPaths: ['shared', 'project-b', 'project-b'] });
    let result = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.config.protectedPaths, ['global-a', 'shared', 'project-b']);

    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { protectedPaths: [] });
    result = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0] instanceof ConfigTightenError);
    assert.equal(result.errors[0].keyPath, 'protectedPaths');
    assert.equal(result.errors[0].reason, 'loosens');
    assert.deepEqual(result.config.protectedPaths, ['global-a', 'shared']);
  } finally {
    await box.cleanup();
  }
});

test('confirmBeforeDispatch：项目级只能取更严的值', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.home, 'config.json'), { confirmBeforeDispatch: 'risky' });
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { confirmBeforeDispatch: 'always' });
    let result = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.confirmBeforeDispatch, 'always');

    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { confirmBeforeDispatch: 'never' });
    result = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0] instanceof ConfigTightenError);
    assert.equal(result.errors[0].keyPath, 'confirmBeforeDispatch');
    assert.equal(result.errors[0].previousValue, 'risky');
    assert.equal(result.errors[0].proposedValue, 'never');
    assert.equal(result.config.confirmBeforeDispatch, 'risky');
  } finally {
    await box.cleanup();
  }
});

test('freshReviewForRisky：项目级只有 true 生效', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.home, 'config.json'), { freshReviewForRisky: false });
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { freshReviewForRisky: true });
    let result = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.freshReviewForRisky, true);

    await box.writeJson(path.join(box.home, 'config.json'), { freshReviewForRisky: true });
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { freshReviewForRisky: false });
    result = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0] instanceof ConfigTightenError);
    assert.equal(result.errors[0].keyPath, 'freshReviewForRisky');
    assert.equal(result.config.freshReviewForRisky, true);
  } finally {
    await box.cleanup();
  }
});

test('commitOnAccept：项目级只有 false 生效', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.home, 'config.json'), { commitOnAccept: true });
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { commitOnAccept: false });
    let result = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.commitOnAccept, false);

    await box.writeJson(path.join(box.home, 'config.json'), { commitOnAccept: false });
    await box.writeJson(path.join(box.repo, '.agent-collab.json'), { commitOnAccept: true });
    result = await loadConfig({ home: box.home, repoDir: box.repo });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0] instanceof ConfigTightenError);
    assert.equal(result.errors[0].keyPath, 'commitOnAccept');
    assert.equal(result.config.commitOnAccept, false);
  } finally {
    await box.cleanup();
  }
});

test('单个任务级不受项目级收紧规则限制，可以放宽', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.home, 'config.json'), {
      protectedPaths: ['global-protected'],
      confirmBeforeDispatch: 'always',
      freshReviewForRisky: true,
      commitOnAccept: true,
    });
    const { config, errors } = await loadConfig({
      home: box.home,
      repoDir: box.repo,
      taskConfig: {
        protectedPaths: [],
        confirmBeforeDispatch: 'never',
        freshReviewForRisky: false,
        commitOnAccept: false,
      },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.protectedPaths, []);
    assert.equal(config.confirmBeforeDispatch, 'never');
    assert.equal(config.freshReviewForRisky, false);
    assert.equal(config.commitOnAccept, false);
  } finally {
    await box.cleanup();
  }
});

test('JSON 不合法时报错并带文件路径', async () => {
  const box = await makeSandbox();
  try {
    const file = path.join(box.home, 'config.json');
    await writeFile(file, '{ not json');
    await assert.rejects(loadConfig({ home: box.home, repoDir: null }), (error) => {
      assert.ok(error instanceof ConfigFileError);
      assert.equal(error.file, file);
      assert.ok(error.message.includes(file));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('不符合 schema 时报错并带文件路径和错误路径', async () => {
  const box = await makeSandbox();
  try {
    const file = path.join(box.repo, '.agent-collab.json');
    await box.writeJson(file, { maxCorrectionRounds: 99 });
    await assert.rejects(loadConfig({ home: box.home, repoDir: box.repo }), (error) => {
      assert.ok(error instanceof ConfigFileError);
      assert.equal(error.file, file);
      assert.ok(error.errors.some((item) => item.path === '/maxCorrectionRounds'));
      assert.match(error.message, /maxCorrectionRounds/);
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('saveConfig 先校验再写入，不合法时不落盘', async () => {
  const box = await makeSandbox();
  try {
    const file = path.join(box.home, 'config.json');
    await assert.rejects(saveConfig(file, { maxCorrectionRounds: 99 }), (error) => {
      assert.ok(error instanceof ValidationError);
      return true;
    });
    await assert.rejects(readFile(file, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await box.cleanup();
  }
});

test('saveConfig 写出完整 JSON、没有临时文件、POSIX 权限为 0600', async () => {
  const box = await makeSandbox();
  try {
    const file = path.join(box.home, 'config.json');
    const config = applyDefaults(configSchema, { model: 'example-model', env: { A: '1' } });
    await saveConfig(file, config);
    const text = await readFile(file, 'utf8');
    assert.deepEqual(JSON.parse(text), config);
    const names = await readdir(box.home);
    assert.deepEqual(names, ['config.json']);
    if (process.platform !== 'win32') {
      const info = await stat(file);
      assert.equal(info.mode & 0o777, 0o600);
      const dirInfo = await stat(box.home);
      assert.equal(dirInfo.mode & 0o777, 0o700);
    }
  } finally {
    await box.cleanup();
  }
});

test('saveConfig 的写入是原子的：并发读取始终能看到完整 JSON', async () => {
  const box = await makeSandbox();
  try {
    const file = path.join(box.home, 'config.json');
    await saveConfig(file, applyDefaults(configSchema, {}));
    let stop = false;
    let bad = 0;
    let reads = 0;
    const reader = (async () => {
      while (!stop) {
        try {
          const text = await readFile(file, 'utf8');
          JSON.parse(text);
          reads += 1;
        } catch {
          bad += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    // 写入抛错时也要停掉读循环，否则后台计时器会让测试挂住。
    try {
      for (let index = 0; index < 30; index += 1) {
        await saveConfig(file, applyDefaults(configSchema, { protectedPaths: ['p' + index] }));
      }
    } catch (error) {
      const attempts = error && typeof error === 'object' ? error.attempts : undefined;
      const elapsedMs = error && typeof error === 'object' ? error.elapsedMs : undefined;
      assert.fail(
        'saveConfig 失败：' + (error instanceof Error ? error.message : String(error)) +
        '（code=' + (error && error.code) + '，attempts=' + attempts + '，elapsedMs=' + elapsedMs + '）',
      );
    } finally {
      stop = true;
      await reader;
    }
    assert.equal(bad, 0, 'reader saw partial JSON ' + bad + ' times');
    assert.ok(reads > 0);
  } finally {
    await box.cleanup();
  }
});

test('按执行端名合并选项：顶层同名项作为默认值', async () => {
  const box = await makeSandbox();
  try {
    await box.writeJson(path.join(box.home, 'config.json'), {
      model: 'top-model',
      reasoningEffort: 'low',
      env: { A: '1' },
      executors: { codex: { model: 'codex-model', env: { B: '2' } } },
    });
    const { config } = await loadConfig({ home: box.home, repoDir: null });
    const options = getExecutorOptions(config, 'codex');
    assert.deepEqual(options, {
      command: null,
      model: 'codex-model',
      reasoningEffort: 'low',
      env: { A: '1', B: '2' },
    });
    const other = getExecutorOptions(config, 'claude');
    assert.deepEqual(other, {
      command: null,
      model: 'top-model',
      reasoningEffort: 'low',
      env: { A: '1' },
    });
  } finally {
    await box.cleanup();
  }
});

test('mergeConfigs 对象递归合并、数组替换、null 覆盖', async () => {
  const merged = mergeConfigs(
    { a: { b: 1, c: 2 }, list: [1, 2], model: 'x' },
    { a: { b: 3 }, list: [9], model: null },
  );
  assert.deepEqual(merged, { a: { b: 3, c: 2 }, list: [9], model: null });
});
