#!/usr/bin/env python3
"""serve.py - the hosting half of a browser port.

The two headers at the top are not decoration: SharedArrayBuffer (and therefore
every threaded engine build) only works in a cross-origin-isolated context, so
COOP/COEP have to be set by the server. This is the same reason kpwn's bo1z
notes say "the server sends the COOP/COEP headers the engine needs", and why
GitHub Pages cannot host these at all.

Also here: HTTP Range (the asset streaming depends on it) and a /telemetry
endpoint that appends crash/frame records to telemetry.jsonl, again exactly the
bo1z pattern.
"""
import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.abspath(os.path.join(ROOT, "..", "web"))
DATA = os.path.abspath(os.path.join(ROOT, "..", "data"))
# On a hosted box the repo directory may be read-only, so fall back to /tmp.
TELEMETRY = os.path.join(ROOT, "telemetry.jsonl")
try:
    with open(TELEMETRY, "a"):
        pass
except OSError:
    TELEMETRY = os.path.join(os.environ.get("TMPDIR", "/tmp"), "browser-port-telemetry.jsonl")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".wad": "application/octet-stream",
    ".css": "text/css; charset=utf-8",
}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME}
    # Keep-alive matters here: the asset streamer makes dozens of Range requests
    # for one WAD, and HTTP/1.0 would open a fresh connection for every one.
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    # --- isolation headers -------------------------------------------------
    def isolation_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # Brave/Chrome still gate a few things behind this flag when the page
        # is not served over https:
        self.send_header("Permissions-Policy", "cross-origin-isolated=(self)")

    def end_headers(self):
        self.isolation_headers()
        super().end_headers()

    # --- Range support for the WAD ----------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self.health()
        if path.startswith("/data/"):
            return self.serve_file(os.path.join(DATA, path[len("/data/"):]))
        # /app/* and /build/* live under web/ and resolve as-is
        self.path = path
        return super().do_GET()

    def health(self):
        wad = os.path.join(DATA, "freedoom1.wad")
        out = json.dumps({
            "ok": True,
            "isolated": True,          # COOP/COEP are sent on every response
            "wad": os.path.getsize(wad) if os.path.isfile(wad) else None,
            "builds": [f[:-5] for f in sorted(os.listdir(WEB + "/build"))
                       if f.endswith(".wasm")] if os.path.isdir(WEB + "/build") else [],
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def serve_file(self, fpath):
        if not fpath.startswith(os.path.abspath(DATA)) or not os.path.isfile(fpath):
            self.send_error(404)
            return
        size = os.path.getsize(fpath)
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            unit, _, spec = rng.partition("=")
            lo, _, hi = spec.partition("-")
            start = int(lo or 0)
            end = int(hi) if hi else size - 1
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", MIME.get(os.path.splitext(fpath)[1], "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.isolation_headers()
        self.end_headers()
        with open(fpath, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # --- telemetry ---------------------------------------------------------
    def do_HEAD(self):
        path = urlparse(self.path).path
        if path.startswith("/data/"):
            fpath = os.path.join(DATA, path[len("/data/"):])
            if not os.path.isfile(fpath):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Length", str(os.path.getsize(fpath)))
            self.send_header("Accept-Ranges", "bytes")
            self.isolation_headers()
            self.end_headers()
            return
        return super().do_HEAD()

    def do_POST(self):
        if urlparse(self.path).path != "/telemetry":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b"{}"
        try:
            rec = json.loads(body)
        except Exception:
            rec = {"raw": body[:2000].decode("utf-8", "replace")}
        rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            with open(TELEMETRY, "a") as f:
                f.write(json.dumps(rec) + "\n")
        except OSError as e:
            sys.stderr.write("telemetry write failed: %s\n" % e)
        out = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    # Render (and any other PaaS) injects PORT and expects 0.0.0.0.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8765"))
    host = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("HOST", "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"http://{host}:{port}/   (web={os.path.abspath(WEB)} data={os.path.abspath(DATA)})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
