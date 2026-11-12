'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readArchive, rewriteArchive } = require('../safe-asar');
const { inspect, apply, restore } = require('../safe-reapply');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function archive(version = '2.31.2', code = 'original', extra = 'keep') {
  const contents = { 'package.json': JSON.stringify({ name: 'antigravity', version }), 'main.js': code, 'other.js': extra };
  const files = {}; let offset = 0; const chunks = [];
  for (const [name, value] of Object.entries(contents)) { const b = Buffer.from(value); files[name] = { size: b.length, offset: String(offset) }; chunks.push(b); offset += b.length; }
  files['external.txt'] = { size: 3, unpacked: true };
  const json = Buffer.from(JSON.stringify({ files })); const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4); prefix.writeUInt32LE(8 + padded, 4); prefix.writeUInt32LE(4 + padded, 8); prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padded - json.length), ...chunks]);
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'safe-reapply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'Antigravity.app'); const resources = path.join(app, 'Contents', 'Resources'); fs.mkdirSync(resources, { recursive: true });
  const target = path.join(resources, 'app.asar'); fs.writeFileSync(target, archive()); fs.mkdirSync(target + '.unpacked'); fs.writeFileSync(path.join(target + '.unpacked', 'external.txt'), 'ext');
  const payload = path.join(dir, 'payload'); fs.mkdirSync(payload); fs.writeFileSync(path.join(payload, 'main.js'), 'translated');
  const bundle = { id: 'test', files: [{ path: 'main.js', original: hash('original'), patched: hash('translated') }] };
  return { app, target, bundle, payload, stateDir: path.join(dir, 'state'), isRunning: () => false };
}
test('ASAR 重写保留版本、其他文件和外置标记', () => {
  const before = readArchive(archive()); const result = readArchive(rewriteArchive(before, new Map([['main.js', Buffer.from('translated')]])));
  assert.equal(result.version, '2.31.2'); assert.equal(result.data('other.js').toString(), 'keep'); assert.equal(result.entries.get('external.txt').unpacked, true);
});
test('损坏归档拒绝', () => { assert.throws(() => readArchive(Buffer.from('bad'))); });
test('兼容升级应用、重复无操作、逐字节还原', async t => {
  const f = fixture(t); const original = fs.readFileSync(f.target); assert.equal(inspect(f).status, 'compatible');
  assert.equal((await apply(f)).status, 'applied'); assert.equal(inspect(f).status, 'localized');
  assert.equal((await apply(f)).status, 'unchanged'); assert.equal((await restore(f)).status, 'restored'); assert.deepEqual(fs.readFileSync(f.target), original);
});
test('未知文件不写入、不建立备份', async t => {
  const f = fixture(t); fs.writeFileSync(f.target, archive('2.32.0', 'changed')); const original = fs.readFileSync(f.target);
  await assert.rejects(apply(f), /不兼容/); assert.deepEqual(fs.readFileSync(f.target), original);
});
test('运行中拒绝写入', async t => { const f = fixture(t); f.isRunning = () => true; await assert.rejects(apply(f), /退出/); });
test('补丁被修改拒绝', async t => { const f = fixture(t); fs.writeFileSync(path.join(f.payload, 'main.js'), 'unexpected'); await assert.rejects(apply(f), /补丁/); });
test('跨版本还原拒绝', async t => { const f = fixture(t); await apply(f); fs.writeFileSync(f.target, archive('2.32.0', 'translated')); await assert.rejects(restore(f), /匹配|版本/); });
test('缺失外置资源拒绝', async t => { const f = fixture(t); fs.unlinkSync(path.join(f.target + '.unpacked', 'external.txt')); await assert.rejects(apply(f), /外置/); });
test('目标符号链接拒绝', async t => { const f = fixture(t); fs.renameSync(f.target, f.target + '.real'); fs.symlinkSync(f.target + '.real', f.target); await assert.rejects(apply(f), /链接/); });
test('备份损坏后拒绝恢复', async t => { const f = fixture(t); const r = await apply(f); fs.writeFileSync(r.backup, 'bad'); await assert.rejects(restore(f), /备份/); });
module.exports = { archive, fixture };
test('提交前更新发生变化则保留更新', async t => {
  const f = fixture(t); let checks = 0;
  f.isRunning = () => { if (++checks === 2) fs.writeFileSync(f.target, archive('2.32.0', 'new')); return false; };
  await assert.rejects(apply(f), /变化/); assert.equal(readArchive(fs.readFileSync(f.target)).version, '2.32.0');
});
test('部分汉化混合状态拒绝', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.payload, 'other.js'), 'changedOther');
  f.bundle.files.push({ path: 'other.js', original: hash('keep'), patched: hash('changedOther') });
  fs.writeFileSync(f.target, archive('2.31.2', 'translated')); await assert.rejects(apply(f), /混合/);
});
test('锁存在不写入', async t => {
  const f = fixture(t); const lock = path.join(f.stateDir, hash(path.resolve(f.app)).slice(0,24), 'lock'); fs.mkdirSync(lock, { recursive: true });
  await assert.rejects(apply(f), /操作|lock/);
});
test('清单目录穿越拒绝', async t => { const f = fixture(t); f.bundle.files[0].path = '../main.js'; await assert.rejects(apply(f), /路径/); });
