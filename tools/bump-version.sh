#!/bin/sh
# Поднимает номер версии во всех местах сразу: index.html, импорты в dist/js и dist/version.json.
# Запускать после любого изменения CSS/JS, чтобы Telegram не показывал старый код.
set -e
cd "$(dirname "$0")/../dist"
OLD=$(python3 -c "import json;print(json.load(open('version.json'))['v'])")
NEW=$((OLD + 1))
grep -rl "v=$OLD" index.html js | xargs sed -i '' "s/v=$OLD/v=$NEW/g"
sed -i '' "s/let v = '$OLD'/let v = '$NEW'/" index.html
printf '{ "v": %s }\n' "$NEW" > version.json
echo "версия $OLD → $NEW"
