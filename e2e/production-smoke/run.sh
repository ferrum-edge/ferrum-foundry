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
#      the /oauth2/auth subrequest, clears X-Auth-Request-Redirect on the
#      subrequest and the BFF's proof secret and identity headers on both
#      routes, sets or clears every X-Forwarded-* header and the redirect
#      header it sends Foundry, sends its own X-Request-Id to both, and a
#      client's spoofed values reach neither oauth2-proxy nor Foundry;
#   4. oauth2-proxy believes forged X-Forwarded-* headers sent to it directly
#      from inside the stack's network (--trusted-proxy-ip) and ignores the
#      same headers from a network outside that range.
#
# Every login uses PKCE: checks 1 and 2 require an S256 code_challenge on the
# authorize redirect, and check 2 reads the admin login's token request off
# the wire and requires the code_verifier that challenge was computed from.
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
# FOUNDRY_IMAGE selects the Foundry image, as it does for the starter, and
# FOUNDRY_STARTER_SUBNET its network, from the shell or the starter's .env as
# Compose resolves it. Needs docker compose, curl, jq, openssl, node, and
# tcpdump with sudo for checks 2 and 3.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STARTER="$ROOT/deploy/starter"
SMOKE="$ROOT/e2e/production-smoke"
WORK="${SMOKE_WORK_DIR:-${RUNNER_TEMP:-/tmp}/starter-production-smoke}"

HOST=foundry.example.com
ORIGIN="https://$HOST"
ISSUER=http://mock-oidc:8080/default
MOCK_HOST_PORT=18080
MOCK_PORT=8080
TOKEN_PATH=/default/token
CLIENT_ID=foundry-starter-smoke
NAMESPACE=ferrum-foundry-demo
OAUTH2_PROXY_PORT=4180
FOUNDRY_PORT=8080
# A network outside the trusted range, for check 4 only. run.sh creates and
# removes it; Docker allocates its subnet, which check 4 proves is disjoint
# from the stack's.
OUTSIDE_NETWORK=foundry-smoke-outside

# Values a client must never get past nginx.
SPOOFED_ADDRESS=203.0.113.66
SPOOFED_HOST=spoofed.invalid
SPOOFED_URI=/spoofed/uri
SPOOFED_REQUEST_ID=smoke-spoofed-request-id
# Every identity value a probe claims carries one of these markers, so the wire
# check can recognise it wherever it lands. (The role is an enum and cannot;
# the session check below proves the client's role is ignored.)
SPOOFED_USER=spoofed-user
SPOOFED_GROUP=spoofed-group
SPOOFED_NAMESPACE=spoofed-namespace
SPOOFED_SECRET=spoofed-proof-secret
# Check 4's forged values, one set per side of the trust boundary.
TRUSTED_PROBE="trusted-probe"
TRUSTED_PROBE_ADDRESS=198.51.100.10
OUTSIDE_PROBE="outside-probe"
OUTSIDE_PROBE_ADDRESS=198.51.100.20

fail() {
  echo "::error::$*" >&2
  exit 1
}

# shellcheck source=e2e/production-smoke/lib.sh
. "$SMOKE/lib.sh"

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
  # An operator's shell asking for plain cookies must not reach the
  # production BFF: compose.yaml fixes them Secure (verify checks the
  # cookies it issues).
  FERRUM_SECURE_COOKIES=false compose up --detach --wait --wait-timeout 180
  wait_for "oauth2-proxy behind nginx" start_redirect_is_ready
  compose ps --all
}

# Prints "<status> <location>" for one request; extra arguments go to curl.
status_and_location() {
  browser -o /dev/null -w '%{http_code} %{redirect_url}' "$@"
}

