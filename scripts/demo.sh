#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(node cli/index.js)
SERVER_URL="http://localhost:7070"
TACHI_HOME="$(mktemp -d)"
export TACHI_HOME

SERVER_PID=""
SERVER_LOG="$TACHI_HOME/server.log"
DEMO_DIR="/tmp/tachi-demo"
OUTPUT_PATH="$DEMO_DIR/review-output.md"
LAST_BODY=""
LAST_STATUS=""
LAST_CLI_OUTPUT=""

if command -v tput >/dev/null 2>&1 && [[ -n "${TERM:-}" ]] && tput colors >/dev/null 2>&1; then
  BOLD="$(tput bold)"
  RED="$(tput setaf 1)"
  GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"
  BLUE="$(tput setaf 4)"
  CYAN="$(tput setaf 6)"
  RESET="$(tput sgr0)"
else
  BOLD=$'\033[1m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
fi

section() {
  printf "\n%s%s== %s ==%s\n" "$BOLD" "$BLUE" "$1" "$RESET"
}

info() {
  printf "%s[%s]%s %s\n" "$CYAN" "demo" "$RESET" "$1"
}

success() {
  printf "%s[%s]%s %s\n" "$GREEN" "ok" "$RESET" "$1"
}

fail() {
  printf "%s[%s]%s %s\n" "$RED" "fail" "$RESET" "$1" >&2
  exit 1
}

cleanup() {
  set +e
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$DEMO_DIR" "$TACHI_HOME"
}

trap cleanup EXIT

pretty_json() {
  node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    try {
      const parsed = JSON.parse(input);
      process.stdout.write(JSON.stringify(parsed, null, 2));
    } catch (_error) {
      process.stdout.write(input);
    }
  '
}

json_get() {
  local path="$1"
  node -e '
    const fs = require("fs");
    const path = process.argv[1].split(".");
    const input = fs.readFileSync(0, "utf8");
    const parsed = JSON.parse(input);
    let value = parsed;
    for (const key of path) {
      value = value == null ? undefined : value[key];
    }
    if (value === undefined) {
      process.exit(2);
    }
    if (typeof value === "object") {
      process.stdout.write(JSON.stringify(value));
      process.exit(0);
    }
    process.stdout.write(String(value));
  ' "$path"
}

assert_body_field() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(printf '%s' "$LAST_BODY" | json_get "$path")" || fail "Missing JSON field '$path'"
  [[ "$actual" == "$expected" ]] || fail "Expected $path='$expected' but got '$actual'"
}

assert_cli_contains() {
  local expected="$1"
  [[ "$LAST_CLI_OUTPUT" == *"$expected"* ]] || fail "Expected CLI output to contain '$expected'"
}

run_cli() {
  local expected_status="$1"
  shift

  local cmd=("${CLI[@]}" "$@")
  local output
  local status

  info "Running: TACHI_HOME=$TACHI_HOME ${cmd[*]}"
  set +e
  output="$(
    cd "$ROOT_DIR" &&
      TACHI_HOME="$TACHI_HOME" "${cmd[@]}" 2>&1
  )"
  status=$?
  set -e

  printf "%s\n" "$output"
  LAST_CLI_OUTPUT="$output"

  if [[ "$status" -ne "$expected_status" ]]; then
    fail "CLI command failed with exit code $status"
  fi
}

run_api() {
  local expected_status="$1"
  local api_key="$2"
  local method="$3"
  local path="$4"
  local body="${5:-}"

  local response
  local curl_args=(
    -sS
    -X "$method"
    -H "X-API-Key: $api_key"
    -H "Content-Type: application/json"
    -w $'\nHTTP_STATUS:%{http_code}'
  )

  if [[ -n "$body" ]]; then
    curl_args+=(-d "$body")
  fi

  info "Calling: $method $path"
  response="$(curl "${curl_args[@]}" "$SERVER_URL$path")" || fail "curl failed for $path"
  LAST_STATUS="${response##*HTTP_STATUS:}"
  LAST_BODY="${response%$'\n'HTTP_STATUS:*}"
  printf "%s\n" "$LAST_BODY" | pretty_json

  if [[ "$LAST_STATUS" != "$expected_status" ]]; then
    fail "Expected HTTP $expected_status from $path but got $LAST_STATUS"
  fi
}

