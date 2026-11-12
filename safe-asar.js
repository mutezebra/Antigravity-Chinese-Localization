'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_ARCHIVE = 128 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
function invalid(message) { throw new Error(`无效 ASAR：${message}`); }
function validPath(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') &&
    !/[\x00-\x1f]/.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..');
}

// Keep the original entry tree, including unpacked flags and executable bits.
// Only packed file offsets and content integrity records are regenerated.
function readArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_ARCHIVE) invalid('文件大小');
  const headerSize = bytes.readUInt32LE(4);
  const jsonSize = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 4 * 1024 * 1024 ||
      headerSize + 8 > bytes.length || headerSize % 4 || bytes.readUInt32LE(8) !== headerSize - 4 ||
      !jsonSize || 8 + Math.ceil(jsonSize / 4) * 4 !== headerSize) invalid('头部边界');
  let tree;
  try { tree = JSON.parse(utf8.decode(bytes.subarray(16, 16 + jsonSize))); }
  catch (_) { invalid('头部 JSON'); }
  const entries = new Map(); const ranges = [];
  function walk(node, prefix = '', depth = 0) {
    if (!node || typeof node !== 'object' || !node.files || typeof node.files !== 'object' ||
        Array.isArray(node.files) || depth > 64) invalid('目录结构');
    for (const [key, entry] of Object.entries(node.files)) {
      const name = prefix + key;
      if (!validPath(key) || key.includes('/') || !entry || typeof entry !== 'object') invalid('条目路径');
      if (entry.files) { walk(entry, name + '/', depth + 1); continue; }
      if (entry.link !== undefined) invalid('暂不支持归档内链接');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 ||
          (entry.unpacked !== undefined && typeof entry.unpacked !== 'boolean')) invalid('条目大小');
      if (!entry.unpacked) {
        if (typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset)) invalid('文件偏移');
        const offset = Number(entry.offset); const start = 8 + headerSize + offset;
        if (!Number.isSafeInteger(start) || offset < 0 || start > bytes.length || entry.size > bytes.length - start) invalid('文件边界');
        if (entry.size) ranges.push([start, start + entry.size]);
      }
      entries.set(name, entry);
    }
  }
  walk(tree);
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) invalid('内容重叠');
  function data(name) {
    const e = entries.get(name);
    if (!e || e.unpacked) invalid(`缺少内置文件 ${name}`);
    const start = 8 + headerSize + Number(e.offset);
    return bytes.subarray(start, start + e.size);
  }
  let pkg;
  try { pkg = JSON.parse(utf8.decode(data('package.json'))); } catch (_) { invalid('版本元数据'); }
  if (pkg.name !== 'antigravity' || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) invalid('程序名称或版本');
  for (const [name, e] of entries) {
    if (e.unpacked || !e.integrity) continue;
    const { algorithm, blockSize, blocks, hash: expected } = e.integrity;
    if (algorithm !== 'SHA256' || !Number.isSafeInteger(blockSize) || blockSize < 1 || !Array.isArray(blocks)) invalid('完整性格式');
    const content = data(name);
    const expectedCount = Math.max(1, Math.ceil(content.length / blockSize));
    if (hash(content) !== expected || blocks.length !== expectedCount) invalid(`完整性校验 ${name}`);
    for (let i = 0; i < blocks.length; i++) if (hash(content.subarray(i * blockSize, (i + 1) * blockSize)) !== blocks[i]) invalid(`分块校验 ${name}`);
  }
  return { bytes, tree, entries, data, version: pkg.version };
}

function rewriteArchive(archive, replacements) {
  const tree = JSON.parse(JSON.stringify(archive.tree)); const chunks = []; let offset = 0;
  for (const name of replacements.keys()) if (!archive.entries.has(name) || archive.entries.get(name).unpacked) invalid(`替换目标 ${name}`);
  function walk(node, prefix = '') {
    for (const [key, e] of Object.entries(node.files)) {
      const name = prefix + key;
      if (e.files) { walk(e, name + '/'); continue; }
      if (e.unpacked) continue;
      const data = replacements.get(name) || archive.data(name);
      e.offset = String(offset); e.size = data.length; offset += data.length; chunks.push(data);
      if (e.integrity) {
        const blockSize = e.integrity.blockSize; const blocks = [];
        for (let i = 0; i < Math.max(1, data.length); i += blockSize) blocks.push(hash(data.subarray(i, i + blockSize)));
        e.integrity = { algorithm: 'SHA256', hash: hash(data), blockSize, blocks };
      }
    }
  }
  walk(tree);
  const json = Buffer.from(JSON.stringify(tree)); const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4); prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8); prefix.writeUInt32LE(json.length, 12);
  const result = Buffer.concat([prefix, json, Buffer.alloc(padded - json.length), ...chunks]);
  const check = readArchive(result);
  for (const [name, e] of archive.entries) {
    if (!e.unpacked && !check.data(name).equals(replacements.get(name) || archive.data(name))) invalid(`重打包校验 ${name}`);
  }
  if (check.version !== archive.version) invalid('版本被改变');
  return result;
}
module.exports = { readArchive, rewriteArchive, hash, validPath, MAX_ARCHIVE };
