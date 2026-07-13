#!/usr/bin/env node
'use strict';
// Command manifest gate: validate kit/core/command-manifest.yaml against the
// contract (field presence, unique ids/orders, entry files exist, no orphan
// command files, implementation_gate only on scaffold-gateway).
//
// Also exports a hand-written mini-YAML parser (controlled subset: nested
// mappings, lists of scalars/mappings, inline lists, plain scalars, comments).
// Unsupported YAML features fail loudly with file:line context.

const fs = require('fs');
const path = require('path');

const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = path.join(KIT_ROOT, 'kit', 'core', 'command-manifest.yaml');
const DEFAULT_COMMANDS_DIR = path.join(KIT_ROOT, 'kit', 'core', 'commands');
const GATE_ONLY_COMMAND = 'scaffold-gateway';

// ---------------------------------------------------------------------------
// mini-YAML parser (controlled subset)
// ---------------------------------------------------------------------------

function parseYaml(text, source) {
  const origin = source || '<yaml>';
  const items = [];
  const rawLines = String(text).split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (raw.trim() === '---') {
      if (items.length === 0) continue; // leading document marker is tolerated
      throw new Error(`${origin}:${i + 1}: 不支持多文档 YAML(第二个 --- 分隔符)`);
    }
    const leading = raw.slice(0, raw.length - raw.trimStart().length);
    if (leading.includes('\t')) {
      throw new Error(`${origin}:${i + 1}: 不支持 Tab 缩进,请改用空格`);
    }
    items.push({ indent: leading.length, text: raw.trim(), line: i + 1 });
  }
  let pos = 0;

  function fail(message, line) {
    throw new Error(`${origin}:${line}: ${message}`);
  }

  function rejectUnsupportedValue(value, line) {
    if (/^[|>]/.test(value)) fail('不支持块标量(| / >)', line);
    if (/^[&*]/.test(value)) fail('不支持锚点/别名(& / *)', line);
    if (/^\{/.test(value)) fail('不支持行内映射({...})', line);
  }

  function stripComment(value) {
    const v = value.trim();
    if (v.startsWith('"') || v.startsWith("'")) {
      const quote = v[0];
      const end = v.indexOf(quote, 1);
      if (end === -1) return v; // let unquote surface the problem
      return v.slice(0, end + 1);
    }
    const hash = v.search(/\s#/);
    return hash === -1 ? v : v.slice(0, hash).trim();
  }

  function parseScalar(value, line) {
    const v = value.trim();
    rejectUnsupportedValue(v, line);
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) fail('行内列表未闭合', line);
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map((part) => parseScalar(part, line));
    }
    if (v.startsWith('"') || v.startsWith("'")) {
      const quote = v[0];
      if (v.length < 2 || !v.endsWith(quote)) fail('引号未闭合', line);
      const body = v.slice(1, -1);
      return quote === '"' ? body.replace(/\\"/g, '"').replace(/\\n/g, '\n') : body;
    }
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    return v;
  }

  function parseBlock(minIndent) {
    if (pos >= items.length) return null;
    const first = items[pos];
    if (first.indent < minIndent) return null;
    if (first.text === '-' || first.text.startsWith('- ')) return parseList(first.indent);
    return parseMap(first.indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < items.length) {
      const item = items[pos];
      if (item.indent < indent) break;
      if (item.indent > indent) fail('意外缩进(与所在映射不对齐)', item.line);
      if (item.text === '-' || item.text.startsWith('- ')) break;
      const match = item.text.match(/^("(?:[^"]*)"|'(?:[^']*)'|[^:]+?)\s*:(?:\s+(.*))?$/);
      if (!match && !/:$/.test(item.text)) {
        fail(`无法解析为 "key: value":"${item.text}"`, item.line);
      }
      const key = match ? String(parseScalar(match[1], item.line)) : item.text.slice(0, -1).trim();
      if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`重复的 key: ${key}`, item.line);
      const rest = match && match[2] !== undefined ? stripComment(match[2]) : '';
      pos++;
      if (rest === '') {
        const child = pos < items.length && items[pos].indent > indent ? parseBlock(indent + 1) : null;
        obj[key] = child;
      } else {
        obj[key] = parseScalar(rest, item.line);
      }
    }
    return obj;
  }

  function parseList(indent) {
    const arr = [];
    while (pos < items.length) {
      const item = items[pos];
      if (item.indent < indent) break;
      if (item.indent > indent) fail('意外缩进(与所在列表不对齐)', item.line);
      if (!(item.text === '-' || item.text.startsWith('- '))) break;
      const inner = item.text === '-' ? '' : item.text.slice(2).trim();
      if (inner === '') {
        pos++;
        arr.push(pos < items.length && items[pos].indent > indent ? parseBlock(indent + 1) : null);
      } else if (/^("(?:[^"]*)"|'(?:[^']*)'|[^:]+?)\s*:(\s|$)/.test(inner)) {
        // list item opening a mapping: re-enter as a key line indented past the dash
        let mapIndent = indent + 2;
        const next = items[pos + 1];
        if (next && next.indent > indent && !(next.text === '-' || next.text.startsWith('- '))) {
          mapIndent = next.indent;
        }
        items[pos] = { indent: mapIndent, text: inner, line: item.line };
        arr.push(parseMap(mapIndent));
      } else {
        pos++;
        arr.push(parseScalar(stripComment(inner), item.line));
      }
    }
    return arr;
  }

  const doc = parseBlock(0);
  if (pos < items.length) fail(`存在未消费的内容:"${items[pos].text}"`, items[pos].line);
  return doc;
}

// ---------------------------------------------------------------------------
// manifest loading & validation
// ---------------------------------------------------------------------------

