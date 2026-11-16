#!/bin/bash

# NCD — Быстрый запуск

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
    echo "📦 Установка зависимостей..."
    npm install
fi

echo "🚀 Запуск NCD..."
npm start
