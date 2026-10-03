#!/bin/sh
# thinker-openai.sh — thinker backed by any OpenAI-compatible chat API.
# Env: LOOM_API_URL (default https://api.openai.com/v1), LOOM_API_KEY (required),
#      LOOM_MODEL (default gpt-4o-mini). Reads loom context on stdin, prints one JSON action.
set -eu
: "${LOOM_API_KEY:?set LOOM_API_KEY}"
URL="${LOOM_API_URL:-https://api.openai.com/v1}"
MODEL="${LOOM_MODEL:-gpt-4o-mini}"
CTX=$(cat)
SYS="You are the reasoning engine inside the loom harness. The human does not need instant feedback; they need you to COMPLETE the task without spinning in circles. Read the goal, history, and last result. Reply with exactly one JSON action object and nothing else. Never repeat an action that just produced identical output — vary your approach or mark the job blocked with a clear reason. Prefer small verifiable steps: run a command, read the result, adjust."

# JSON-escape the context with python3 (or jq if present)
if command -v jq >/dev/null 2>&1; then
  PAYLOAD=$(jq -n --arg sys "$SYS" --arg ctx "$CTX" --arg model "$MODEL" \
    '{model:$model,messages:[{role:"system",content:$sys},{role:"user",content:$ctx}],temperature:0.2,max_tokens:1200}')
else
  PAYLOAD=$(python3 -c '
import json,sys
print(json.dumps({"model":sys.argv[1],"messages":[{"role":"system","content":sys.argv[2]},{"role":"user","content":sys.argv[3]}],"temperature":0.2,"max_tokens":1200}))' \
    "$MODEL" "$SYS" "$CTX")
fi

curl -sS --max-time 280 "$URL/chat/completions" \
  -H "Authorization: Bearer $LOOM_API_KEY" -H "Content-Type: application/json" \
  -d "$PAYLOAD" | python3 -c '
import json,sys
d = json.load(sys.stdin)
print(d["choices"][0]["message"]["content"])'