# Prints the S256 code_challenge of an authorize URL, failing unless the URL
# carries exactly one code_challenge_method=S256 and one well-formed challenge.
code_challenge_of() {
  local url="$1" what="$2" methods challenges
  methods="$(jq -rn --arg url "$url" \
    '[$url | scan("[?&]code_challenge_method=([^&]*)") | .[0]] | join(",")')"
  [ "$methods" = S256 ] || fail "$what: the authorize redirect's code_challenge_method is '$methods', not S256"
  challenges="$(jq -rn --arg url "$url" '[$url | scan("[?&]code_challenge=([^&]*)") | .[0]] | join(",")')"
  [[ "$challenges" =~ ^[A-Za-z0-9_-]{43}$ ]] ||
    fail "$what: the authorize redirect carries no single S256 code_challenge ('$challenges')"
  printf '%s\n' "$challenges"
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
  # Every login carries its own S256 challenge; kept for the token-request check.
  code_challenge_of "$authorize_url" "login $username" > "$jar.challenge"

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
# identity headers (Foundry's and oauth2-proxy's) it sends to try to steer
# Foundry or leak the BFF proof secret to oauth2-proxy.
SPOOF_HEADERS=(
  -H "X-Forwarded-For: $SPOOFED_ADDRESS"
  -H "X-Real-IP: $SPOOFED_ADDRESS"
  -H "X-Forwarded-Host: $SPOOFED_HOST"
  -H "X-Forwarded-Proto: http"
  -H "X-Forwarded-Uri: $SPOOFED_URI"
  -H "X-Auth-Request-Redirect: https://$SPOOFED_HOST/after-login"
  -H "X-Request-Id: $SPOOFED_REQUEST_ID"
  -H "X-Forwarded-User: $SPOOFED_USER@example.com"
  -H "X-Ferrum-Role: admin"
  -H "X-Ferrum-Namespaces: $SPOOFED_NAMESPACE"
  -H "X-Ferrum-Auth-Secret: $SPOOFED_SECRET-at-least-32-characters"
  -H "X-Auth-Request-User: $SPOOFED_USER@example.com"
  -H "X-Auth-Request-Email: $SPOOFED_USER@example.com"
  -H "X-Auth-Request-Preferred-Username: $SPOOFED_USER"
  -H "X-Auth-Request-Groups: ferrum-admins,$SPOOFED_GROUP"
)

ensure_tcpdump() {
  if ! command -v tcpdump >/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq tcpdump
  fi
}

verify() {
  local result status location body anon_jar admin_jar viewer_jar unmapped_jar discovery
  local anonymous_challenge

  step "The provider"
  discovery="$(browser --fail "$ISSUER/.well-known/openid-configuration")"
  AUTHORIZE_ENDPOINT="$(jq -r .authorization_endpoint <<<"$discovery")"
  expect_equal "authorization endpoint" "$AUTHORIZE_ENDPOINT" "$ISSUER/authorize"
  expect_equal "token endpoint" "$(jq -r .token_endpoint <<<"$discovery")" \
    "http://mock-oidc:$MOCK_PORT$TOKEN_PATH"

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
  # PKCE (OAUTH2_PROXY_CODE_CHALLENGE_METHOD=S256 in oauth2-proxy.env.example).
  anonymous_challenge="$(code_challenge_of "$location" "/oauth2/start")"
  echo "ok: authorize request carries code_challenge_method=S256 and an S256 code_challenge"

  status="$(browser -o /dev/null -w '%{http_code}' "$ORIGIN/api/auth/session")"
  expect_equal "unauthenticated API status (no sign-in redirect)" "$status" 401

  step "2. Logins through the provider"
  ensure_tcpdump
  admin_jar="$WORK/admin.jar"
  # The token request oauth2-proxy sends the provider during this login is
  # read off the wire (port $MOCK_PORT on the compose network). The capture
  # holds this run's throwaway client secret and code; it is never printed.
  capture_start "tcp port $MOCK_PORT" "$WORK/login.pcap" "$WORK/tcpdump-login.log"
  result="$(login "$admin_jar" smoke-admin smoke-admin@example.com '["ferrum-admins"]')"
  sleep 1
  capture_stop
  cat "$WORK/tcpdump-login.log"
  expect_equal "admin login callback" "$result" "302 $ORIGIN/"
  # A completed login is itself evidence: the mock provider refuses a token
  # request whose code_verifier is missing or does not match the challenge.
  node "$SMOKE/pkce.mjs" "$WORK/login.pcap" "$MOCK_PORT" "$TOKEN_PATH" "$(cat "$admin_jar.challenge")"
  status="$(browser -o /dev/null -w '%{http_code} %{content_type}' -b "$admin_jar" "$ORIGIN/")"
  case "$status" in
    "200 text/html"*) echo "ok: an authenticated page load reaches Foundry" ;;
    *) fail "authenticated page load answered '$status'" ;;
  esac
  # Foundry's actor is oauth2-proxy's user, which is the ID token's `sub`
  # (the login's username), not its email; the shared policy maps
  # ferrum-admins to admin on the configured namespace.
  expect_equal "admin principal" \
    "$(session_field "$admin_jar" '.principal | [.subject, .role, .namespaces, .authMode]')" \
    "[\"smoke-admin\",\"admin\",[\"$NAMESPACE\"],\"trusted-proxy\"]"
  # Behind the identity proxy Foundry's only cookie is its CSRF token (the
  # proxy owns the session). On the production profile it is Secure and
  # __Host-, although `up` ran with FERRUM_SECURE_COOKIES=false exported.
  cookies="$(browser -o /dev/null -D - -b "$admin_jar" "$ORIGIN/api/auth/session" | tr -d '\r' | grep -i '^set-cookie:' || true)"
  line="$(grep -i '^set-cookie: __Host-ferrum-foundry-csrf=' <<<"$cookies" || true)"
  [ -n "$line" ] || fail "the production BFF issued no __Host-ferrum-foundry-csrf cookie ($(cut -d= -f1 <<<"$cookies" | tr '\n' ' '))"
  grep -qi '; *secure\(;\|$\)' <<<"$line" || fail "the production BFF issued its CSRF cookie without Secure"
  echo "ok: the production BFF issues its CSRF cookie Secure and __Host-"

  viewer_jar="$WORK/viewer.jar"
  # A user in several groups, the Ferrum one not first: oauth2-proxy joins
  # them with commas, which is what the policy's patterns expect.
  result="$(login "$viewer_jar" smoke-viewer smoke-viewer@example.com '["contractors","ferrum-viewers"]')"
  expect_equal "viewer login callback" "$result" "302 $ORIGIN/"
  for challenge in "$anonymous_challenge" "$(cat "$admin_jar.challenge")"; do
    [ "$(cat "$viewer_jar.challenge")" != "$challenge" ] ||
      fail "two logins sent the same code_challenge; each needs its own verifier"
  done
  echo "ok: each login sent its own code_challenge"
  expect_equal "viewer principal" \
    "$(session_field "$viewer_jar" '.principal | [.subject, .role, .namespaces]')" \
    "[\"smoke-viewer\",\"viewer\",[\"$NAMESPACE\"]]"

  unmapped_jar="$WORK/unmapped.jar"
  result="$(login "$unmapped_jar" smoke-contractor smoke-contractor@example.com '["contractors"]')"
  read -r status location <<<"$result"
  expect_equal "login by a user in no Ferrum group (--allowed-group)" "$status" 403
  result="$(status_and_location -b "$unmapped_jar" "$ORIGIN/")"
  expect_equal "refused user's next page load" "$result" "302 $ORIGIN/oauth2/start?rd=/"

  step "3. Forwarded headers, read off the wire between nginx and its upstreams"
  # The capture holds this run's throwaway proof secret and session cookies; it
  # stays in the work directory and is never uploaded or printed.
  capture_start "tcp port $OAUTH2_PROXY_PORT or tcp port $FOUNDRY_PORT" \
    "$WORK/upstreams.pcap" "$WORK/tcpdump.log"
  status="$(browser -o /dev/null -w '%{http_code}' -c "$anon_jar" -b "$anon_jar" \
    "${SPOOF_HEADERS[@]}" -H 'X-Smoke-Probe: start' "$ORIGIN/oauth2/start?rd=%2F")"
  expect_equal "spoofed /oauth2/start status" "$status" 302
  status="$(browser -o /dev/null -w '%{http_code}' \
    "${SPOOF_HEADERS[@]}" -H 'X-Smoke-Probe: auth-anonymous' "$ORIGIN/smoke/anonymous")"
  expect_equal "spoofed unauthenticated page load status" "$status" 302
  body="$(browser --fail -b "$viewer_jar" \
    "${SPOOF_HEADERS[@]}" -H 'X-Smoke-Probe: auth-session' "$ORIGIN/api/auth/session")"
  # Let nginx finish writing the last request before the capture stops.
  sleep 1
  capture_stop
  cat "$WORK/tcpdump.log"

  # inject.conf replaces every identity header, so the viewer stays a viewer
  # whatever the client claims.
  expect_equal "viewer principal under spoofed identity headers" \
    "$(jq -c '.principal | [.subject, .role, .namespaces, .authMode]' <<<"$body")" \
    "[\"smoke-viewer\",\"viewer\",[\"$NAMESPACE\"],\"trusted-proxy\"]"

  jq -n \
    --argjson port "$OAUTH2_PROXY_PORT" \
    --argjson foundry_port "$FOUNDRY_PORT" \
    --arg host "$HOST" \
    --arg address "$SPOOFED_ADDRESS" \
    --arg spoofed_host "$SPOOFED_HOST" \
    --arg uri "$SPOOFED_URI" \
    --arg request_id "$SPOOFED_REQUEST_ID" \
    --arg user "$SPOOFED_USER" \
    --arg group "$SPOOFED_GROUP" \
    --arg namespace "$SPOOFED_NAMESPACE" \
    --arg secret "$SPOOFED_SECRET" \
    '{
      port: $port,
      host: $host,
      proto: "https",
      spoofs: [$address, $spoofed_host, $uri, $request_id, $user, $group, $namespace, $secret],
      probes: [
        {id: "start", path: "/oauth2/start", uri: "/oauth2/start?rd=%2F"},
        {id: "auth-anonymous", path: "/oauth2/auth", uri: "/smoke/anonymous"},
        {id: "auth-session", path: "/oauth2/auth", uri: "/api/auth/session"},
        {id: "foundry-session", marker: "auth-session", upstream: "foundry",
         port: $foundry_port, path: "/api/auth/session"}
      ]
    }' > "$WORK/expectations.json"
  node "$SMOKE/forwarded-headers.mjs" "$WORK/upstreams.pcap" "$WORK/expectations.json"

  # oauth2-proxy's own request log is a second witness: it records the client
  # address (X-Real-IP), host (X-Forwarded-Host), and request ID (X-Request-Id)
  # it trusted, and would name a spoofed redirect it rejected.
  # A log that cannot be read fails rather than passing as clean.
  read_log "oauth2-proxy's log" "$WORK/oauth2-proxy.log" compose logs --no-color oauth2-proxy
  log_names_none "oauth2-proxy's log" "$WORK/oauth2-proxy.log" \
    "$SPOOFED_ADDRESS" "$SPOOFED_HOST" "$SPOOFED_REQUEST_ID" "$SPOOFED_SECRET"
  # The BFF trusts X-Forwarded-* from nginx and logs the host it resolves, so
  # its log is a witness that nginx set X-Forwarded-Host itself.
  read_log "Foundry's log" "$WORK/foundry.log" compose logs --no-color foundry
  log_names_none "Foundry's log" "$WORK/foundry.log" "$SPOOFED_HOST"

  trust_boundary

  echo
  echo "Production profile smoke test passed."
}

