# 实现记录

基线：b39779adc8fd40004888885b2fe0006d5f6b94a0。开发分支：feat/macos-safe-reapply。

1. 先增加 ASAR 与安装测试，缺少模块时失败；实现后发现测试临时目录经由 macOS /var 符号链接，测试夹具改用真实路径，保留生产代码拒绝链接的规则。
2. 实现 safe-asar.js：读取并验证归档、完整性记录，重写时只替换清单内文件，保留其他文件与元数据。
3. 实现 safe-reapply.js：指纹检测、语法校验、外置资源检查、备份、原子替换、恢复与锁。通过提交前更新冲突测试。
4. macos-reapply.js 与 macOS安全汉化.command 提供中文检查、安装、恢复。使用进程参数数组，默认不写入；正常退出可选，不强杀。
5. 增加 Electron fuse 拒绝测试，观察失败后实现保护状态检测；不修改系统安全策略。
6. 新测试 18 项通过；真实 2.31.2 原始归档副本完成 apply/重复 apply/restore，原包 SHA-256 完全恢复。真实应用仅 check，报告已汉化。
7. 默认上游测试首次运行被 macOS /var 临时路径的符号链接影响，原有 asar-version 用例失败，安装测试未结束。停止本次测试进程后改用明确的真实 TMPDIR 重跑，整个默认测试入口通过。未修改这些旧测试或生产逻辑。

检查命令：
- node --test tests/safe-reapply.test.js tests/safe-cli.test.js
- node --check safe-asar.js / safe-reapply.js / macos-reapply.js（分别执行）
- bash -n macOS安全汉化.command
- node macos-reapply.js check
- TMPDIR=<真实临时目录> node tests/run-all-tests.js
- git diff --check
