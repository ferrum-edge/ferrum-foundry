#!/usr/bin/env bash
# ------------------------------------------------------------------
# Smoke test for the deployment starter's production profile
# ------------------------------------------------------------------
#
# Brings up deploy/starter's production profile as shipped (nginx terminating
# TLS, oauth2-proxy owning the OIDC login, Foundry behind both) against a mock
# OIDC provider, then checks with curl and a cookie jar that:
#
#   1. an unauthenticated page load is sent to the provider's authorize
#      endpoint, and an unauthenticated API call gets a bare 401;
#   2. a login completed against the provider reaches Foundry through nginx
#      and oauth2-proxy with the identity the shared policy maps the user's
#      groups to, and a user in no Ferrum group is refused at login;
#   3. nginx sets every forwarded header oauth2-proxy reads, on /oauth2/ and on
#      the /oauth2/auth subrequest, and a client's spoofed values reach neither
#      oauth2-proxy nor Foundry.
#
# Only the files an operator fills in are written: .env and oauth2-proxy.env
# copied from their examples, the proxy-proof include, and a TLS certificate
# from a CA generated for this run. The overlay adds the mock provider and
# nothing else.
#
#   run.sh configure   write the operator files (refuses to overwrite)
#   run.sh up          start the mock provider, then the production profile
#   run.sh verify      run the checks above
#   run.sh logs        print every container's state and logs
#   run.sh down        stop the stack
#
# FOUNDRY_IMAGE selects the Foundry image, as it does for the starter. Needs
# docker compose, curl, jq, openssl, node, and tcpdump with sudo for check 3.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STARTER="$ROOT/deploy/starter"
SMOKE="$ROOT/e2e/production-smoke"
WORK="${SMOKE_WORK_DIR:-${RUNNER_TEMP:-/tmp}/starter-production-smoke}"

HOST=foundry.example.com
ORIGIN="https://$HOST"
ISSUER=http://mock-oidc:8080/default
MOCK_HOST_PORT=18080
CLIENT_ID=foundry-starter-smoke
NAMESPACE=ferrum-foundry-demo
OAUTH2_PROXY_PORT=4180

# Values a client must never get past nginx.
SPOOFED_ADDRESS=203.0.113.66
SPOOFED_HOST=spoofed.invalid
SPOOFED_URI=/spoofed/uri
SPOOFED_REQUEST_ID=smoke-spoofed-request-id

fail() {
  echo "::error::$*" >&2
  exit 1
}

step() {
  echo
  echo "== $*"
}

compose() {
  docker compose \
    -f "$STARTER/compose.yaml" \
    -f "$SMOKE/compose.yaml" \
    --profile production "$@"
}

# curl as a browser on the runner: the starter's published port answers for
# foundry.example.com, and the mock provider for its compose-network name, so
# the issuer URL is the one oauth2-proxy uses.
browser() {
  curl --silent --show-error --max-time 20 \
    --cacert "$WORK/ca.crt" \
    --resolve "$HOST:443:127.0.0.1" \
    --connect-to "mock-oidc:8080:127.0.0.1:$MOCK_HOST_PORT" \
    "$@"
}

random_secret() {
  openssl rand -base64 48 | tr -d '\n=+/'
}

