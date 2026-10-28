#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
PORT="${PORT:-8015}"

cleanup() { kill "$API_PID" "$VITE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

npm run api:dev &
API_PID=$!
./node_modules/.bin/vite --host 0.0.0.0 --port "$PORT" "$@" &
VITE_PID=$!

echo "Kilo 本地测试 UI: http://127.0.0.1:${PORT}（局域网地址见 Vite 输出）"
echo "Kilo 本地测试 API: http://127.0.0.1:${KILO_API_PORT:-8016}/health"
wait -n "$API_PID" "$VITE_PID"
