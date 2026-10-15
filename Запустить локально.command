#!/bin/sh
# Двойной щелчок: запускает игру на этом Mac (http://localhost:8790) и открывает её в браузере.
# Закрыть окно Терминала = остановить.
cd "$(dirname "$0")/docs" || exit 1
lsof -ti tcp:8790 | xargs kill 2>/dev/null
(sleep 1; open "http://localhost:8790") &
echo "Игра запущена: http://localhost:8790  (закройте это окно, чтобы остановить)"
exec python3 -c '
import http.server, functools
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
http.server.ThreadingHTTPServer(("0.0.0.0", 8790), functools.partial(H, directory=".")).serve_forever()
'
