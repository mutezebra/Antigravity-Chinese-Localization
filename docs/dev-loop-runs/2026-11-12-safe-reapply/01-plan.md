# 安全重装实现计划

目标：基于精确文件指纹，在升级后的原归档内替换兼容翻译文件。
架构：ASAR 解析与重写、兼容补丁与事务存储、macOS CLI 三层。Node.js 内置 fs/crypto/vm/child_process/node:test。

1. 写测试：合成 ASAR 夹具，验证版本保留、未知文件拒绝、外置资源保留、重复运行、事务回滚与跨版本恢复拒绝。先执行确认缺失实现导致失败。
2. safe-asar.js：严格检查 Pickle/JSON、文件路径、偏移、界限、外置及链接类型；修改文件后重算 integrity，按原树重写，验证所有文件字节。
3. safe-reapply.js：读取 patches/safe-reapply.json，核验 extracted 内现有汉化文件；所有目标须处于原版或全部汉化状态。备份归档与状态清单，用同目录临时文件重命名提交。恢复需目标版本、当前汉化指纹、原版指纹一致。
4. macos-reapply.js：默认 check，apply/restore 需要应用已退出；提供 --quit 以正常请求退出并轮询，--launch 仅在写入成功后打开应用。严格参数解析，子进程使用 execFile 参数数组，禁止 shell 拼接。
5. 双击脚本提供中文操作菜单，路径由自身定位，不依赖启动目录。README 给出使用与拒绝后处理方式。
6. 运行 node --test tests/safe-*.test.js；对真实安装只做 check；在副本做 apply/check/restore 并核验原包哈希恢复。内联做安全、兼容、需求审查，记录证据。
7. GitHub 登录成功后创建 fork、推送分支并向 fork 默认分支建 PR；不向上游直接提 PR。

评审：沿用本会话已确认的方案，内联审查，不派发子代理。必须拒绝未知或半汉化状态，禁止把缺失版本当兼容。已知签名和 UI 验证局限在文档中说明。
