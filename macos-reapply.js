#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inspect, apply, restore } = require('./safe-reapply');
function parseArgs(args) {
  const result = { action: 'check', app: '/Applications/Antigravity.app', quit: false, launch: false };
  if (args[0] && !args[0].startsWith('--')) result.action = args.shift();
  if (!['check', 'apply', 'restore'].includes(result.action)) throw new Error('操作只能是 check、apply 或 restore');
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--quit') result.quit = true;
    else if (key === '--launch') result.launch = true;
    else if (key === '--app' || key === '--state-dir') {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${key} 缺少路径`);
      result[key === '--app' ? 'app' : 'stateDir'] = path.resolve(value);
    } else throw new Error(`未知参数：${key}`);
  }
  if (result.action === 'check' && (result.quit || result.launch)) throw new Error('check 不允许退出或启动应用');
  return result;
}
function running(app, readProcesses = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) {
  const prefix = path.resolve(app) + '/Contents/';
  return readProcesses().split('\n').some(line => line.trim().replace(/^\d+\s+/, '').startsWith(prefix));
}
async function requestQuit(app) {
  // Pass the application path as argv; it never becomes AppleScript source.
  const script = 'on run argv\n tell application (item 1 of argv) to quit\nend run';
  execFileSync('/usr/bin/osascript', ['-e', script, path.resolve(app)], { stdio: 'inherit', timeout: 30000 });
  for (let i = 0; i < 30; i++) {
    if (!running(app)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('应用尚未退出；请保存工作并手动退出后重试。本工具不会强杀进程。');
}
// Electron fuse V1 index 4 controls embedded ASAR validation. Refuse unknown
// layouts and enabled validation rather than weakening the application's policy.
function validateFuseWire(binary) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  let start = 0; let found = false;
  while (true) {
    const index = binary.indexOf(sentinel, start); if (index < 0) break;
    found = true; const wire = index + sentinel.length;
    if (binary[wire] !== 1 || binary[wire + 1] < 5 || wire + 2 + binary[wire + 1] > binary.length) throw new Error('无法确认 Electron fuse 格式');
    if (binary[wire + 6] !== 48) throw new Error('应用启用了 ASAR 完整性保护或状态未知，停止汉化');
    start = wire + 2 + binary[wire + 1];
  }
  if (!found) throw new Error('无法确认 Electron 完整性保护状态');
}
function validateMacApp(app, version) {
  const plist = path.join(app, 'Contents', 'Info.plist');
  const installed = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  if (installed !== version) throw new Error('应用版本与 ASAR 版本不一致，停止汉化');
  const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
  validateFuseWire(fs.readFileSync(framework));
}
async function main(args) {
  if (process.platform !== 'darwin') throw new Error('该入口目前仅支持 macOS');
  const parsed = parseArgs(args);
  const options = { ...parsed,
    stateDir: parsed.stateDir || path.join(os.homedir(), 'Library', 'Application Support', 'antigravity-chinese-localization'),
    bundle: JSON.parse(fs.readFileSync(path.join(__dirname, 'patches', 'safe-reapply.json'), 'utf8')),
    payload: path.join(__dirname, 'extracted'), isRunning: () => running(parsed.app) };
  // Check compatibility before asking a running application to quit.
  if (parsed.action !== 'restore') {
    const result = inspect(options);
    const labels = { compatible: '兼容，可以重新汉化', localized: '已经汉化，无需重复安装', incompatible: '不兼容，未修改应用' };
    console.log(`Antigravity ${result.version}：${labels[result.status]}`);
    if (result.conflicts.length) console.log('变化文件：\n' + result.conflicts.join('\n'));
    if (result.status === 'incompatible') { process.exitCode = 2; return; }
    if (result.status === 'localized') return;
    validateMacApp(parsed.app, result.version);
    if (parsed.action === 'check') return;
  }
  if (options.isRunning() && parsed.quit) await requestQuit(parsed.app);
  const result = await (parsed.action === 'restore' ? restore(options) : apply(options));
  console.log(result.status === 'restored' ? '原版已恢复。' : result.status === 'applied' ? '汉化已安装。' : '文件未变化。');
  if (result.backup) console.log(`原版备份：${result.backup}`);
  if (parsed.launch && result.status !== 'unchanged') execFileSync('/usr/bin/open', ['-a', parsed.app], { stdio: 'inherit' });
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(`停止：${error.message}`); process.exitCode = 1; });
module.exports = { parseArgs, running, validateFuseWire, main };
