'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, running } = require('../macos-reapply');
test('默认只读检查与参数', () => { assert.equal(parseArgs([]).action, 'check'); assert.equal(parseArgs(['apply', '--quit', '--launch']).quit, true); });
test('拒绝拼写错误及无效组合', () => { for (const args of [['--now'], ['apply', '--app'], ['check', '--quit'], ['restore','--launch','--bad']]) assert.throws(() => parseArgs(args)); });
test('进程检查匹配应用完整路径且失败即停止', () => {
  assert.equal(running('/Applications/Antigravity.app', () => '10 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n'), true);
  assert.equal(running('/Applications/Antigravity.app', () => '10 /Applications/Other.app/Contents/MacOS/App\n'), false);
  assert.throws(() => running('/Applications/Antigravity.app', () => { throw Error('ps failed'); }));
});
test('未知或开启 ASAR 校验的 Electron 拒绝补丁', () => {
  const { validateFuseWire } = require('../macos-reapply');
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const wire = flags => Buffer.concat([sentinel, Buffer.from([1, flags.length]), Buffer.from(flags)]);
  assert.doesNotThrow(() => validateFuseWire(wire('101100011')));
  assert.throws(() => validateFuseWire(wire('101110011')), /完整性/);
  assert.throws(() => validateFuseWire(Buffer.from('unknown')), /无法/);
});
