#!/usr/bin/env bash
# NCD — публикация приложения в Cloudflare (постоянный адрес в облаке)
# Использование: ./deploy.sh     (предварительно: npx wrangler login)
set -e
cd "$(dirname "$0")"

# --- 1. Код доступа берём из pin.txt ---
PIN=$(grep -oE '[0-9]{4,8}' pin.txt 2>/dev/null | head -1 || true)
if [ -z "$PIN" ]; then
    echo "❌ Не найден код доступа (pin.txt). Запустите один раз ./serve.sh и повторите."
    exit 1
fi

# --- 2. Собираем веб-часть приложения в public/ ---
echo "▶ Собираю веб-файлы в public/..."
npm run build:web
echo "   $(ls public | wc -l) файлов готово"

# --- 3. Код доступа задаётся как секрет воркера (в конфиге и клиенте его нет) ---
echo "▶ Задаю SYNC_PIN как секрет воркера (не хранится в конфиге)..."
if echo "$PIN" | npx wrangler secret put SYNC_PIN 2>&1 | sed 's/^/   /'; then
    echo "   секрет установлен"
else
    echo "   ⚠️ Не удалось задать секрет (воркер ещё не опубликован?). После первой публикации выполните:"
    echo "      echo '<PIN>' | npx wrangler secret put SYNC_PIN && npx wrangler deploy"
fi

# --- 4. Первый запуск: создаём облачное хранилище ---
if grep -q 'REPLACE_ME' wrangler.jsonc; then
    echo "▶ Первый запуск: создаю облачное хранилище KV..."
    OUT=$(npx wrangler kv namespace create SYNC 2>&1)
    echo "$OUT"
    ID=$(echo "$OUT" | grep -oE '\b[0-9a-f]{32}\b' | head -1)
    if [ -z "$ID" ]; then
        echo "❌ Не удалось получить ID хранилища. Вывод выше — скопируйте мне его."
        exit 1
    fi
    node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'));
    cfg.kv_namespaces[0].id = '$ID';
    fs.writeFileSync('wrangler.jsonc', JSON.stringify(cfg, null, 2) + '\n');
    "
    echo "   ✅ хранилище создано: $ID"
fi

# --- 5. Публикация ---
echo "▶ Публикую в Cloudflare..."
LOG=$(mktemp /tmp/goaltracker-deploy.XXXXXX.log)
npx wrangler deploy 2>&1 | tee "$LOG"

URL=$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' "$LOG" | head -1)
echo ""
echo "=============================================="
if [ -n "$URL" ]; then
    echo "  ☁️  Приложение опубликовано!"
    echo "=============================================="
    echo "  📱 Постоянная ссылка:"
    echo "     $URL"
    echo ""
    echo "  🔑 Код доступа: $PIN"
    echo ""
    echo "  Откройте на телефоне → ⋮ → «Установить приложение»"
    echo "  Обновить после правок: ./deploy.sh"
    echo "=============================================="
    echo "$URL" > .cloud-url
else
    echo "  ⚠️ Ссылку не увидел в выводе — скопируйте мне лог: $LOG"
fi
