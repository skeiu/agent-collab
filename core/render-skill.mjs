// 本文件：按设计端 host 片段和语言渲染 skill 模板；纯函数，构建和测试共用。渲染规则变化时更新。

const NAME_SOURCE = '[A-Za-z][A-Za-z0-9]*';
const NAME_RE = new RegExp('^' + NAME_SOURCE + '$');
const VARIABLE_LINE_RE = new RegExp('^(' + NAME_SOURCE + '): (.*)$');
const SLOT_LINE_RE = new RegExp('^<!-- slot: (' + NAME_SOURCE + ') -->$');
const PLACEHOLDER_RE = new RegExp('\\{\\{(var|slot)\\.(' + NAME_SOURCE + ')\\}\\}', 'g');

function renderError(message) {
  const error = new Error(message);
  error.code = 'render_error';
  return error;
}

function fail(message) {
  throw renderError(message);
}

function normalizeEol(text, label) {
  if (typeof text !== 'string') fail(label + '必须是字符串');
  return text.replace(/\r\n/g, '\n');
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === '\n') line += 1;
  }
  return line;
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

function parseHostDetailed(text) {
  const normalized = normalizeEol(text, 'host');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') fail('host 第 1 行：变量区必须以 --- 开始');

  const variables = Object.create(null);
  const variableLines = Object.create(null);
  let index = 1;
  let closed = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '---') {
      closed = true;
      index += 1;
      break;
    }
    if (line.trim() === '') fail('host 第 ' + (index + 1) + ' 行：变量区不能有空行');
    const match = VARIABLE_LINE_RE.exec(line);
    if (!match) fail('host 第 ' + (index + 1) + ' 行：变量区每行必须是“键: 值”');
    const [, name, value] = match;
    if (!NAME_RE.test(name)) fail('host 第 ' + (index + 1) + ' 行：变量键 ' + name + ' 不合法');
    if (hasOwn(variables, name)) fail('host 第 ' + (index + 1) + ' 行：变量键 ' + name + ' 重复');
    variables[name] = value;
    variableLines[name] = index + 1;
  }
  if (!closed) fail('host 第 1 行：变量区缺少结束行 ---');

  const slots = Object.create(null);
  const slotLines = Object.create(null);
  const currentLines = [];
  let currentName = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const slotMatch = SLOT_LINE_RE.exec(line);
    if (slotMatch) {
      if (currentName !== null) slots[currentName] = trimBlankLines(currentLines.splice(0));
      const name = slotMatch[1];
      if (hasOwn(slots, name)) fail('host 第 ' + (index + 1) + ' 行：槽名 ' + name + ' 重复');
      currentName = name;
      slotLines[name] = index + 1;
      continue;
    }
    if (line.trimStart().startsWith('<!-- slot:')) {
      fail('host 第 ' + (index + 1) + ' 行：槽标记必须恰好是 <!-- slot: 名称 -->');
    }
    if (currentName === null) {
      if (line.trim() !== '') fail('host 第 ' + (index + 1) + ' 行：变量区和第一个槽之间只能有空行');
      continue;
    }
    currentLines.push(line);
  }
  if (currentName !== null) slots[currentName] = trimBlankLines(currentLines);

  return { variables, variableLines, slots, slotLines };
}

/**
 * 解析 host 片段。返回 { variables, slots }，两者都是名称到字符串的对象。
 * 格式错误时抛出 code 为 render_error 的错误。
 */
export function parseHost(text) {
  const parsed = parseHostDetailed(text);
  return { variables: { ...parsed.variables }, slots: { ...parsed.slots } };
}

function analyzeTemplate(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') fail('模板第 1 行：开头缺少 frontmatter 的 ---');
  let closeLine = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      closeLine = index;
      break;
    }
  }
  if (closeLine < 0) fail('模板第 1 行：frontmatter 缺少结束行 ---');

  const tokens = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor);
    const strayClose = text.indexOf('}}', cursor);
    if (open === -1 && strayClose === -1) break;
    if (open === -1 || (strayClose !== -1 && strayClose < open)) {
      fail('模板第 ' + lineNumberAt(text, strayClose) + ' 行：出现没有开头的 }}');
    }
    const close = text.indexOf('}}', open + 2);
    const nextOpen = text.indexOf('{{', open + 2);
    if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
      fail('模板第 ' + lineNumberAt(text, open) + ' 行：占位符 {{ 缺少 }}');
    }
    const inner = text.slice(open + 2, close);
    const line = lineNumberAt(text, open);
    if (/[\n{}]/.test(inner)) fail('模板第 ' + line + ' 行：不支持的占位符形式 {{' + inner + '}}');
    const match = /^(var|slot)\.([A-Za-z][A-Za-z0-9]*)$/.exec(inner);
    if (!match) fail('模板第 ' + line + ' 行：不支持的占位符 {{' + inner + '}}');
    tokens.push({ kind: match[1], name: match[2], placeholder: '{{' + inner + '}}', line });
    cursor = close + 2;
  }

  return {
    tokens,
    frontText: lines.slice(0, closeLine + 1).join('\n'),
    bodyText: lines.slice(closeLine + 1).join('\n'),
  };
}

/**
 * 渲染 SKILL.md。只替换模板里的占位符一次；host 变量和槽的内容不会被再次扫描。
 */
export function renderSkill(options = {}) {
  const { template, host, hostName, lang = 'zh' } = options ?? {};
  if (lang !== 'zh') fail('lang 只支持 zh（收到 ' + String(lang) + '）');
  if (typeof hostName !== 'string' || hostName.length === 0) fail('hostName 必须是非空字符串');

  const templateText = normalizeEol(template, '模板');
  const hostText = normalizeEol(host, 'host');
  const parsed = analyzeTemplate(templateText);
  const hostParsed = parseHostDetailed(hostText);

  const usedVariables = new Set();
  const usedSlots = new Set();
  for (const token of parsed.tokens) {
    const used = token.kind === 'var' ? usedVariables : usedSlots;
    const available = token.kind === 'var' ? hostParsed.variables : hostParsed.slots;
    if (!hasOwn(available, token.name)) {
      fail('模板第 ' + token.line + ' 行：引用了 host 没有的' + (token.kind === 'var' ? '变量' : '槽') + ' ' + token.placeholder);
    }
    used.add(token.name);
  }
  for (const name of Object.keys(hostParsed.variables)) {
    if (!usedVariables.has(name)) {
      fail('host 第 ' + hostParsed.variableLines[name] + ' 行：变量 ' + name + ' 在模板里没有被用到');
    }
  }
  for (const name of Object.keys(hostParsed.slots)) {
    if (!usedSlots.has(name)) {
      fail('host 第 ' + hostParsed.slotLines[name] + ' 行：槽 ' + name + ' 在模板里没有被用到');
    }
  }

  const replace = (text) => text.replace(PLACEHOLDER_RE, (placeholder, kind, name) => {
    return kind === 'var' ? hostParsed.variables[name] : hostParsed.slots[name];
  });
  const comment = '<!-- 本文件由 core/render-skill.mjs 从 SKILL.template.md 和 hosts/' + hostName
    + '.md 生成，不要直接修改；改了模板后运行 npm run build。 -->';
  const front = replace(parsed.frontText);
  const body = replace(parsed.bodyText);
  let output = front + '\n' + comment + (body ? '\n' + body : '');
  output = output.replace(/\n+$/, '') + '\n';
  return output;
}
