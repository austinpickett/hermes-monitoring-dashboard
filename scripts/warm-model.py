#!/usr/bin/env python3
"""Pre-load the local model before the demo so the first prompt doesn't pay the load.

Does what the runtime's own ``ensure_model_ready`` does, from outside the app: POST the router's
``/models/load``, wait until the model is resident, then prove it with one short generation.

    python scripts/warm-model.py [MODEL_ID]          # the default Hermes home
    HERMES_HOME=/other/home python scripts/warm-model.py   # a scratch or profile home

The runtime unloads a model after 15 minutes idle (supervisor ``IDLE_UNLOAD_S``) and reloads it on
the next message (~100 s on the Spark), so run this within ~10 minutes of the first on-stage prompt.
Stdlib only; reads the endpoint + key from ``runtimes/llamacpp/server.json`` and never prints the key.
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

RESIDENT = ("loaded", "ready")


def default_home() -> Path:
    """Same resolution as Hermes (hermes_constants): HERMES_HOME, else the platform default —
    %LOCALAPPDATA%\\hermes on Windows, ~/.hermes elsewhere."""
    if os.environ.get("HERMES_HOME", "").strip():
        return Path(os.path.expandvars(os.path.expanduser(os.environ["HERMES_HOME"])))
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", "").strip()
        return (Path(base) if base else Path.home() / "AppData" / "Local") / "hermes"
    return Path.home() / ".hermes"


def main() -> int:
    home = default_home()
    state = home / "runtimes" / "llamacpp" / "server.json"
    if not state.exists():
        print(f"no local runtime state at {state} — is the local engine running?")
        return 2
    info = json.loads(state.read_text(encoding="utf-8"))
    base = info["base_url"].rstrip("/").removesuffix("/v1")
    key = info.get("api_key") or ""

    def call(route, body=None, timeout=30):
        req = urllib.request.Request(
            base + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="GET" if body is None else "POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}

    def statuses():
        return {m["id"]: m.get("status", {}).get("value", "unknown") for m in call("/models").get("data", [])}

    try:
        models = statuses()
    except OSError as exc:  # URLError subclasses OSError: nothing listening on the recorded port
        print(f"local engine not reachable at {base} ({getattr(exc, 'reason', exc)}).")
        print("The engine runs inside Hermes: open the Hermes app (or the dev app) first, then re-run this.")
        return 2
    if not models:
        print("router lists no models")
        return 2
    model = sys.argv[1] if len(sys.argv) > 1 else next(iter(models))
    if model not in models:
        print(f"{model} not staged; available: {', '.join(models)}")
        return 2

    t0 = time.monotonic()
    if models[model] in RESIDENT:
        print(f"{model}: already resident")
    else:
        print(f"{model}: {models[model]} -> loading…", flush=True)
        call("/models/load", {"model": model}, timeout=600)
        while statuses().get(model) not in RESIDENT:
            if time.monotonic() - t0 > 600:
                print("timed out waiting for the model to become resident")
                return 1
            time.sleep(2)
        print(f"{model}: resident after {time.monotonic() - t0:.0f}s")

    t1 = time.monotonic()
    resp = call("/v1/chat/completions", {
        "model": model, "max_tokens": 512, "temperature": 0,
        "messages": [{"role": "user", "content": "Reply with exactly one word: the capital of France."}],
    }, timeout=300)
    msg = resp["choices"][0]["message"]
    ok = "paris" in ((msg.get("content") or "") + " " + (msg.get("reasoning_content") or "")).lower()
    print(f"touch generation {'OK' if ok else 'UNEXPECTED'} in {time.monotonic() - t1:.1f}s")
    print("ready — first prompt within ~10 min skips the load" if ok else "model answered unexpectedly")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
