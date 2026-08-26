#!/usr/bin/env bash
#
# Only src/http may reach the network directly.
#
# From docs/planning/architecture-principles-typescript.md in the product repo: an invariant enforced
# only by documentation decays at the first deadline, and its decay is invisible — the code still
# works and the tests still pass. The SSRF guard is worth exactly as much as this check.
#
# What it forbids everywhere except src/http:
#   node:http / node:https / node:net / node:dns   — raw sockets and resolution
#   fetch(  /  undici                              — Node's built-in fetch is undici, which ignores
#                                                    http.Agent and therefore ignores the guarded
#                                                    DNS lookup that IS the control
#   axios / got / node-fetch / request             — the usual replacements
#
# Reach the network through src/http instead. If a case genuinely cannot, that is a change to the
# capability, not an exception at the call site.
set -uo pipefail

cd "$(dirname "$0")/.."

# scripts/ is exempt: the harnesses drive httptest-style loopback servers and are not shipped.
SEARCH_DIRS="src"

# OUTBOUND access is the risk, not inbound. src/server.ts imports createServer from node:http to
# LISTEN, which no attacker-supplied URL can influence, and forbidding that would make this check
# permanently red — which teaches everyone to ignore it, the failure the architecture doc warns
# about for CI jobs. So node:http/node:https are flagged only when they import a client symbol
# (request, get, Agent) or take the whole module via a default/namespace import. node:net and
# node:dns stay fully forbidden: outside the guard there is no innocent reason for either.
CLIENT_IMPORT='(import|require).*(\brequest\b|\bget\b|\bAgent\b).*node:(http|https)'
WHOLE_MODULE='import [A-Za-z_*]+[^{]* from .node:(http|https).'
RAW_SOCKETS='from .node:(net|dns)|require\(.node:(net|dns).\)'
LIBRARIES='from .(axios|got|node-fetch|undici|request).|\bfetch\('

violations=$(
  grep -rnE "$CLIENT_IMPORT|$WHOLE_MODULE|$RAW_SOCKETS|$LIBRARIES" $SEARCH_DIRS --include='*.ts' 2>/dev/null |
    grep -v '^src/http/' || true
)

if [[ -n "$violations" ]]; then
  echo "Files outside src/http reaching the network directly:"
  echo
  echo "$violations" | sed 's/^/  /'
  cat >&2 <<'EOF'

REFUSED: the SSRF guard lives in src/http and is only worth something if it cannot be walked around.

Use the OutboundHttp capability from src/http instead of node:http, node:https or fetch. Node's
built-in fetch is undici, which ignores http.Agent — so it silently bypasses the guarded DNS lookup
that is the actual control, while looking like ordinary modern code.
EOF
  exit 1
fi

echo "network access confined to src/http"
exit 0
