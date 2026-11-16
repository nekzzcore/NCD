#!/usr/bin/env bash
# NCD — сервер для ноутбука и телефона (одна Wi-Fi сеть)
# Использование: ./serve.sh [порт]
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"
exec node server.js "$PORT"
