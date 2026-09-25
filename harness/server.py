"""Harness server: static files + a JSON /rpc that answers system.metrics from the real sampler.

Run with the hermes-agent worktree's interpreter so `agent.system_metrics` imports:
    HERMES_AGENT_DIR=~/projects/nous/hermes-agent-system-metrics \
      $HERMES_AGENT_DIR/.venv/bin/python harness/server.py
"""

from __future__ import annotations

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, os.path.expanduser(os.environ.get("HERMES_AGENT_DIR", "~/projects/nous/hermes-agent-system-metrics")))

from agent.system_metrics import read_system_metrics  # noqa: E402

HANDLERS = {
    # Mirrors tui_gateway/methods_tools.py's system.metrics handler exactly.
    "system.metrics": lambda _p: {"available": True, **read_system_metrics()},
    "session.active_list": lambda _p: {"sessions": []},
    "subagent.list": lambda _p: {"subagents": [], "delegations": []},
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        fn = HANDLERS.get(body["method"])
        out = {"result": fn(body.get("params") or {})} if fn else {"error": f"unknown method: {body['method']}"}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5188"))
    print(f"harness on http://127.0.0.1:{port}/harness/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
