#!/usr/bin/env bash
# 通过硅云服务器临时 SOCKS5 隧道推送 GitHub（适用于 HTTPS 远程）。
# 用法：
#   git cloudpush                # 推当前分支到 origin
#   git cloudpush origin main --force-with-lease
# 可用环境变量覆盖：
#   CLOUD_SSH_HOST    默认 103.151.217.28
#   CLOUD_PROXY_PORT  默认 1080
# 注意：服务器密码不写进本文件，连接时按提示输入（或走本机 ~/.ssh/config）。
set -euo pipefail

SSH_HOST="${CLOUD_SSH_HOST:-103.151.217.28}"
PROXY_PORT="${CLOUD_PROXY_PORT:-1080}"
PROXY_URL="socks5h://127.0.0.1:${PROXY_PORT}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[cloudpush] 请在 git 仓库内运行" >&2
  exit 1
}
cd "$repo_root"

OLD_HTTP_PROXY="$(git config --local --get http.proxy 2>/dev/null || true)"
OLD_HTTPS_PROXY="$(git config --local --get https.proxy 2>/dev/null || true)"
STARTED_TUNNEL=0

port_listening() {
  netstat -ano 2>/dev/null | awk -v port="$PROXY_PORT" '
    BEGIN { re = ":" port "$" }
    $2 ~ re && $4 == "LISTENING" { found = 1 }
    END { exit !found }
  '
}

cleanup() {
  if [ -n "$OLD_HTTP_PROXY" ]; then
    git config --local http.proxy "$OLD_HTTP_PROXY" 2>/dev/null || true
  else
    git config --local --unset http.proxy 2>/dev/null || true
  fi
  if [ -n "$OLD_HTTPS_PROXY" ]; then
    git config --local https.proxy "$OLD_HTTPS_PROXY" 2>/dev/null || true
  else
    git config --local --unset https.proxy 2>/dev/null || true
  fi

  if [ "$STARTED_TUNNEL" = "1" ]; then
    pid="$(netstat -ano 2>/dev/null | awk -v port="$PROXY_PORT" '
      BEGIN { re = ":" port "$" }
      $2 ~ re && $4 == "LISTENING" { print $5; exit }
    ')"
    if [ -n "$pid" ]; then
      taskkill //PID "$pid" //F >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

if port_listening; then
  echo "[cloudpush] 复用已有隧道 127.0.0.1:${PROXY_PORT}"
else
  echo "[cloudpush] 启动 SSH 隧道 ${SSH_HOST} -> 127.0.0.1:${PROXY_PORT}"
  ssh -f -N -D "$PROXY_PORT" \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    "$SSH_HOST"
  STARTED_TUNNEL=1

  for _ in $(seq 1 20); do
    if port_listening; then
      break
    fi
    sleep 0.5
  done

  if ! port_listening; then
    echo "[cloudpush] 隧道未建立，请确认服务器地址/密码" >&2
    exit 1
  fi
fi

git config --local http.proxy "$PROXY_URL"
git config --local https.proxy "$PROXY_URL"

if [ "$#" -eq 0 ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo "[cloudpush] git push origin ${branch}"
  git push origin "$branch"
else
  echo "[cloudpush] git push $*"
  git push "$@"
fi
