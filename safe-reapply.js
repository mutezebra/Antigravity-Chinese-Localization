'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { readArchive, rewriteArchive, hash, validPath, MAX_ARCHIVE } = require('./safe-asar');

function noLinks(file) {
  let current = path.resolve(file);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`不允许符号链接：${current}`);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function readFile(file, max = MAX_ARCHIVE) {
  noLinks(file); const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > max) throw new Error(`不是有效普通文件：${file}`);
  return fs.readFileSync(file);
}
function locations(options) {
  const app = path.resolve(options.app);
  if (!app.endsWith('.app')) throw new Error('目标必须为 .app 应用目录');
  const target = path.join(app, 'Contents', 'Resources', 'app.asar'); noLinks(target);
  const state = path.join(path.resolve(options.stateDir), hash(app).slice(0, 24));
  if (state.startsWith(app + path.sep)) throw new Error('备份目录必须位于应用外');
  return { app, target, state };
}
function inspect(options) {
  const { target } = locations(options);
  const bytes = readFile(target); const archive = readArchive(bytes);
  const bundle = options.bundle;
  if (!bundle || typeof bundle.id !== 'string' || !Array.isArray(bundle.files) || !bundle.files.length) throw new Error('补丁清单无效');
  const replacements = new Map(); let originals = 0; let patched = 0; const conflicts = [];
  for (const f of bundle.files) {
    if (!validPath(f.path) || replacements.has(f.path) || !/^[a-f0-9]{64}$/.test(f.original) ||
        !/^[a-f0-9]{64}$/.test(f.patched) || f.original === f.patched) throw new Error('补丁清单路径或哈希无效');
    const data = readFile(path.join(options.payload, f.path));
    if (hash(data) !== f.patched) throw new Error(`补丁文件校验失败：${f.path}`);
    if (f.path.endsWith('.js')) new vm.Script(data.toString('utf8'), { filename: f.path });
    replacements.set(f.path, data);
    const entry = archive.entries.get(f.path);
    if (!entry || entry.unpacked) { conflicts.push(f.path); continue; }
    const current = hash(archive.data(f.path));
    if (current === f.original) originals++;
    else if (current === f.patched) patched++;
    else conflicts.push(f.path);
  }
  for (const [name, entry] of archive.entries) {
    if (!entry.unpacked) continue;
    try {
      const external = readFile(path.join(target + '.unpacked', name));
      if (external.length !== entry.size || (entry.integrity && hash(external) !== entry.integrity.hash)) throw new Error('大小或哈希不符');
    } catch (e) { throw new Error(`外置资源异常：${name} (${e.message})`); }
  }
  const status = conflicts.length || (originals && patched) ? 'incompatible' : patched ? 'localized' : 'compatible';
  return { status, version: archive.version, conflicts, hash: hash(bytes), archive, replacements };
}
function requireStopped(options) {
  if (typeof options.isRunning !== 'function') throw new Error('缺少进程检查，停止写入');
  if (options.isRunning()) throw new Error('请先退出 Antigravity，再重试');
}
function locked(options, fn) {
  const loc = locations(options); noLinks(loc.state); fs.mkdirSync(loc.state, { recursive: true, mode: 0o700 });
  const lock = path.join(loc.state, 'lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Error('另一个操作正在执行，或上次中断遗留 lock；请核实后再移除'); throw e; }
  try { return fn(loc); } finally { fs.rmdirSync(lock); }
}
function saveJSON(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
// Stage next to the target so rename is atomic. Recheck the application and
// original fingerprint immediately before committing; never overwrite an update.
function commit(options, target, expected, bytes) {
  const stage = path.join(path.dirname(target), '.app.asar.zh-' + crypto.randomUUID() + '.stage');
  try {
    fs.writeFileSync(stage, bytes, { flag: 'wx', mode: fs.statSync(target).mode & 0o777 });
    const fd = fs.openSync(stage, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (hash(readFile(stage)) !== hash(bytes)) throw new Error('暂存文件校验失败');
    requireStopped(options);
    if (hash(readFile(target)) !== expected) throw new Error('安装文件已变化，停止覆盖');
    fs.renameSync(stage, target);
  } finally { if (fs.existsSync(stage)) fs.unlinkSync(stage); }
}
async function apply(options) {
  return locked(options, ({ target, state }) => {
    const current = inspect(options);
    if (current.status === 'localized') return { status: 'unchanged', version: current.version };
    if (current.status !== 'compatible') throw new Error(`补丁不兼容，未修改应用：${current.conflicts.join(', ') || '检测到混合汉化状态'}`);
    requireStopped(options);
    const output = rewriteArchive(current.archive, current.replacements);
    const backup = path.join(state, current.hash + '.asar');
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, current.archive.bytes, { flag: 'wx', mode: 0o600 });
    if (hash(readFile(backup)) !== current.hash) throw new Error('原版备份校验失败');
    const record = { format: 1, version: current.version, target, original: current.hash, patched: hash(output), bundle: options.bundle.id };
    // Persist recovery metadata before replacing the app. Interrupted installs
    // leave a usable backup; restore still requires the recorded patched hash.
    saveJSON(path.join(state, 'current.json'), record);
    commit(options, target, current.hash, output);
    return { status: 'applied', version: current.version, backup };
  });
}
async function restore(options) {
  return locked(options, ({ target, state }) => {
    let record;
    try { record = JSON.parse(readFile(path.join(state, 'current.json'), 16384)); }
    catch (_) { throw new Error('没有本工具的有效备份记录，不能自动恢复'); }
    if (record.format !== 1 || record.target !== target || !/^[a-f0-9]{64}$/.test(record.original) || !/^[a-f0-9]{64}$/.test(record.patched)) throw new Error('备份记录无效');
    const bytes = readFile(target); const current = readArchive(bytes);
    if (current.version !== record.version) throw new Error('版本不匹配，不能跨版本还原');
    if (hash(bytes) === record.original) return { status: 'unchanged', version: current.version };
    if (hash(bytes) !== record.patched) throw new Error('当前安装与备份记录不匹配，停止恢复');
    const original = readFile(path.join(state, record.original + '.asar'));
    if (hash(original) !== record.original || readArchive(original).version !== record.version) throw new Error('备份校验失败');
    requireStopped(options); commit(options, target, record.patched, original);
    return { status: 'restored', version: current.version };
  });
}
module.exports = { inspect, apply, restore };
