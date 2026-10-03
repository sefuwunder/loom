#!/bin/sh
# thinker-model.sh — thinker backed by a loom model file (JSON).
# Reads the loom context on stdin, prints one JSON action on stdout.
#
# Env:
#   LOOM_MODEL_FILE  path to the model file (default: ../models/qwen3.5-2b-tool.json
#                    relative to this script)
#   LOOM_MODEL       override the model name in the file
#   LOOM_API_URL     override the base_url in the file
#
# The model file selects the API: "ollama" -> POST <base>/api/chat (native options,
# format:"json", think:false), "openai-chat" -> POST <base>/v1/chat/completions.
# Usage:
#   export LOOM_MODEL_FILE="$PWD/models/qwen3.5-2b-tool.json"
#   export LOOM_CONTEXT_BUDGET=12288
#   LOOM_THINKER="sh examples/thinker-model.sh" loom work
set -eu
HERE=$(dirname "$0")
MODEL_FILE="${LOOM_MODEL_FILE:-$HERE/../models/qwen3.5-2b-tool.json}"
[ -f "$MODEL_FILE" ] || { echo "model file not found: $MODEL_FILE" >&2; exit 1; }
CTX_FILE=$(mktemp)
trap 'rm -f "$CTX_FILE"' EXIT INT TERM
cat > "$CTX_FILE"

RESP=$(python3 - "$MODEL_FILE" "$CTX_FILE" <<'PYEOF'
import json, sys, urllib.request

with open(sys.argv[1], encoding="utf-8") as f:
    mf = json.load(f)
with open(sys.argv[2], encoding="utf-8") as f:
    ctx = f.read()

import os
model = os.environ.get("LOOM_MODEL") or mf["model"]
base = (os.environ.get("LOOM_API_URL") or mf.get("base_url", "http://localhost:11434")).rstrip("/")
api = mf.get("api", "ollama" if "11434" in base else "openai-chat")
sys_prompt = mf.get("system_prompt", "")
timeout = int(mf.get("think_timeout_s", 240))
opts = dict(mf.get("options", {}))

messages = [
    {"role": "system", "content": sys_prompt},
    {"role": "user", "content": ctx},
]

if api == "ollama":
    body = {"model": model, "messages": messages, "stream": False, "options": opts}
    if mf.get("format") == "json":
        body["format"] = "json"
    if mf.get("disable_thinking"):
        body["think"] = False
    url = base + "/api/chat"

    def content_of(d):
        return d["message"]["content"]
else:
    body = {
        "model": model,
        "messages": messages,
        "temperature": opts.get("temperature", 0.2),
        "max_tokens": opts.get("num_predict", 1200),
    }
    if "top_p" in opts:
        body["top_p"] = opts["top_p"]
    url = base + "/chat/completions"

    def content_of(d):
        return d["choices"][0]["message"]["content"]

req = urllib.request.Request(
    url, data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"}
)
with urllib.request.urlopen(req, timeout=timeout) as r:
    d = json.load(r)
print(content_of(d))
PYEOF
)
printf '%s' "$RESP"
