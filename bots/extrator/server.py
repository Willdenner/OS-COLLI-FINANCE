import asyncio
import base64
import html
import json
import os
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from config.settings import GOOGLE_CREDENTIALS_PATH, GOOGLE_SERVICE_ACCOUNT_JSON, LOGIN_EMAIL, LOGIN_PASSWORD, SPREADSHEET_ID
from main import run


ADMIN_USER = os.getenv("ADMIN_USER", "").strip()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
PORT = int(os.getenv("PORT", "10000"))

state_lock = threading.Lock()
run_state = {
    "status": "idle",
    "run_id": None,
    "started_at": None,
    "finished_at": None,
    "skip_export": False,
    "error": None,
}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def configured():
    missing = []
    if not ADMIN_USER:
        missing.append("ADMIN_USER")
    if not ADMIN_PASSWORD:
        missing.append("ADMIN_PASSWORD")
    if not LOGIN_EMAIL:
        missing.append("LOGIN_EMAIL")
    if not LOGIN_PASSWORD:
        missing.append("LOGIN_PASSWORD")
    if not SPREADSHEET_ID:
        missing.append("SPREADSHEET_ID")
    if not GOOGLE_SERVICE_ACCOUNT_JSON and not os.path.exists(GOOGLE_CREDENTIALS_PATH):
        missing.append("GOOGLE_SERVICE_ACCOUNT_JSON")
    return missing


def is_authorized(header):
    if not ADMIN_USER or not ADMIN_PASSWORD:
        return False
    scheme, _, encoded = str(header or "").partition(" ")
    if scheme.lower() != "basic" or not encoded:
        return False
    try:
        decoded = base64.b64decode(encoded).decode("utf-8")
    except Exception:
        return False
    username, _, password = decoded.partition(":")
    return username == ADMIN_USER and password == ADMIN_PASSWORD


def snapshot_state():
    with state_lock:
        return dict(run_state)


def mark_state(**patch):
    with state_lock:
        run_state.update(patch)
        return dict(run_state)


def run_extractor(skip_export):
    try:
        asyncio.run(run(headless=True, skip_export=skip_export))
        mark_state(status="success", finished_at=now_iso(), error=None)
    except SystemExit as exc:
        code = getattr(exc, "code", 1)
        status = "success" if code in (0, None) else "error"
        mark_state(status=status, finished_at=now_iso(), error=None if status == "success" else f"Exited with code {code}")
    except Exception:
        mark_state(status="error", finished_at=now_iso(), error=traceback.format_exc(limit=8))


def start_extractor(skip_export):
    with state_lock:
        if run_state["status"] == "running":
            return False
        run_id = f"run_{int(time.time())}"
        run_state.update(
            {
                "status": "running",
                "run_id": run_id,
                "started_at": now_iso(),
                "finished_at": None,
                "skip_export": skip_export,
                "error": None,
            }
        )

    thread = threading.Thread(target=run_extractor, args=(skip_export,), daemon=True)
    thread.start()
    return True


def render_page():
    missing = configured()
    current = snapshot_state()
    safe_error = html.escape(current.get("error") or "")
    disabled = "disabled" if missing or current["status"] == "running" else ""
    missing_text = ", ".join(missing) if missing else "Tudo pronto para executar."
    status_text = html.escape(str(current["status"]))
    started_at = html.escape(str(current.get("started_at") or "-"))
    finished_at = html.escape(str(current.get("finished_at") or "-"))

    return f"""<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Bot Extrator</title>
    <style>
      body {{
        margin: 0;
        min-height: 100vh;
        background: #050608;
        color: #e8d5a3;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
      }}
      main {{
        width: min(720px, calc(100vw - 40px));
        border: 1px solid rgba(245,166,35,0.24);
        padding: 32px;
        background: rgba(245,166,35,0.04);
      }}
      h1 {{
        margin: 0 0 8px;
        color: #f5a623;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }}
      p, li {{
        color: rgba(232,213,163,0.72);
        line-height: 1.55;
      }}
      dl {{
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 10px 18px;
        margin: 24px 0;
      }}
      dt {{
        color: rgba(232,213,163,0.48);
      }}
      dd {{
        margin: 0;
      }}
      button, a {{
        color: #050608;
        background: #f5a623;
        border: 0;
        padding: 12px 18px;
        text-decoration: none;
        font-weight: 700;
        cursor: pointer;
      }}
      button:disabled {{
        opacity: 0.45;
        cursor: not-allowed;
      }}
      code, pre {{
        color: #ffd166;
      }}
      pre {{
        white-space: pre-wrap;
        background: rgba(0,0,0,0.28);
        padding: 16px;
        overflow: auto;
      }}
      .actions {{
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }}
    </style>
  </head>
  <body>
    <main>
      <h1>Bot Extrator</h1>
      <p>Execute a extracao CRM V4 para Google Sheets e acompanhe o estado da ultima rodada.</p>
      <dl>
        <dt>Status</dt><dd>{status_text}</dd>
        <dt>Configuracao</dt><dd>{html.escape(missing_text)}</dd>
        <dt>Inicio</dt><dd>{started_at}</dd>
        <dt>Fim</dt><dd>{finished_at}</dd>
      </dl>
      <form class="actions" method="post" action="/run">
        <button type="submit" {disabled}>Executar extrator</button>
        <label><input type="checkbox" name="skip_export" value="1"> testar sem exportar</label>
        <a href="/">Atualizar</a>
      </form>
      {f"<pre>{safe_error}</pre>" if safe_error else ""}
    </main>
  </body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{now_iso()}] {self.address_string()} {fmt % args}")

    def send_html(self, status, body):
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def require_auth(self):
        if not ADMIN_USER or not ADMIN_PASSWORD:
            return True
        if is_authorized(self.headers.get("Authorization")):
            return True
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", 'Basic realm="Bot Extrator", charset="UTF-8"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Autenticacao obrigatoria.")
        return False

    def do_GET(self):
        if self.path == "/healthz":
            self.send_json(HTTPStatus.OK, {"ok": True, "service": "bot-extrator"})
            return
        if self.path == "/api/status":
            if not self.require_auth():
                return
            self.send_json(HTTPStatus.OK, {"ok": True, "state": snapshot_state(), "missing": configured()})
            return
        if self.path == "/":
            if not self.require_auth():
                return
            self.send_html(HTTPStatus.OK, render_page())
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        if self.path != "/run":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not self.require_auth():
            return

        content_length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(content_length).decode("utf-8") if content_length else ""
        form = parse_qs(body)
        skip_export = form.get("skip_export", [""])[0] == "1"
        missing = configured()
        if missing:
            self.send_html(HTTPStatus.SERVICE_UNAVAILABLE, render_page())
            return

        start_extractor(skip_export)
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", "/")
        self.end_headers()


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Bot Extrator: http://0.0.0.0:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