function loadCommandManifest(manifestPath) {
  const text = fs.readFileSync(manifestPath, 'utf8');
  const doc = parseYaml(text, manifestPath);
  let commands;
  if (Array.isArray(doc)) commands = doc;
  else if (doc && Array.isArray(doc.commands)) commands = doc.commands;
  else throw new Error(`${manifestPath}: 顶层应为命令列表或包含 commands 列表的映射`);
  return { commands, raw: doc };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a command manifest. Returns an array of error strings (empty = OK).
 */
function validateManifest(options) {
  const manifestPath = options.manifestPath;
  const commandsDir = options.commandsDir;
  const errors = [];

  if (!fs.existsSync(manifestPath)) {
    errors.push(`manifest 不存在: ${manifestPath}`);
    return errors;
  }
  if (!fs.existsSync(commandsDir)) {
    errors.push(`commands 目录不存在: ${commandsDir}`);
    return errors;
  }

  let manifest;
  try {
    manifest = loadCommandManifest(manifestPath);
  } catch (err) {
    errors.push(`manifest 解析失败: ${err.message}`);
    return errors;
  }

  const commands = manifest.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    errors.push('manifest 命令列表为空');
    return errors;
  }

  const seenIds = new Set();
  const seenOrders = new Set();
  const referencedFiles = new Set();

  commands.forEach((command, index) => {
    const label = command && isNonEmptyString(command.id) ? command.id : `#${index}`;
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      errors.push(`命令 ${label}: 应为映射对象`);
      return;
    }
    // id
    if (!isNonEmptyString(command.id)) {
      errors.push(`命令 ${label}: 缺少必填字段 id`);
    } else if (!/^[a-z][a-z0-9-]*$/.test(command.id)) {
      errors.push(`命令 ${label}: id 只允许小写字母/数字/连字符`);
    } else if (seenIds.has(command.id)) {
      errors.push(`命令 ${label}: id 重复(duplicate id)`);
    } else {
      seenIds.add(command.id);
    }
    // title / summary
    if (!isNonEmptyString(command.title)) errors.push(`命令 ${label}: 缺少必填字段 title`);
    if (!isNonEmptyString(command.summary)) errors.push(`命令 ${label}: 缺少必填字段 summary`);
    // entry
    if (!isNonEmptyString(command.entry)) {
      errors.push(`命令 ${label}: 缺少必填字段 entry`);
    } else if (isNonEmptyString(command.id)) {
      const expectedSuffix = `commands/${command.id}.md`;
      if (!command.entry.replace(/\\/g, '/').endsWith(expectedSuffix)) {
        errors.push(`命令 ${label}: entry 应指向 commands/${command.id}.md,实际为 ${command.entry}`);
      }
      const entryFile = path.join(commandsDir, `${command.id}.md`);
      referencedFiles.add(`${command.id}.md`);
      if (!fs.existsSync(entryFile)) {
        errors.push(`命令 ${label}: entry 文件不存在: ${entryFile}`);
      }
    }
    // order
    if (typeof command.order !== 'number' || !Number.isInteger(command.order) || command.order < 0) {
      errors.push(`命令 ${label}: order 必须是 >=0 的整数`);
    } else if (seenOrders.has(command.order)) {
      errors.push(`命令 ${label}: order 重复(${command.order})`);
    } else {
      seenOrders.add(command.order);
    }
    // outputs (required, may be empty list)
    if (!Array.isArray(command.outputs)) {
      errors.push(`命令 ${label}: outputs 必须是列表(可为空列表)`);
    }
    // requires (optional list)
    if (command.requires !== undefined && command.requires !== null && !Array.isArray(command.requires)) {
      errors.push(`命令 ${label}: requires 若提供必须是列表`);
    }
    // implementation_gate (optional bool; true only on scaffold-gateway)
    const gate = command.implementation_gate;
    if (gate !== undefined && gate !== null && typeof gate !== 'boolean') {
      errors.push(`命令 ${label}: implementation_gate 必须是布尔值`);
    }
    if (gate === true && command.id !== GATE_ONLY_COMMAND) {
      errors.push(`命令 ${label}: implementation_gate: true 只允许出现在 ${GATE_ONLY_COMMAND}`);
    }
    // argument_hint (optional string)
    if (command.argument_hint !== undefined && command.argument_hint !== null && typeof command.argument_hint !== 'string') {
      errors.push(`命令 ${label}: argument_hint 若提供必须是字符串`);
    }
  });

  // orphan command files
  let actualFiles = [];
  try {
    actualFiles = fs.readdirSync(commandsDir).filter((name) => name.endsWith('.md'));
  } catch (err) {
    errors.push(`读取 commands 目录失败: ${err.message}`);
  }
  for (const name of actualFiles) {
    if (!referencedFiles.has(name)) {
      errors.push(`孤儿命令文件(manifest 未登记): commands/${name}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const manifestPath = DEFAULT_MANIFEST;
  const commandsDir = DEFAULT_COMMANDS_DIR;
  if (!fs.existsSync(manifestPath)) {
    console.error(`check-manifest: FAIL,${path.relative(KIT_ROOT, manifestPath)} 不存在`);
    console.error('  提示:kit/core 由 core 内容构建步骤产出,可能尚未就绪。');
    process.exit(1);
  }
  const errors = validateManifest({ manifestPath, commandsDir });
  if (errors.length > 0) {
    console.error(`check-manifest: FAIL(${errors.length} 个问题):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const manifest = loadCommandManifest(manifestPath);
  console.log(`check-manifest: PASS(${manifest.commands.length} 条命令,结构与 entry 文件全部合规)`);
}

if (require.main === module) {
  main();
}

module.exports = { parseYaml, loadCommandManifest, validateManifest };
