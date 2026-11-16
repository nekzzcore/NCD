#!/bin/bash

echo "🎯 NCD — Установка"
echo "================================"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js не найден. Установите Node.js с https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js найден: $(node --version)"

# Install dependencies
echo ""
echo "📦 Установка зависимостей..."
npm install

# Create desktop entry for Linux
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo ""
    echo "🖥️ Создание ярлыка для Linux..."
    
    DESKTOP_FILE="$HOME/.local/share/applications/goaltracker.desktop"
    mkdir -p "$HOME/.local/share/applications"
    
    cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=NCD
Comment=Система управления целями
Exec=$(pwd)/node_modules/.bin/electron $(pwd)
Icon=$(pwd)/icon.png
Type=Application
Categories=Utility;Office;
Terminal=false
EOF
    
    chmod +x "$DESKTOP_FILE"
    echo "✅ Ярлык создан: $DESKTOP_FILE"
fi

echo ""
echo "✅ Установка завершена!"
echo ""
echo "🚀 Запуск приложения..."
echo "   npm start"
echo ""
echo "   или"
echo ""
echo "   ./start.sh"
echo ""

# Ask to read
read -p "Запустить сейчас? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    npm start
fi
