#!/usr/bin/env bash
# Build the demo seed database (#505).
#
# Boots the app against an empty database, creates the demo account, imports a synthetic bundle,
# and leaves a fasten.db that a demo instance can start from. CI bakes the result into the release
# image; the pod copies it in when its data directory has no database, so resetting the demo is
# "delete the file, restart" and a fresh volume self-seeds.
#
# WHY BUILD IT PER RELEASE. A hand-made golden database drifts from the schema and has to be
# refreshed by hand — a chore, and chores get skipped. Built here, the seed always matches the
# release it ships in, and it lives in the registry rather than on one node's local disk.
#
# WHAT MUST NOT BE IN IT:
#
#   * an admin account. The image is PUBLIC, so a baked admin credential would be a published
#     credential, identical on every deployment. The admin is provisioned at runtime instead, with a
#     per-instance random password (#504) — which is what makes shipping this seed safe at all.
#   * anything that is not synthetic. The bundle is a named in-repo test file, never an export from
#     a live instance.
#
# HOW THE DEMO ACCOUNT ENDS UP NON-ADMIN. The first account created on an empty database is forced
# to admin (handler.AuthSignup), so signing up `demo` first would make it one. So: create a
# throwaway admin first, create `demo` second (role user), then delete the throwaway through its own
# session. What remains is a single non-admin account — verified below rather than assumed.
set -euo pipefail

PORT="${SEED_PORT:-9195}"
WORKDIR="${SEED_WORKDIR:-$(mktemp -d)}"
OUT="${SEED_OUT:-./dist-seed/fasten.seed.db}"
BUNDLE="${SEED_BUNDLE:-backend/pkg/database/testdata/Britt177_Blick895_ad0f0573-f8c7-4704-9eef-50342d37ef50.json}"
DEMO_USER="${SEED_DEMO_USER:-demo}"
DEMO_PASS="${SEED_DEMO_PASS:-demo123}"
API="http://localhost:${PORT}/api"

# A throwaway name that is not on the repository's reserved list and cannot collide with the demo
# account. It exists for seconds and is deleted before the seed is extracted.
BOOTSTRAP_USER="seedbuilder"
BOOTSTRAP_PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"

log() { printf '[seed] %s\n' "$*"; }
fail() { printf '[seed] FAILED: %s\n' "$*" >&2; exit 1; }

[ -f "$BUNDLE" ] || fail "bundle not found: $BUNDLE (run from the repository root)"

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

log "workdir $WORKDIR"
rm -f "$WORKDIR"/fasten.db*

# Refuse to run against a server this script did not start. Without this the script silently seeds
# whatever is already on the port — which happened during development, because `go run` spawns a
# child and killing the wrapper leaves the real process listening. The seed then came from another
# instance's database, and the only symptom was a confusing "duplicate username" further down. Same
# failure mode as yourphr#481.
if curl -sf -o /dev/null --max-time 2 "$API/health"; then
  fail "something is already serving on :$PORT — free it first (lsof -ti:$PORT | xargs kill), or set SEED_PORT"
fi

# Build the binary and run IT, rather than `go run`. `go run` execs a child, so $! is the wrapper and
# killing it orphans the server; a direct binary means the PID we hold is the process we can stop.
log "compiling"
go build -o "$WORKDIR/fasten-seed" ./backend/cmd/fasten/ || fail "could not build the backend"

# Deliberately NOT setting YOURPHR_BOOTSTRAP_ADMIN_*: the seed must contain no admin.
YOURPHR_WEB_LISTEN_PORT="$PORT" \
YOURPHR_STORAGE_DATA_DIR="$WORKDIR" \
YOURPHR_DATABASE_LOCATION="$WORKDIR/fasten.db" \
YOURPHR_DATABASE_ENCRYPTION_ENABLED=false \
YOURPHR_CDA_CONVERTER_ENABLED=false \
YOURPHR_WEB_RATE_LIMIT_AUTH_PER_MINUTE=1000 \
YOURPHR_LOG_LEVEL=WARN \
  "$WORKDIR/fasten-seed" start >"$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!

log "waiting for the backend on :$PORT"
for _ in $(seq 1 60); do
  sleep 2
  curl -sf -o /dev/null --max-time 2 "$API/health" && break
done
curl -sf -o /dev/null --max-time 2 "$API/health" || fail "backend never became ready; see $WORKDIR/server.log"

