#!/usr/bin/env bash
#
# Refuse to let patient data enter git history.
#
# .gitignore is not a control — `git add -f` walks straight past it, and this repo keeps hundreds of
# megabytes of real records in ./phi next to the code. Before publishing, a mistake was a local file.
# After publishing it is permanent: GitHub retains history, and flipping a repo private -> public
# exposes every commit ever made. So this runs as a pre-commit hook AND in CI.
#
#   scripts/check-no-phi.sh            # check staged files (hook mode)
#   scripts/check-no-phi.sh --all      # check every tracked file (CI mode)
#
# Deliberately strict and deliberately dumb. A false positive costs one --no-verify and a moment's
# thought; a false negative is an irreversible privacy breach.
set -uo pipefail

MAX_BYTES=2097152 # 2 MiB — no legitimate source file in this repo is close

# bash 3.2 compatible (macOS ships 3.2, which has no mapfile) — read the list into $@ via a
# newline-only IFS rather than an array builtin that is not there.
# The Go backend and the Angular app both keep SYNTHETIC fixtures — Synthea patients under
# backend/**/testdata and DSTU2 bundles under frontend/src/lib/fixtures — committed years ago and
# covered by their own CI. This guard came across with the TypeScript stack (yourphr#650) and, run at
# this root, would fail on all of them — which trains an operator to pass --no-verify, the one habit
# it exists to prevent. So --all scans the TypeScript stack's own tree while both backends live here.
# Delete this scoping when backend/ goes at yourphr#646: --all should mean --all again.
if [[ "${1:-}" == "--all" ]]; then
  FILE_LIST=$(git ls-files -- src scripts config e2e docs private '*.md' '*.json' '*.ts' 2>/dev/null | grep -vE '^(backend|frontend)/' || true)
else
  FILE_LIST=$(git diff --cached --name-only --diff-filter=ACMR | grep -vE '^(backend|frontend)/' || true)
fi

fail=0
note() {
  printf '  ✗ %s\n     %s\n' "$1" "$2"
  fail=1
}

OLDIFS=$IFS
IFS=$'\n'
for f in $FILE_LIST; do
  IFS=$OLDIFS
  [[ -z "$f" ]] && continue

  case "$f" in
    phi/* | patient-data/* | sample-data/* | */phi/*)
      note "$f" "lives in a PHI directory"
      continue
      ;;
  esac

  case "$f" in
    *.db | *.db-wal | *.db-shm | *.db-journal | *.sqlite | *.sqlite3 | *.ndjson)
      note "$f" "database or bulk-export extension"
      continue
      ;;
  esac

  [[ -f "$f" ]] || continue

  size=$(wc -c <"$f" | tr -d ' ')
  if [[ "$size" -gt "$MAX_BYTES" ]]; then
    note "$f" "$size bytes — too large for source; is this an export?"
    continue
  fi

  # Content sniff, for a real record pasted into an otherwise innocent file. Looks for FHIR shapes
  # that only appear in actual patient data, not in the code that handles it. package-lock.json and
  # this script are exempt: one is generated, the other has to contain the patterns to match them.
  case "$f" in
    package-lock.json | scripts/check-no-phi.sh) continue ;;
  esac

  if LC_ALL=C grep -qE '"birthDate"[[:space:]]*:|"subject"[[:space:]]*:[[:space:]]*\{[[:space:]]*"reference"[[:space:]]*:[[:space:]]*"Patient/' "$f" 2>/dev/null; then
    note "$f" "contains FHIR patient-record fields"
  fi
  IFS=$'\n'
done
IFS=$OLDIFS

if [[ "$fail" -ne 0 ]]; then
  cat >&2 <<'EOF'

REFUSED: the above looks like patient data.

Nothing here may enter git history — a leak is irreversible and a privacy breach.
See the PHI rule in yourphr's AGENTS.md.

If this is genuinely synthetic and you are certain, unstage it, confirm it is
synthetic, and commit with --no-verify. Think twice: "I am sure it is synthetic"
is the sentence that precedes most of these accidents.
EOF
  exit 1
fi

exit 0
