# shellcheck shell=bash
# ------------------------------------------------------------------
# Helpers for run.sh: the packet capture and the log witnesses
# ------------------------------------------------------------------
#
# Sourced by run.sh, and by scripts/starter-production-smoke.test.mjs, which
# drives them with a stand-in for tcpdump. The caller defines `fail`.
#
# SMOKE_CAPTURE_SUDO   how to run the capture tool and signal it (default sudo)
# SMOKE_CAPTURE_TOOL   the capture tool (default tcpdump)

CAPTURE_WRITER_PID=""
CAPTURE_PIDFILE=""

# Starts capturing `filter` into `pcap`, with tcpdump's stderr in `log`.
#
# tcpdump runs under sudo, so this records tcpdump's own PID (the shell that
# execs it writes $$ first) and signals only that process later, never every
# tcpdump on the host. Its output goes through cat, so the file is written by
# this user rather than by tcpdump, which drops privileges and is confined by
# AppArmor on Ubuntu. Until capture_stop runs, an EXIT trap stops and reaps the
# capture whatever ends the script, keeping the script's exit status.
capture_start() {
  local filter="$1" pcap="$2" log="$3"
  local sudo="${SMOKE_CAPTURE_SUDO:-sudo}" tool="${SMOKE_CAPTURE_TOOL:-tcpdump}"
  CAPTURE_PIDFILE="$pcap.pid"
  rm -f "$CAPTURE_PIDFILE" "$log"
  # shellcheck disable=SC2016 # $$, $0 and $@ belong to the inner shell
  $sudo sh -c 'echo "$$" > "$0"; exec "$@"' "$CAPTURE_PIDFILE" \
    "$tool" -i any -U -s 0 -w - "$filter" 2>"$log" | cat > "$pcap" &
  CAPTURE_WRITER_PID=$!
  trap capture_on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  for _attempt in $(seq 1 50); do
    if [ -s "$CAPTURE_PIDFILE" ] && grep -q 'listening on' "$log" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  cat "$log" >&2 || true
  fail "$tool did not start"
}

# Stops the capture this script started and waits until its output is
# written. Safe to call when nothing is running.
capture_stop() {
  [ -n "$CAPTURE_WRITER_PID" ] || return 0
  local sudo="${SMOKE_CAPTURE_SUDO:-sudo}" pid
  pid="$(cat "$CAPTURE_PIDFILE" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    $sudo kill -INT "$pid" 2>/dev/null || true
    # The writer finishes when the tool closes its output.
    for _attempt in $(seq 1 50); do
      kill -0 "$CAPTURE_WRITER_PID" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$CAPTURE_WRITER_PID" 2>/dev/null; then
      $sudo kill -TERM "$pid" 2>/dev/null || true
    fi
  fi
  wait "$CAPTURE_WRITER_PID" 2>/dev/null || true
  CAPTURE_WRITER_PID=""
  trap - EXIT INT TERM
}

capture_on_exit() {
  local status=$?
  capture_stop
  exit "$status"
}

# Runs `command...` and saves its output in `file`. Fails if the command fails
# or prints nothing, so an unreadable log is never mistaken for a clean one.
read_log() {
  local label="$1" file="$2"
  shift 2
  if ! "$@" > "$file"; then
    fail "could not read $label"
  fi
  [ -s "$file" ] || fail "$label is empty"
}

# Fails if `file` contains any of the fixed strings `pattern...`.
log_names_none() {
  local label="$1" file="$2"
  shift 2
  local args=()
  for pattern in "$@"; do args+=(-e "$pattern"); done
  if grep -F "${args[@]}" -- "$file"; then
    fail "$label names a spoofed value"
  fi
  echo "ok: $label names no spoofed value"
}

# ---- the trust boundary (check 4) --------------------------------------------

# The default network's subnet(s) in a rendered Compose configuration
# (`docker compose config --format json` on stdin), space-separated. Compose
# has already resolved FOUNDRY_STARTER_SUBNET there, from the shell or from the
# starter's .env, so this is the value the stack runs with.
rendered_subnets() {
  jq -r '[.networks.default.ipam.config[]?.subnet // empty] | join(" ")'
}

# oauth2-proxy's --trusted-proxy-ip value(s) in the same rendered configuration.
rendered_trusted_proxy_ips() {
  jq -r '[.services["oauth2-proxy"].command[]?
    | select(startswith("--trusted-proxy-ip=")) | ltrimstr("--trusted-proxy-ip=")] | join(" ")'
}

# Prints "<first> <last>" for an IPv4 CIDR, as integers. Fails on anything else.
ipv4_cidr_bounds() {
  local cidr="$1" octet address=0 bits size
  if ! [[ "$cidr" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]]; then
    fail "'$cidr' is not an IPv4 CIDR"
  fi
  for octet in "${BASH_REMATCH[@]:1:4}"; do
    (( 10#$octet <= 255 )) || fail "'$cidr' is not an IPv4 CIDR"
    address=$(( address * 256 + 10#$octet ))
  done
  bits=$(( 10#${BASH_REMATCH[5]} ))
  (( bits <= 32 )) || fail "'$cidr' is not an IPv4 CIDR"
  size=$(( 1 << (32 - bits) ))
  address=$(( address - address % size ))
  echo "$address $(( address + size - 1 ))"
}

# Succeeds when two IPv4 CIDRs share an address; fails the script on a value
# that is not one, so a parse error is never read as "disjoint".
ipv4_cidrs_overlap() {
  local left right left_first left_last right_first right_last
  left="$(ipv4_cidr_bounds "$1")" || exit 1
  right="$(ipv4_cidr_bounds "$2")" || exit 1
  read -r left_first left_last <<<"$left"
  read -r right_first right_last <<<"$right"
  (( left_first <= right_last && right_first <= left_last ))
}
