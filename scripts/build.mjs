// 本文件：仓库构建入口。定位仓库根目录，逐项执行构建步骤；第 0 阶段只有骨架，不产出文件。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录：本文件位于 <仓库>/scripts/，因此上跳一层。 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 构建步骤清单。第 0 阶段全部未实现，只报告；后续阶段按 PLAN.md §7.1 逐项补上。
 * output 为相对仓库根目录的产物位置。
 */
const steps = [
  {
    name: '生成 SKILL.md',
    output: 'skills/collab/SKILL.md',
    note: '由 SKILL.template.md 与 hosts/<设计端>.md 渲染（core/render-skill.mjs，PLAN.md §7.1）',
  },
  {
    name: '打包桥接 .tgz',
    output: 'dist/（dsh-bridge 打包成 .tgz）',
    note: 'dsh Web 插件随运行时分发（PLAN.md §9、§14）',
  },
  {
    name: '组装运行时',
    output: 'dist/（core/ 的运行时副本）',
    note: '供安装时复制到 ~/.agent-collab/runtime/<版本>/（PLAN.md §7.2）',
  },
];

function main() {
  console.log(`仓库根目录：${repoRoot}`);
  console.log(`构建步骤：共 ${steps.length} 项，第 0 阶段均未实现。`);
  for (const step of steps) {
    console.log(`- 尚未实现：${step.name}`);
    console.log(`    产物：${step.output}`);
    console.log(`    说明：${step.note}`);
  }
  console.log('构建结束：未产出任何文件。');
}

main();
