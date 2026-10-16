#!/bin/sh
# Runs all tests: the Telegram function (fake Telegram + fake database) and the game page in headless Chrome.
# From the project folder: sh tests/run.sh
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install --silent --no-audit --no-fund || exit 1
[ ../index.html -nt ../docs/index.html ] && sh ../build.sh     # the game test checks the built site

mkdir -p .build
sed 's#npm:@supabase/supabase-js@2#../tg/mock.mjs#' ../supabase/functions/tg/index.ts > .build/tg.ts
npx esbuild .build/tg.ts --format=esm --outfile=.build/tg.js --log-level=warning || exit 1

echo "== функция бота"
node tg/test.mjs > .build/tg.log 2>&1; a=$?
grep -v '^    at \|^webhook Error' .build/tg.log      # (the test makes Telegram fail on purpose: that log line is expected)
echo; echo "== игра"; node game/test.mjs; b=$?
[ $a -eq 0 ] && [ $b -eq 0 ]