# Replaces KEY=... in an operator file copied from its example. A key the
# example does not document is a failure: the smoke test must not invent
# settings an operator would not know to set.
set_env() {
  local file="$1" key="$2" value="$3"
  if ! awk -v key="$key" 'index($0, key "=") == 1 { found = 1 } END { exit !found }' "$file"; then
    fail "$key is not documented in the example $(basename "$file") was copied from"
  fi
  awk -v key="$key" -v value="$value" \
    'index($0, key "=") == 1 { print key "=" value; next } { print }' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

expect_equal() {
  local what="$1" actual="$2" expected="$3"
  if [ "$actual" != "$expected" ]; then
    fail "$what: got '$actual', expected '$expected'"
  fi
  echo "ok: $what"
}

wait_for() {
  local what="$1"
  shift
  for _attempt in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then
      echo "ok: $what"
      return 0
    fi
    sleep 2
  done
  "$@" || true
  fail "timed out waiting for $what"
}

configure() {
  for file in .env oauth2-proxy.env secrets/ferrum-proxy-secret.conf tls/foundry.crt tls/foundry.key; do
    [ ! -e "$STARTER/$file" ] || fail "refusing to overwrite deploy/starter/$file"
  done
  rm -rf "$WORK"
  mkdir -p "$WORK"
  umask 077

  step "Operator files, from the starter's own examples"
  local proxy_secret
  proxy_secret="$(random_secret)"
  cp "$STARTER/.env.example" "$STARTER/.env"
  # FERRUM_ADMIN_URL keeps the example's https origin: the production profile
  # brings no gateway, and nothing here needs one.
  set_env "$STARTER/.env" FERRUM_JWT_SECRET "$(random_secret)"
  set_env "$STARTER/.env" FERRUM_TRUSTED_PROXY_SECRET "$proxy_secret"
  mkdir -p "$STARTER/secrets" "$STARTER/tls"
  # shellcheck disable=SC2016 # an nginx variable, written literally
  printf 'set $ferrum_proxy_secret "%s";\n' "$proxy_secret" > "$STARTER/secrets/ferrum-proxy-secret.conf"

  cp "$STARTER/oauth2-proxy.env.example" "$STARTER/oauth2-proxy.env"
  set_env "$STARTER/oauth2-proxy.env" OAUTH2_PROXY_OIDC_ISSUER_URL "$ISSUER"
  set_env "$STARTER/oauth2-proxy.env" OAUTH2_PROXY_CLIENT_ID "$CLIENT_ID"
  set_env "$STARTER/oauth2-proxy.env" OAUTH2_PROXY_CLIENT_SECRET "$(random_secret)"
  # 32 bytes, as oauth2-proxy requires for an AES-256 cookie cipher.
  set_env "$STARTER/oauth2-proxy.env" OAUTH2_PROXY_COOKIE_SECRET "$(openssl rand -hex 16)"
  echo "ok: .env, oauth2-proxy.env, secrets/ferrum-proxy-secret.conf"

  step "Test-only TLS for $HOST"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
    -subj "/CN=Starter production smoke test CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -subj "/CN=$HOST" \
    -keyout "$STARTER/tls/foundry.key" -out "$WORK/foundry.csr" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\n' \
    "$HOST" > "$WORK/foundry.ext"
  openssl x509 -req -days 2 -in "$WORK/foundry.csr" \
    -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial \
    -extfile "$WORK/foundry.ext" -out "$STARTER/tls/foundry.crt" 2>/dev/null
  openssl verify -CAfile "$WORK/ca.crt" "$STARTER/tls/foundry.crt"
}

start_redirect_is_ready() {
  local status
  status="$(browser -o /dev/null -w '%{http_code}' "$ORIGIN/oauth2/start")"
  [ "$status" = 302 ]
}

up() {
  [ -s "$STARTER/.env" ] || fail "run configure first"
  step "Mock OIDC provider"
  compose up --detach mock-oidc
  wait_for "the provider's discovery document" \
    browser --fail -o /dev/null "$ISSUER/.well-known/openid-configuration"

  step "Production profile"
  compose up --detach --wait --wait-timeout 180
  wait_for "oauth2-proxy behind nginx" start_redirect_is_ready
  compose ps --all
}

# Prints "<status> <location>" for one request; extra arguments go to curl.
status_and_location() {
  browser -o /dev/null -w '%{http_code} %{redirect_url}' "$@"
}

# Logs in through oauth2-proxy and the mock provider with a fresh cookie jar.
# Prints the callback's "<status> <location>".
login() {
  local jar="$1" username="$2" email="$3" groups="$4"
  local result status authorize_url page claims callback_url
  rm -f "$jar"

  result="$(status_and_location -c "$jar" -b "$jar" "$ORIGIN/oauth2/start?rd=%2F")"
  read -r status authorize_url <<<"$result"
  [ "$status" = 302 ] || fail "login $username: /oauth2/start answered $status"
  case "$authorize_url" in
    "$AUTHORIZE_ENDPOINT?"*) ;;
    *) fail "login $username: /oauth2/start sent the browser to '$authorize_url'" ;;
  esac

  page="$(browser --fail "$authorize_url")"
  grep -q 'name="username"' <<<"$page" || fail "login $username: the provider served no login form"

  claims="$(jq -cn --arg email "$email" --argjson groups "$groups" \
    '{email: $email, email_verified: true, groups: $groups}')"
  result="$(status_and_location \
    --data-urlencode "username=$username" \
    --data-urlencode "claims=$claims" \
    "$authorize_url")"
  read -r status callback_url <<<"$result"
  [ "$status" = 302 ] || fail "login $username: the provider answered the login with $status"
  case "$callback_url" in
    "$ORIGIN/oauth2/callback?"*) ;;
    *) fail "login $username: the provider redirected to '$callback_url'" ;;
  esac

  status_and_location -c "$jar" -b "$jar" "$callback_url"
}

session_field() {
  local jar="$1" filter="$2"
  shift 2
  browser --fail -b "$jar" "$@" "$ORIGIN/api/auth/session" | jq -c "$filter"
}

