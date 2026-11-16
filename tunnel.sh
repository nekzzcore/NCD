#!/usr/bin/env bash
# NCD — публичный доступ с телефона через Cloudflare Tunnel
# Работает из любой сети (мобильный интернет не помеха)
# Использование: ./tunnel.sh [порт]
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"

# 1. Сервер синхронизации (если ещё не запущен)
if ! curl -s -m 1 "http://localhost:$PORT/" >/dev/null 2>&1; then
    echo "▶ Запускаю сервер синхронизации..."
    setsid nohup node server.js "$PORT" >/tmp/goaltracker-server.log 2>&1 < /dev/null &
    sleep 1
fi

# 2. Код доступа
if [ ! -f pin.txt ]; then
    node -e "require('./server')" 2>/dev/null || true
fi
PIN=$(cat pin.txt 2>/dev/null || echo "????")

# 3. Туннель Cloudflare
LOG=$(mktemp /tmp/goaltracker-tunnel.XXXXXX.log)
trap 'kill $CFPID 2>/dev/null; exit 0' INT TERM EXIT

./bin/cloudflared tunnel --url "http://localhost:$PORT" >"$LOG" 2>&1 &
CFPID=$!

URL=""
for _ in $(seq 1 40); do
    URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null | head -1)
    [ -n "$URL" ] && break
    sleep 0.5
done

echo ""
echo "=============================================="
if [ -n "$URL" ]; then
    echo "  🌍 NCD доступен в интернете!"
    echo "=============================================="
    echo ""
    echo "  📱 Ссылка для телефона:"
    echo "     $URL"
    echo ""
    echo "  🔑 Код доступа: $PIN"
    echo ""
    echo "  Откройте ссылку на телефоне (любая сеть),"
    echo "  введите код — данные подтянутся сами."
    echo ""
    echo "  ⚠️  Ссылка действует, пока открыт этот терминал."
    echo "  Остановить: Ctrl+C"
else
    echo "  ❌ Не удалось получить ссылку, лог:"
    tail -20 "$LOG"
fi
echo "=============================================="

wait $CFPID