# signup POSTs and echoes the session token. Status and body are captured explicitly rather than
# relying on `curl -f`: under `set -e` a failing curl inside a command substitution kills the script
# before any diagnostic can print, which is exactly how this failed silently the first time.
signup() {
  local username="$1" password="$2" body status
  body="$(mktemp)"
  status="$(curl -s -o "$body" -w '%{http_code}' -X POST "$API/auth/signup" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$username\",\"password\":\"$password\"}" || true)"
  if [ "$status" != "200" ]; then
    printf '[seed] signup %s -> HTTP %s: %s\n' "$username" "$status" "$(head -c 400 "$body")" >&2
    rm -f "$body"
    return 1
  fi
  sed -n 's/.*"data":"\([^"]*\)".*/\1/p' "$body"
  rm -f "$body"
}

# 1. Throwaway admin (first account on an empty database is forced to admin).
admin_token="$(signup "$BOOTSTRAP_USER" "$BOOTSTRAP_PASS")" \
  || fail "could not create the throwaway admin (see the status above)"
[ -n "$admin_token" ] || fail "throwaway admin signup returned no token"
log "throwaway admin created"

# 2. The demo account — second, so it is an ordinary user.
demo_token="$(signup "$DEMO_USER" "$DEMO_PASS")" \
  || fail "could not create the $DEMO_USER account (see the status above)"
[ -n "$demo_token" ] || fail "$DEMO_USER signup returned no token"
log "$DEMO_USER created"

# 3. Synthetic records, as the demo account, through the ordinary manual-upload path.
status="$(curl -s -o "$WORKDIR/import.json" -w '%{http_code}' -X POST "$API/secure/source/manual" \
  -H "Authorization: Bearer $demo_token" -F "file=@$BUNDLE;type=application/json" --max-time 300)"
[ "$status" = "200" ] || fail "bundle import returned $status: $(head -c 400 "$WORKDIR/import.json")"
log "bundle imported"

# The import settles related resources asynchronously, so wait for a read to succeed before
# snapshotting — a seed captured mid-import would ship a half-built database.
for _ in $(seq 1 30); do
  curl -sf -o /dev/null -H "Authorization: Bearer $demo_token" "$API/secure/summary/ips" && break
  sleep 2
done
curl -sf -o /dev/null -H "Authorization: Bearer $demo_token" "$API/secure/summary/ips" \
  || fail "imported data never became readable"
log "data settled"

# 4. Remove the throwaway admin, so the seed ships with no admin at all.
del="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/secure/account/me" \
  -H "Authorization: Bearer $admin_token")"
[ "$del" = "200" ] || fail "could not delete the throwaway admin (HTTP $del) — the seed would ship with an admin"
log "throwaway admin deleted"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
sleep 1

# 5. Verify the invariants rather than trusting the steps above. A seed that ships an admin, or ships
#    without the demo account, is worse than no seed: it would produce a public instance with either
#    a published admin credential or nothing to look at.
command -v sqlite3 >/dev/null || fail "sqlite3 is required to verify the seed"
admins="$(sqlite3 "$WORKDIR/fasten.db" "select count(*) from users where role='admin';")"
[ "$admins" = "0" ] || fail "the seed contains $admins admin account(s); it must contain none"
demo_rows="$(sqlite3 "$WORKDIR/fasten.db" "select count(*) from users where username='$DEMO_USER';")"
[ "$demo_rows" = "1" ] || fail "expected exactly one $DEMO_USER account, found $demo_rows"
users="$(sqlite3 "$WORKDIR/fasten.db" "select count(*) from users;")"
[ "$users" = "1" ] || fail "expected exactly one account in the seed, found $users"
resources="$(sqlite3 "$WORKDIR/fasten.db" "select count(*) from fhir_patient;" 2>/dev/null || echo 0)"
[ "$resources" -ge 1 ] || fail "the seed contains no Patient resource; the import did not land"

# WAL/SHM must be folded in, or the copied file is missing recent writes.
sqlite3 "$WORKDIR/fasten.db" "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;" >/dev/null

mkdir -p "$(dirname "$OUT")"
cp "$WORKDIR/fasten.db" "$OUT"
log "wrote $OUT ($(du -h "$OUT" | cut -f1)) — 1 non-admin account, $resources patient row(s)"
