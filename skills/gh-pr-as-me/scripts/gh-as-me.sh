#!/usr/bin/env bash
# 用 Dzh97(本人) 身份跑 gh —— 这台机器 gh 默认 active 账号是 colna，
# gh 不按目录切身份，所以从 dingzhihao/.git-credentials 里取本人 token 注入 GH_TOKEN。
# 用法：gh-as-me.sh <任意 gh 子命令和参数>
#   gh-as-me.sh pr create --base release/test --head my-branch --title "..." --body "..."
#   gh-as-me.sh pr close 1811
#   gh-as-me.sh pr view 1812 --json author
set -euo pipefail

CRED="/Users/a0000/Dev/dingzhihao/.git-credentials"
TK=$(sed -nE 's#^https://dzh97:([^@]+)@github\.com.*#\1#p' "$CRED" | head -1)
if [ -z "${TK:-}" ]; then
  echo "错误：未从 $CRED 提取到 dzh97 的 token。检查该文件是否存在、格式是否为 https://dzh97:<token>@github.com" >&2
  exit 1
fi

GH_TOKEN="$TK" gh "$@"