# The forwarded headers a client sends to try to steer oauth2-proxy, plus the
# identity headers it sends to try to steer Foundry.
SPOOF_HEADERS=(
  -H "X-Forwarded-For: $SPOOFED_ADDRESS"
  -H "X-Real-IP: $SPOOFED_ADDRESS"
  -H "X-Forwarded-Host: $SPOOFED_HOST"
  -H "X-Forwarded-Proto: http"
  -H "X-Forwarded-Uri: $SPOOFED_URI"
  -H "X-Auth-Request-Redirect: https://$SPOOFED_HOST/after-login"
  -H "X-Request-Id: $SPOOFED_REQUEST_ID"
  -H "X-Forwarded-User: spoofed-user@example.com"
  -H "X-Ferrum-Role: admin"
  -H "X-Ferrum-Namespaces: spoofed-namespace"
  -H "X-Ferrum-Auth-Secret: spoofed-proof-secret-at-least-32-characters"
  -H "X-Auth-Request-User: spoofed-user@example.com"
  -H "X-Auth-Request-Groups: ferrum-admins"
)

start_capture() {
  if ! command -v tcpdump >/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq tcpdump
  fi
  # Pipe through cat so the file is written by this user, not by tcpdump
  # (which drops privileges and is confined by AppArmor on Ubuntu).
  sudo tcpdump -i any -U -s 0 -w - "tcp port $OAUTH2_PROXY_PORT" \
    2>"$WORK/tcpdump.log" | cat > "$WORK/oauth2-proxy.pcap" &
  CAPTURE_PID=$!
  for _attempt in $(seq 1 50); do
    if grep -q 'listening on' "$WORK/tcpdump.log" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  cat "$WORK/tcpdump.log" >&2 || true
  fail "tcpdump did not start"
}

stop_capture() {
  # Let nginx finish writing the last request before the capture stops.
  sleep 1
  sudo pkill -INT -x tcpdump || true
  wait "$CAPTURE_PID" || true
  cat "$WORK/tcpdump.log"
}

