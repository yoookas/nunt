#!/usr/bin/env bash
# Local soak check: starts the binary, serves a static rule, drives concurrent
# traffic and compares goroutines / heap / RSS before and after.
#
#   ./scripts/soak.sh                 # 20 workers x 200 requests
#   WORKERS=40 EACH=500 ./scripts/soak.sh
#
# It is a smoke-sized soak (a few thousand requests), not a 24 h run: it catches
# obvious leaks and crashes in a couple of minutes.
set -euo pipefail

BIN="${BIN:-./nunt}"
PORT="${PORT:-13990}"
WORKERS="${WORKERS:-20}"
EACH="${EACH:-200}"

work="$(mktemp -d)"
pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/data" "$work/site"
echo "hello soak" > "$work/site/index.html"

export NUNT_ADMIN_PORT="$PORT"
"$BIN" -d "$work/data" -log-level warn > "$work/nunt.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null

password="$(sed -n 's/.*Administrator pass : \(.*\)/\1/p' "$work/nunt.log" | head -1)"
[ -n "$password" ] || { echo "no generated password in the log" >&2; exit 1; }

login="$(curl -sS -c "$work/cookies" -H 'Content-Type: application/json' \
  --data "{\"username\":\"admin\",\"password\":\"$password\"}" \
  "http://127.0.0.1:$PORT/api/v1/auth/login")"
csrf="$(printf '%s' "$login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')"

listener="$(curl -sS -b "$work/cookies" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data "{\"name\":\"soak\",\"listen\":[\"127.0.0.1:$((PORT+1))\"],\"tls\":{\"mode\":\"off\"}}" \
  "http://127.0.0.1:$PORT/api/v1/web/listeners")"
lid="$(printf '%s' "$listener" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
curl -sS -b "$work/cookies" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data "{\"name\":\"soak-route\",\"enable\":true,\"type\":\"static\",\"listenerId\":\"$lid\",\"domains\":[\"soak.test\"],\"path\":\"/\",\"static\":{\"root\":\"$work/site\",\"index\":[\"index.html\"]}}" \
  "http://127.0.0.1:$PORT/api/v1/web/rules" >/dev/null

sample() {
  python3 - "$PORT" "$work/cookies" <<'PY'
import json, subprocess, sys
port, cookies = sys.argv[1], sys.argv[2]
out = subprocess.check_output(["curl", "-sS", "-b", cookies, f"http://127.0.0.1:{port}/api/v1/system/stats"])
data = json.loads(out)
print(f"{data['goroutines']} {data['heapBytes']} {data['uptimeSec']}")
PY
}

read -r g0 h0 _ < <(sample)
rss0="$(ps -o rss= -p "$pid" | tr -d ' ')"
echo "before: goroutines=$g0 heap=${h0}B rss=${rss0}KB"

start=$(date +%s)
# xargs bounds the parallelism and exits on its own; a hand rolled worker pool
# is easy to get wrong (a bare `wait` also waits for the server process).
seq 1 $((WORKERS * EACH)) | xargs -P "$WORKERS" -I{} \
  curl -s --max-time 10 -o /dev/null -w '%{http_code}\n' -H 'Host: soak.test' \
  "http://127.0.0.1:$((PORT+1))/" > "$work/codes.txt" || true
elapsed=$(( $(date +%s) - start ))

total=$(wc -l < "$work/codes.txt")
ok=$(grep -c '^200$' "$work/codes.txt" || true)
read -r g1 h1 _ < <(sample)
rss1="$(ps -o rss= -p "$pid" | tr -d ' ')"
echo "after:  goroutines=$g1 heap=${h1}B rss=${rss1}KB"
echo "requests: $total in ${elapsed}s, 200 responses: $ok"

status=0
[ "$ok" -eq "$total" ] || { echo "FAIL: $((total-ok)) requests did not return 200" >&2; status=1; }
[ "$g0" -gt 0 ] || g0=1
if [ "$g1" -gt $((g0 * 3)) ]; then echo "FAIL: goroutines grew from $g0 to $g1" >&2; status=1; fi
if [ "$h1" -gt $((h0 * 3)) ]; then echo "FAIL: heap grew from $h0 to $h1" >&2; status=1; fi
[ "$status" -eq 0 ] && echo "soak ok"
exit "$status"
