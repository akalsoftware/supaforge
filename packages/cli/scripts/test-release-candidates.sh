#!/usr/bin/env bash
set -euo pipefail

# Test SupaForge, DBDiff and pg-conformance together, as they would be
# released, before any of them is.
#
# Each repo's own CI tests it against the others' *published* versions, so a
# fix that needs a change in two of them is only ever tested together after
# both are released. This builds the release artifacts locally from the
# checkouts' current commits and runs SupaForge's suites through them:
#
#   1. DBDiff: the PHAR and the static linux-x64 binary, built the way the
#      release workflow builds them (scripts/build-local.sh: Podman or Docker,
#      no PHP needed; the first build takes 30-60 min, later ones minutes).
#   2. The npm packages @dbdiff/cli and @dbdiff/cli-linux-x64, versioned
#      together and packed, and @akal/pg-conformance packed.
#   3. SupaForge built and packed against them, then installed into a scratch
#      prefix the way a user installs it.
#   4. SupaForge's suites run against that installed package: unit and lint,
#      integration, the database e2e suite and the scenario suites (twin
#      servers, and PostgreSQL 17 → 15) drive its bin/run.js and its own
#      @dbdiff/cli binary, not this checkout.
#
# Only committed work is tested: each checkout's HEAD is cloned. Linux x64.
#
# Usage:
#   ./scripts/test-release-candidates.sh [--dbdiff PATH] [--pg-conformance PATH]
#                                         [--work DIR] [--suites LIST] [--skip-build]
#
#   --dbdiff PATH          DBDiff checkout (default: ../../../DBDiff from here)
#   --pg-conformance PATH  pg-conformance checkout (default: the version in package.json)
#   --work DIR             Where to build (default: a new temp directory)
#   --suites LIST          Comma-separated: unit,integration,e2e,scenarios,cross-version
#                          (default: all)
#   --skip-build           Reuse the DBDiff artifacts already in --work
#
# Exit status is 0 only when every suite run passes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$CLI_DIR/../.." && pwd)"

DBDIFF_SRC="$(cd "$REPO_DIR/.." && pwd)/DBDiff"
PGC_SRC=""
WORK=""
SUITES="unit,integration,e2e,scenarios,cross-version"
SKIP_BUILD=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dbdiff)         DBDIFF_SRC="$2"; shift 2 ;;
    --pg-conformance) PGC_SRC="$2"; shift 2 ;;
    --work)           WORK="$2"; shift 2 ;;
    --suites)         SUITES="$2"; shift 2 ;;
    --skip-build)     SKIP_BUILD=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
WORK="${WORK:-$(mktemp -d -t supaforge-rc-XXXXXX)}"
mkdir -p "$WORK/tgz"
WORK="$(cd "$WORK" && pwd)"
wants() { [[ ",$SUITES," == *",$1,"* ]]; }