verify() {
  local result status location body anon_jar admin_jar viewer_jar unmapped_jar

  step "The provider"
  AUTHORIZE_ENDPOINT="$(browser --fail "$ISSUER/.well-known/openid-configuration" | jq -r .authorization_endpoint)"
  expect_equal "authorization endpoint" "$AUTHORIZE_ENDPOINT" "$ISSUER/authorize"

  step "1. Unauthenticated requests"
  result="$(status_and_location "$ORIGIN/")"
  read -r status location <<<"$result"
  expect_equal "page load status" "$status" 302
  expect_equal "page load redirect" "$location" "$ORIGIN/oauth2/start?rd=/"

  anon_jar="$WORK/anonymous.jar"
  result="$(status_and_location -c "$anon_jar" -b "$anon_jar" "$location")"
  read -r status location <<<"$result"
  expect_equal "/oauth2/start status" "$status" 302
  case "$location" in
    "$AUTHORIZE_ENDPOINT?"*) echo "ok: /oauth2/start redirects to the provider's authorize endpoint" ;;
    *) fail "/oauth2/start redirected to '$location', not $AUTHORIZE_ENDPOINT" ;;
  esac
  for parameter in "client_id=$CLIENT_ID" "response_type=code" \
    "redirect_uri=https%3A%2F%2F$HOST%2Foauth2%2Fcallback"; do
    case "$location" in
      *[?\&]"$parameter"*) echo "ok: authorize request carries $parameter" ;;
      *) fail "authorize request lacks $parameter: $location" ;;
    esac
  done

  status="$(browser -o /dev/null -w '%{http_code}' "$ORIGIN/api/auth/session")"
  expect_equal "unauthenticated API status (no sign-in redirect)" "$status" 401

  step "2. Logins through the provider"
  admin_jar="$WORK/admin.jar"
  result="$(login "$admin_jar" smoke-admin smoke-admin@example.com '["ferrum-admins"]')"
  expect_equal "admin login callback" "$result" "302 $ORIGIN/"
  status="$(browser -o /dev/null -w '%{http_code} %{content_type}' -b "$admin_jar" "$ORIGIN/")"
  case "$status" in
    "200 text/html"*) echo "ok: an authenticated page load reaches Foundry" ;;
    *) fail "authenticated page load answered '$status'" ;;
  esac
  # oauth2-proxy's user is the email claim (its default --user-id-claim), and
  # the shared policy maps ferrum-admins to admin on the configured namespace.
  expect_equal "admin principal" \
    "$(session_field "$admin_jar" '.principal | [.subject, .role, .namespaces, .authMode]')" \
    "[\"smoke-admin@example.com\",\"admin\",[\"$NAMESPACE\"],\"trusted-proxy\"]"

  viewer_jar="$WORK/viewer.jar"
  # A user in several groups, the Ferrum one not first: oauth2-proxy joins
  # them with commas, which is what the policy's patterns expect.
  result="$(login "$viewer_jar" smoke-viewer smoke-viewer@example.com '["contractors","ferrum-viewers"]')"
  expect_equal "viewer login callback" "$result" "302 $ORIGIN/"
  expect_equal "viewer principal" \
    "$(session_field "$viewer_jar" '.principal | [.subject, .role, .namespaces]')" \
    "[\"smoke-viewer@example.com\",\"viewer\",[\"$NAMESPACE\"]]"

  unmapped_jar="$WORK/unmapped.jar"
  result="$(login "$unmapped_jar" smoke-contractor smoke-contractor@example.com '["contractors"]')"
  read -r status location <<<"$result"
  expect_equal "login by a user in no Ferrum group (--allowed-group)" "$status" 403
  result="$(status_and_location -b "$unmapped_jar" "$ORIGIN/")"
  expect_equal "refused user's next page load" "$result" "302 $ORIGIN/oauth2/start?rd=/"

  step "3. Forwarded headers, read off the wire between nginx and oauth2-proxy"
  start_capture
  status="$(browser -o /dev/null -w '%{http_code}' -c "$anon_jar" -b "$anon_jar" \
    "${SPOOF_HEADERS[@]}" -H 'X-Smoke-Probe: start' "$ORIGIN/oauth2/start?rd=%2F")"
  expect_equal "spoofed /oauth2/start status" "$status" 302
  status="$(browser -o /dev/null -w '%{http_code}' \
    "${SPOOF_HEADERS[@]}" -H 'X-Smoke-Probe: auth-anonymous' "$ORIGIN/smoke/anonymous")"
  expect_equal "spoofed unauthenticated page load status" "$status" 302
  body="$(browser --fail -b "$viewer_jar" \
    "${SPOOF_HEADERS[@]}" -H 'X-Smoke-Probe: auth-session' "$ORIGIN/api/auth/session")"
  stop_capture

  # inject.conf replaces every identity header, so the viewer stays a viewer
  # whatever the client claims.
  expect_equal "viewer principal under spoofed identity headers" \
    "$(jq -c '.principal | [.subject, .role, .namespaces, .authMode]' <<<"$body")" \
    "[\"smoke-viewer@example.com\",\"viewer\",[\"$NAMESPACE\"],\"trusted-proxy\"]"

  jq -n \
    --argjson port "$OAUTH2_PROXY_PORT" \
    --arg host "$HOST" \
    --arg address "$SPOOFED_ADDRESS" \
    --arg spoofed_host "$SPOOFED_HOST" \
    --arg uri "$SPOOFED_URI" \
    --arg request_id "$SPOOFED_REQUEST_ID" \
    '{
      port: $port,
      host: $host,
      proto: "https",
      spoofs: [$address, $spoofed_host, $uri, $request_id],
      probes: [
        {id: "start", path: "/oauth2/start", uri: "/oauth2/start?rd=%2F"},
        {id: "auth-anonymous", path: "/oauth2/auth", uri: "/smoke/anonymous"},
        {id: "auth-session", path: "/oauth2/auth", uri: "/api/auth/session"}
      ]
    }' > "$WORK/expectations.json"
  node "$SMOKE/forwarded-headers.mjs" "$WORK/oauth2-proxy.pcap" "$WORK/expectations.json"

  # oauth2-proxy's own request log is a second witness: it records the client
  # address (X-Real-IP) and host (X-Forwarded-Host) it trusted, and would name
  # a spoofed redirect it rejected.
  if compose logs --no-color oauth2-proxy | grep -F -e "$SPOOFED_ADDRESS" -e "$SPOOFED_HOST"; then
    fail "oauth2-proxy logged a spoofed client address, host, or redirect"
  fi
  echo "ok: oauth2-proxy's log names no spoofed address, host, or redirect"

  echo
  echo "Production profile smoke test passed."
}

logs() {
  compose ps --all || true
  compose logs --no-color --timestamps || true
  [ ! -s "$WORK/tcpdump.log" ] || cat "$WORK/tcpdump.log"
}

down() {
  compose down --volumes
}

case "${1:-}" in
  configure) configure ;;
  up) up ;;
  verify) verify ;;
  logs) logs ;;
  down) down ;;
  *) fail "usage: $0 configure|up|verify|logs|down" ;;
esac