wait_for_server() {
  local attempts=0
  until curl -fsS "$SERVER_URL/health" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 50 ]]; then
      [[ -f "$SERVER_LOG" ]] && cat "$SERVER_LOG" >&2
      fail "Server did not become ready on $SERVER_URL"
    fi
    sleep 0.2
  done
}

mkdir -p "$DEMO_DIR"
cat >"$OUTPUT_PATH" <<'EOF'
# Authentication Module Review

- Parameterize all SQL queries that interpolate user-controlled input.
- Verify ORM fallback paths do not concatenate raw identifiers.
- Add regression tests for login, password reset, and session lookup paths.
EOF

section "Boot Server"
info "Starting Tachi server in the background on localhost:7070"
(
  cd "$ROOT_DIR" &&
    TACHI_HOME="$TACHI_HOME" "${CLI[@]}" server start >"$SERVER_LOG" 2>&1
) &
SERVER_PID=$!
wait_for_server
kill -0 "$SERVER_PID" >/dev/null 2>&1 || fail "Tried to start the server, but the process exited early"
success "Server is healthy"
curl -fsS "$SERVER_URL/health" | pretty_json

section "Register Agents"
run_cli 0 register --name alice-buyer --capabilities management
assert_cli_contains "Registered as alice-buyer"
ALICE_CONFIG="$(cat "$TACHI_HOME/config.json")"
ALICE_ID="$(printf '%s' "$ALICE_CONFIG" | json_get "agent_id")"
ALICE_API_KEY="$(printf '%s' "$ALICE_CONFIG" | json_get "api_key")"

run_cli 0 register --name bob-specialist --capabilities code-review,summarization
assert_cli_contains "Registered as bob-specialist"
BOB_CONFIG="$(cat "$TACHI_HOME/config.json")"
BOB_ID="$(printf '%s' "$BOB_CONFIG" | json_get "agent_id")"
BOB_API_KEY="$(printf '%s' "$BOB_CONFIG" | json_get "api_key")"

[[ "$ALICE_API_KEY" != "$BOB_API_KEY" ]] || fail "Alice and Bob API keys should differ"
success "Saved Alice and Bob credentials from the isolated config"

section "Fund Buyer"
run_api 200 "$ALICE_API_KEY" POST /wallet/topup '{"amount":100}'
assert_body_field "balance" "100"

section "Post Task"
run_api 201 "$ALICE_API_KEY" POST /tasks '{"capability":"code-review","spec":"Review the authentication module for SQL injection vulnerabilities","budget_max":10}'
TASK_ID="$(printf '%s' "$LAST_BODY" | json_get "id")"
assert_body_field "status" "matched"
assert_body_field "matched_agent_id" "$BOB_ID"
success "Task $TASK_ID posted and matched to Bob"

section "Find And Accept"
run_cli 0 find --status matched --capability code-review
assert_cli_contains "$TASK_ID"
run_cli 0 accept "$TASK_ID"
assert_cli_contains "Accepted task $TASK_ID"

section "Deliver Work"
run_cli 0 deliver "$TASK_ID" --output "$OUTPUT_PATH"
assert_cli_contains "Delivered task $TASK_ID"

section "Approve Delivery"
run_api 200 "$ALICE_API_KEY" POST "/tasks/$TASK_ID/approve"
assert_body_field "status" "approved"

section "Exchange Ratings"
run_api 201 "$ALICE_API_KEY" POST "/tasks/$TASK_ID/rate" '{"rating":5,"comment":"Thorough findings with actionable remediation steps."}'
assert_body_field "reviewee_id" "$BOB_ID"

run_cli 0 rate "$TASK_ID" --stars 4 --comment "Clear task spec and fast approval."
assert_cli_contains "Rated task $TASK_ID: 4/5"

section "Final State"
info "Alice wallet balance"
run_api 200 "$ALICE_API_KEY" GET /wallet/balance
info "Bob wallet balance"
run_cli 0 wallet balance

info "Alice profile"
run_api 200 "$ALICE_API_KEY" GET "/agents/$ALICE_ID"
info "Bob profile"
run_cli 0 agent "$BOB_ID"

info "Alice task history"
run_api 200 "$ALICE_API_KEY" GET /history
info "Bob task history"
run_cli 0 history

success "Tachi demo completed successfully"
exit 0
