#!/usr/bin/env python3
"""Beatline local server: serves the app and helps it find songs on this Mac.

Browsers never reveal where a dropped file lives, but Final Cut needs the full
path to link the song. /api/locate finds the file by name and size (Spotlight
first, then common folders), /api/exists confirms a path.

/api/send saves an FCPXML to ~/Movies/Beatline and opens it in Final Cut Pro.

Listens on 127.0.0.1 only and answers API calls only for its own address.
Writes need a custom header, which other websites can't send without a CORS
preflight this server never approves.
"""
import http.server
import json
import os
import re
import subprocess
import sys
import urllib.parse
from functools import partial

ROOT = os.path.dirname(os.path.abspath(__file__))
SEARCH_DIRS = ["Music", "Downloads", "Desktop", "Movies", "Documents", "Pictures"]
MAX_DEPTH = 5


def spotlight(name):
    try:
        out = subprocess.run(["mdfind", "-name", name], capture_output=True, text=True, timeout=5)
        return [p for p in out.stdout.splitlines() if os.path.basename(p) == name]
    except (OSError, subprocess.SubprocessError):
        return []


def walk(name):
    home = os.path.expanduser("~")
    found = []
    for d in SEARCH_DIRS:
        base = os.path.join(home, d)
        base_depth = base.rstrip(os.sep).count(os.sep)
        for dirpath, dirnames, filenames in os.walk(base):
            if dirpath.count(os.sep) - base_depth >= MAX_DEPTH:
                dirnames[:] = []
            dirnames[:] = [x for x in dirnames if not x.startswith(".") and not x.endswith((".fcpbundle", ".photoslibrary"))]
            if name in filenames:
                found.append(os.path.join(dirpath, name))
            if len(found) >= 20:
                return found
    return found


def locate(name, size):
    seen, matches = set(), []
    for path in spotlight(name) + walk(name):
        if path in seen:
            continue
        seen.add(path)
        try:
            if size is None or os.path.getsize(path) == size:
                matches.append(path)
        except OSError:
            pass
    # Most recently modified first.
    matches.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return matches


def open_in_fcp(path):
    if sys.platform != "darwin":
        return False
    for cmd in (["open", "-a", "Final Cut Pro", path], ["open", path]):
        if subprocess.run(cmd, capture_output=True).returncode == 0:
            return True
    return False


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        # Always fetch fresh app files; the service worker handles offline.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        # Refuse requests addressed to any other host name (DNS rebinding).
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return self.reply(403, {"error": "forbidden"})
        q = urllib.parse.parse_qs(url.query)
        if url.path == "/api/ping":
            return self.reply(200, {"app": "beatline", "platform": sys.platform})
        if url.path == "/api/locate":
            name = os.path.basename(q.get("name", [""])[0])
            size = q.get("size", [None])[0]
            if not name:
                return self.reply(400, {"error": "name required"})
            return self.reply(200, {"paths": locate(name, int(size) if size else None)})
        if url.path == "/api/exists":
            path = q.get("path", [""])[0]
            ok = os.path.isfile(path)
            return self.reply(200, {"exists": ok, "size": os.path.getsize(path) if ok else None})
        return self.reply(404, {"error": "not found"})

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost") or self.headers.get("X-Beatline") != "1":
            return self.reply(403, {"error": "forbidden"})
        if url.path != "/api/send":
            return self.reply(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 20_000_000:
            return self.reply(400, {"error": "bad length"})
        body = self.rfile.read(length)
        if not body.lstrip().startswith(b"<?xml") or b"<fcpxml" not in body[:400]:
            return self.reply(400, {"error": "not an fcpxml file"})
        name = urllib.parse.parse_qs(url.query).get("name", ["Beatline"])[0]
        name = re.sub(r"[^\w .()\-–]+", "_", name).strip() or "Beatline"
        folder = os.path.join(os.path.expanduser("~"), "Movies", "Beatline")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name + ".fcpxml")
        with open(path, "wb") as f:
            f.write(body)
        return self.reply(200, {"path": path, "opened": open_in_fcp(path)})

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=ROOT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