RT=""
for c in podman docker; do command -v "$c" >/dev/null 2>&1 && { RT="$c"; break; }; done
[ -n "$RT" ] || { echo "Podman or Docker is needed." >&2; exit 1; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
RESULTS=()
record() { RESULTS+=("$1"); }

# ── 1. DBDiff: release artifacts from the checkout's HEAD ────────────────────
DBDIFF_SHA="$(git -C "$DBDIFF_SRC" rev-parse --short HEAD)"
VERSION="0.0.0-local.$DBDIFF_SHA"
if ! $SKIP_BUILD; then
  say "DBDiff $DBDIFF_SHA ($(git -C "$DBDIFF_SRC" rev-parse --abbrev-ref HEAD)): PHAR and static linux-x64 binary"
  rm -rf "$WORK/dbdiff"
  git clone -q --local "$DBDIFF_SRC" "$WORK/dbdiff"
  git -C "$WORK/dbdiff" checkout -q "$(git -C "$DBDIFF_SRC" rev-parse HEAD)"
  (cd "$WORK/dbdiff" && bash scripts/build-local.sh)
fi
BIN="$WORK/dbdiff/packages/@dbdiff/cli-linux-x64/dbdiff"
[ -x "$BIN" ] && [ -f "$WORK/dbdiff/dist/dbdiff.phar" ] || { echo "DBDiff artifacts missing in $WORK/dbdiff" >&2; exit 1; }
say "DBDiff binary: $("$BIN" --version)"

# ── 2. npm packages, versioned together as a release stamps them ─────────────
say "Packing @dbdiff/cli $VERSION, @dbdiff/cli-linux-x64 $VERSION"
rm -f "$WORK"/tgz/*.tgz
cp "$WORK/dbdiff/dist/dbdiff.phar" "$WORK/dbdiff/packages/@dbdiff/cli/dbdiff.phar"
for pkg in cli cli-linux-x64; do
  node -e '
    const fs = require("fs"), [file, v] = process.argv.slice(1)
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    j.version = v
    for (const k of Object.keys(j.optionalDependencies ?? {})) j.optionalDependencies[k] = v
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n")
  ' "$WORK/dbdiff/packages/@dbdiff/$pkg/package.json" "$VERSION"
  (cd "$WORK/dbdiff/packages/@dbdiff/$pkg" && npm pack --silent --pack-destination "$WORK/tgz" >/dev/null)
done
if [ -n "$PGC_SRC" ]; then
  say "Packing @akal/pg-conformance from $PGC_SRC ($(git -C "$PGC_SRC" rev-parse --short HEAD))"
  rm -rf "$WORK/pg-conformance"
  git clone -q --local "$PGC_SRC" "$WORK/pg-conformance"
  git -C "$WORK/pg-conformance" checkout -q "$(git -C "$PGC_SRC" rev-parse HEAD)"
  (cd "$WORK/pg-conformance" && npm pack --silent --pack-destination "$WORK/tgz" >/dev/null)
fi
DEPS=("$WORK"/tgz/dbdiff-cli-*.tgz)
[ -n "$PGC_SRC" ] && DEPS+=("$WORK"/tgz/akal-pg-conformance-*.tgz)

# ── 3. SupaForge built against them, packed and installed ───────────────────
say "SupaForge $(git -C "$REPO_DIR" rev-parse --short HEAD) ($(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)), built against those"
rm -rf "$WORK/supaforge"
git clone -q --local "$REPO_DIR" "$WORK/supaforge"
git -C "$WORK/supaforge" checkout -q "$(git -C "$REPO_DIR" rev-parse HEAD)"
SF="$WORK/supaforge/packages/cli"
# Pinned to the candidates as a release bump would pin them, so the packed
# package depends on these versions and not on local paths.
PGC_VERSION="$( [ -n "$PGC_SRC" ] && node -p 'require(process.argv[1]).version' "$WORK/pg-conformance/package.json" || true)"
(cd "$SF" && npm ci --silent --no-audit --no-fund)
node -e '
  const fs = require("fs"), [file, dbdiff, pgc] = process.argv.slice(1)
  const j = JSON.parse(fs.readFileSync(file, "utf8"))
  j.dependencies["@dbdiff/cli"] = dbdiff
  if (pgc) j.dependencies["@akal/pg-conformance"] = pgc
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n")
' "$SF/package.json" "$VERSION" "$PGC_VERSION"
(cd "$SF" && npm install --silent --no-audit --no-fund --no-save "${DEPS[@]}" && npm run build --silent)
(cd "$SF" && npm pack --silent --pack-destination "$WORK/tgz" >/dev/null)
rm -rf "$WORK/prefix" && mkdir -p "$WORK/prefix"
(cd "$WORK/prefix" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "$WORK"/tgz/akal-supaforge-*.tgz "${DEPS[@]}")
INSTALLED="$WORK/prefix/node_modules/@akal/supaforge"
say "Installed: $(node "$INSTALLED/bin/run.js" --version) with $("$WORK/prefix/node_modules/.bin/dbdiff" --version)"
for env in production development test; do
  if NODE_ENV=$env node "$INSTALLED/bin/run.js" --version 2>&1 >/dev/null | grep -q .; then
    record "FAIL  the installed CLI writes to stderr under NODE_ENV=$env"
  fi
done
export SUPAFORGE_E2E_CLI="$INSTALLED/bin/run.js"
cd "$SF"

# A proof across versions copies the source with pg_dump, which must be at
# least as new as the source server. PostgreSQL 18's client tools from a
# container are offered through SUPAFORGE_PG_BIN, and PATH is left alone: most
# machines, CI's included, have an older pg_dump first on PATH and a newer one
# elsewhere, and SupaForge has to find the right one itself. Put first on PATH,
# they hid a proof that picked one too old for the source.
if wants scenarios || wants cross-version; then
  mkdir -p "$WORK/pgbin"
  for t in pg_dump pg_restore psql; do
    # libpq's environment goes through as well: SupaForge passes the password
    # and session options (PGOPTIONS) to the tools that way, not on the command line.
    printf '#!/bin/sh\nexec %s run --rm -i --network=host -v /tmp:/tmp -e PGPASSWORD -e PGOPTIONS -e PGSSLMODE docker.io/library/postgres:18 %s "$@"\n' "$RT" "$t" > "$WORK/pgbin/$t"
    chmod +x "$WORK/pgbin/$t"
  done
  export SUPAFORGE_PG_BIN="$WORK/pgbin"
fi

run_suite() {
  local name=$1; shift
  say "$name"
  if "$@"; then record "PASS  $name"; else record "FAIL  $name"; fi
}

if wants unit; then
  run_suite "unit" npx vitest run
  run_suite "lint" npm run lint --silent
fi

if wants integration || wants e2e; then
  trap '$RT rm -f -v sf-rc-source sf-rc-target >/dev/null 2>&1 || true' EXIT
  for p in 15432:source 15433:target; do
    $RT rm -f "sf-rc-${p##*:}" >/dev/null 2>&1 || true
    $RT run -d --rm --name "sf-rc-${p##*:}" --network=host -e POSTGRES_PASSWORD="${p##*:}-test-pass" \
      docker.io/library/postgres:15 -c listen_addresses=127.0.0.1 -c port="${p%%:*}" >/dev/null
  done
  until $RT exec sf-rc-source pg_isready -p 15432 -q 2>/dev/null && $RT exec sf-rc-target pg_isready -p 15433 -q 2>/dev/null; do sleep 1; done
  export SUPAFORGE_TEST_SOURCE_URL=postgresql://postgres:source-test-pass@127.0.0.1:15432/postgres
  export SUPAFORGE_TEST_TARGET_URL=postgresql://postgres:target-test-pass@127.0.0.1:15433/postgres
  seed() {
    $RT exec -i -e PGPASSWORD=source-test-pass sf-rc-source psql -h 127.0.0.1 -p 15432 -U postgres -q -v ON_ERROR_STOP=1 < tests/fixtures/seed-source.sql >/dev/null 2>&1
    $RT exec -i -e PGPASSWORD=target-test-pass sf-rc-target psql -h 127.0.0.1 -p 15433 -U postgres -q -v ON_ERROR_STOP=1 < tests/fixtures/seed-target.sql >/dev/null 2>&1
  }
  if wants integration; then seed; run_suite "integration" npx vitest run --config vitest.integration.config.ts; fi
  if wants e2e; then seed; run_suite "database e2e" npx vitest run test/e2e; fi
fi

if wants scenarios; then
  run_suite "scenarios (twin servers)" env SCENARIO_REQUIRE_PROOF=1 npx vitest run -c vitest.scenarios.config.ts
fi
if wants cross-version; then
  run_suite "scenarios (PostgreSQL 17 → 15)" env SCENARIO_REQUIRE_PROOF=1 \
    SCENARIO_SOURCE_IMAGE=postgres:17 SCENARIO_TARGET_IMAGE=postgres:15 npx vitest run -c vitest.scenarios.config.ts
fi

say "Release candidates: SupaForge $(git -C "$REPO_DIR" rev-parse --short HEAD), DBDiff $DBDIFF_SHA${PGC_SRC:+, pg-conformance $(git -C "$PGC_SRC" rev-parse --short HEAD)}"
printf '%s\n' "${RESULTS[@]}"
printf '\nArtifacts in %s\n' "$WORK"
! printf '%s\n' "${RESULTS[@]}" | grep -q '^FAIL'
