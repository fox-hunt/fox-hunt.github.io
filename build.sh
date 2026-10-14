#!/bin/sh
# Builds the installable web app into ./docs from index.html (game) and ./assets (icons).
# ./docs is what gets published (GitHub Pages) and what the local server shows.
cd "$(dirname "$0")"
rm -rf docs && mkdir -p docs/icons
cp assets/icon-180.png assets/icon-192.png assets/icon-512.png assets/icon-maskable-512.png docs/icons/
cp assets/icon-round.svg docs/icons/favicon.svg
VER=$(date +%Y%m%d%H%M%S)
{
  cat <<'HEAD'
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Логическая игра «Охота на лис»: найдите лис по пеленгу.">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Охота на лис">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="icons/favicon.svg">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
</head>
<body>
HEAD
  cat index.html
  cat <<'FOOT'
<script>if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));</script>
</body>
</html>
FOOT
} > docs/index.html
cat > docs/manifest.webmanifest <<'JSON'
{
  "name": "Охота на лис",
  "short_name": "Охота на лис",
  "description": "Логическая игра: найдите лис по пеленгу.",
  "lang": "ru",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#dfeee6",
  "theme_color": "#145a3e",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
JSON
cat > docs/sw.js <<SW
// Offline support: always try the network first (fresh version), fall back to the cache offline.
const CACHE = 'fox-$VER';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icons/favicon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(c =>
    fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; })
      .catch(() => c.match(e.request).then(hit => hit || c.match('index.html')))
  ));
});
SW
touch docs/.nojekyll
echo "built: docs/ (version $VER)"
