#!/usr/bin/env bash
# 发布前泄漏自检:在任何待提交文件中出现以下内容即失败
#  - 真实手机号 / 密码(来自父项目,不得进入本仓库)
#  - JWT 形态的上游 token(eyJ 开头长串)
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "[leak-check] 手机号/密码..."
if git grep -nE '18687916605|qbt_wek' -- . ':!scripts/leak-check.sh' 2>/dev/null; then
  echo "  !! 发现真实凭证"; fail=1
fi

echo "[leak-check] JWT 形态 token..."
if git grep -nE 'eyJ[A-Za-z0-9_-]{20,}' -- . 2>/dev/null; then
  echo "  !! 发现疑似 token"; fail=1
fi

echo "[leak-check] 工作区未跟踪敏感文件..."
for f in .token proxy/.token token.cache; do
  [ -f "$f" ] && { echo "  !! 存在 $f"; fail=1; }
done

if [ "$fail" = "0" ]; then echo "[leak-check] PASS"; else echo "[leak-check] FAIL"; exit 1; fi