# Asks oauth2-proxy, directly from a container on `network`, to start a login
# while forging X-Forwarded-Host, X-Forwarded-Uri and X-Real-IP. Prints
# direct-probe.mjs's {"status", "redirect"} line.
direct_probe() {
  local image="$1" network="$2" address="$3" name="$4" client_address="$5"
  docker run --rm --network "$network" --volume "$SMOKE:/smoke:ro" "$image" \
    /smoke/direct-probe.mjs "$address" "$OAUTH2_PROXY_PORT" "$HOST" \
    "$name.invalid" "/$name" "$client_address"
}

# The address `container` has on `network`.
address_on() {
  docker inspect "$1" | jq -r --arg network "$2" '.[0].NetworkSettings.Networks[$network].IPAddress // empty'
}

# 4. oauth2-proxy trusts X-Forwarded-* only from the stack's own subnet.
trust_boundary() {
  local oauth2_proxy image networks network subnet trusted address result
  local rendered expected outside_subnet
  step "4. oauth2-proxy believes X-Forwarded-* only from the stack's network"
  oauth2_proxy="$(compose ps -q oauth2-proxy)"
  [ -n "$oauth2_proxy" ] || fail "oauth2-proxy is not running"
  # The probes run the Foundry image under test, for its Node.
  image="$(docker inspect -f '{{.Image}}' "$(compose ps -q foundry)")"

  networks="$(docker inspect "$oauth2_proxy" | jq -r '.[0].NetworkSettings.Networks | keys | join(" ")')"
  case "$networks" in
    "" | *" "*) fail "oauth2-proxy should be on exactly one network, found '$networks'" ;;
  esac
  network="$networks"
  # What the stack should run with: Compose's own resolution of
  # FOUNDRY_STARTER_SUBNET (the shell, then the starter's .env, then
  # compose.yaml's default), from the same files and profile as `up`.
  rendered="$(compose config --format json)"
  expected="$(rendered_subnets <<<"$rendered")"
  case "$expected" in
    "" | *" "*) fail "the rendered configuration should give the default network one subnet, found '$expected'" ;;
  esac
  echo "Compose resolves the stack's subnet to $expected"
  expect_equal "--trusted-proxy-ip in the rendered configuration" \
    "$(rendered_trusted_proxy_ips <<<"$rendered")" "$expected"
  subnet="$(docker network inspect "$network" | jq -r '[.[0].IPAM.Config[].Subnet] | join(" ")')"
  expect_equal "the running network's subnet" "$subnet" "$expected"
  trusted="$(docker inspect "$oauth2_proxy" |
    jq -r '[.[0].Args[] | select(startswith("--trusted-proxy-ip=")) | ltrimstr("--trusted-proxy-ip=")] | join(" ")')"
  expect_equal "oauth2-proxy's --trusted-proxy-ip" "$trusted" "$subnet"
  expect_equal "oauth2-proxy's --reverse-proxy" \
    "$(docker inspect "$oauth2_proxy" | jq -r '[.[0].Args[] | select(. == "--reverse-proxy=true")] | length')" 1

  # Inside the range: the positive control. A peer oauth2-proxy trusts gets its
  # forged X-Forwarded-Uri as the post-login redirect, and its forged host and
  # client address in oauth2-proxy's request log.
  address="$(address_on "$oauth2_proxy" "$network")"
  [ -n "$address" ] || fail "oauth2-proxy has no address on $network"
  result="$(direct_probe "$image" "$network" "$address" "$TRUSTED_PROBE" "$TRUSTED_PROBE_ADDRESS")"
  echo "inside $subnet: $result"
  expect_equal "status of a direct /oauth2/start from inside the range" "$(jq -r .status <<<"$result")" 302
  expect_equal "post-login redirect taken from a trusted peer's X-Forwarded-Uri" \
    "$(jq -r .redirect <<<"$result")" "/$TRUSTED_PROBE"

  # Outside the range: oauth2-proxy is attached to a second network for this
  # probe only, as if a deployment had exposed it. The same forged headers
  # must change nothing: the redirect is the default "/".
  docker network rm "$OUTSIDE_NETWORK" >/dev/null 2>&1 || true
  docker network create "$OUTSIDE_NETWORK" >/dev/null ||
    fail "Docker could not allocate a subnet for $OUTSIDE_NETWORK (are its address pools exhausted?)"
  outside_subnet="$(docker network inspect "$OUTSIDE_NETWORK" |
    jq -r '[.[0].IPAM.Config[].Subnet | select(contains(":") | not)] | join(" ")')"
  case "$outside_subnet" in
    "" | *" "*) fail "$OUTSIDE_NETWORK should have one IPv4 subnet, found '$outside_subnet'" ;;
  esac
  if ipv4_cidrs_overlap "$outside_subnet" "$subnet"; then
    fail "Docker gave $OUTSIDE_NETWORK $outside_subnet, which overlaps the trusted range $subnet; the probe would not be outside it"
  fi
  echo "ok: $OUTSIDE_NETWORK's $outside_subnet is disjoint from the trusted range $subnet"
  docker network connect "$OUTSIDE_NETWORK" "$oauth2_proxy"
  address="$(address_on "$oauth2_proxy" "$OUTSIDE_NETWORK")"
  [ -n "$address" ] || fail "oauth2-proxy has no address on $OUTSIDE_NETWORK"
  result="$(direct_probe "$image" "$OUTSIDE_NETWORK" "$address" "$OUTSIDE_PROBE" "$OUTSIDE_PROBE_ADDRESS")"
  docker network disconnect "$OUTSIDE_NETWORK" "$oauth2_proxy"
  echo "outside, from $outside_subnet: $result"
  expect_equal "status of a direct /oauth2/start from outside the range" "$(jq -r .status <<<"$result")" 302
  expect_equal "post-login redirect for an untrusted peer (its X-Forwarded-Uri ignored)" \
    "$(jq -r .redirect <<<"$result")" "/"

  # oauth2-proxy's request log names the host (X-Forwarded-Host) and client
  # (X-Real-IP) it believed: the trusted probe's forgeries, never the other's.
  read_log "oauth2-proxy's log" "$WORK/oauth2-proxy-trust.log" compose logs --no-color oauth2-proxy
  for value in "$TRUSTED_PROBE.invalid" "$TRUSTED_PROBE_ADDRESS"; do
    grep -qF -- "$value" "$WORK/oauth2-proxy-trust.log" ||
      fail "oauth2-proxy's log does not name the trusted probe's forged $value; the positive control proves nothing"
  done
  echo "ok: oauth2-proxy's log names the trusted probe's forged host and address"
  log_names_none "oauth2-proxy's log (the untrusted probe)" "$WORK/oauth2-proxy-trust.log" \
    "$OUTSIDE_PROBE.invalid" "$OUTSIDE_PROBE_ADDRESS"
}

logs() {
  compose ps --all || true
  compose logs --no-color --timestamps || true
  [ ! -s "$WORK/tcpdump.log" ] || cat "$WORK/tcpdump.log"
}

down() {
  compose down --volumes
  docker network rm "$OUTSIDE_NETWORK" >/dev/null 2>&1 || true
}

case "${1:-}" in
  configure) configure ;;
  up) up ;;
  verify) verify ;;
  logs) logs ;;
  down) down ;;
  *) fail "usage: $0 configure|up|verify|logs|down" ;;
esac
