#!/bin/bash
# Locate the checkout even when Finder launches this command from another directory.
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo '需要 Node.js 18 或更新版本，请先安装后重试。'
  read -r -p '按回车关闭…' _
  exit 1
fi
printf '\nAntigravity 安全汉化\n1. 检查兼容性（不修改应用）\n2. 升级后重新汉化\n3. 恢复本工具备份的英文原版\n'
read -r -p '请选择 [1/2/3]，直接回车仅检查：' choice
case "$choice" in
  ''|1) node macos-reapply.js check ;;
  2|3)
    echo '请先保存工作；接下来会请求正常退出 Antigravity，完成后重新打开。'
    read -r -p '输入 y 继续：' answer
    if [ "$answer" = y ] || [ "$answer" = Y ]; then
      if [ "$choice" = 2 ]; then action=apply; else action=restore; fi
      node macos-reapply.js "$action" --quit --launch
    fi
    ;;
  *) echo '未执行任何操作。' ;;
esac
result=$?
read -r -p '按回车关闭…' _
exit "$result"
