#!/bin/bash
# SupaForge on a public sample database, between two servers this script
# starts in containers. Synthetic fixtures are small and written by the people
# who wrote the code; these were not, and they use what real schemas use —
# mixed-case domains, arrays with modifiers, pgvector, partitions in their own
# schema, thousands of indexes and triggers.
#
#   clone    the source cloned, with data, into a fresh database
#   sync     the source's schema applied to an empty database (diff --apply)
#   drift    the source changes as a migration would; the clone catches up
#            with diff --apply --prove, keeping its rows
#   restore  a snapshot of the source restored into a fresh database
#
# Every step must leave a re-scan with nothing to fix. Between servers of the
# same major the catalog state must also equal the source's, and a clone's
# rows must match. Verdicts are read from the databases, not from SupaForge.
#
#   scripts/real-world.sh DATASET SOURCE TARGET
#
# DATASET is chinook, pagila, adventureworks or gitlab; SOURCE and TARGET are
# pg15..pg18, pv18 (PostgreSQL 18 with pgvector) or sb15 (Supabase's image).
# Known failures are listed in test/real-world/known-gaps.json: the run fails
# on any other, and on a listed one that passes.
set -u
CLI=$(cd "$(dirname "$0")/.." && pwd)
DATASET=$1 SOURCE=$2 TARGET=$3
OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"; RES=$OUT/results.tsv; : > "$RES"
DATA=${DATA:-$OUT/data}; mkdir -p "$DATA"
SB15_IMAGE=${SB15_IMAGE:-public.ecr.aws/supabase/postgres:15.8.1.085}
SF=(node "$CLI/bin/run.js")
STATE_SQL=$CLI/node_modules/@akal/pg-conformance/state.sql
GAPS=$CLI/test/real-world/known-gaps.json

# ── Datasets, pinned ────────────────────────────────────────────────────────
PAGILA=https://raw.githubusercontent.com/devrimgunduz/pagila/6ea53f812254c91a602f61c0ef62beca3fa676b1
CHINOOK=https://raw.githubusercontent.com/lerocha/chinook-database/7f67772503d71ba90f19283c38e93923addb43fa
AW=https://raw.githubusercontent.com/lorint/AdventureWorks-for-Postgres/b474991f0df1c4bf55ca4735eb0254ca0709eed2
AW_ZIP=https://github.com/Microsoft/sql-server-samples/releases/download/adventureworks/AdventureWorks-oltp-install-script.zip
AW_ZIP_SHA256=58962e94ea386ef7cd3d8a08211bfd42a79d9b81bdd68fd4b6b0051de6c5bd42
GITLAB=https://gitlab.com/gitlab-org/gitlab/-/raw/d4a965ce1f3a886a70ca95821e4f9086c563134d/db/structure.sql
get(){ curl -fsSL --retry 5 --retry-all-errors -o "$1" "$2"; }

image(){ case $1 in
  sb15) echo "$SB15_IMAGE";; pv18) echo docker.io/pgvector/pgvector:pg18;;
  pg1[5-8]) echo "docker.io/library/postgres:${1#pg}";; *) echo "unknown server $1" >&2; exit 2;; esac; }
major(){ case $1 in sb15) echo 15;; *) echo "${1:2}";; esac; }
# GitLab's schema is ~1,475 tables and ~5,000 indexes in one transaction,
# about 10,500 locks; the default lock table (64 per connection slot) holds
# about 7,000, so it is raised as anyone running a schema that size would.
# SupaForge warns before such an apply and says how to fix it.
SERVER_ARGS=(); [ "$DATASET" = gitlab ] && SERVER_ARGS=(-c max_locks_per_transaction=256)
start(){ local node=$1 c=$2 port=$3
  docker rm -f "$c" >/dev/null 2>&1
  if [ "$node" = sb15 ]; then
    docker run -d --name "$c" -p 127.0.0.1:$port:5432 -e POSTGRES_PASSWORD=rwpass \
      -e JWT_SECRET=ci-only-jwt-secret-at-least-32-characters-long "$(image $node)" postgres -D /etc/postgresql "${SERVER_ARGS[@]}" >/dev/null
  else
    docker run -d --name "$c" -p 127.0.0.1:$port:5432 -e POSTGRES_PASSWORD=rwpass "$(image $node)" postgres "${SERVER_ARGS[@]}" >/dev/null
  fi
  local ok=0
  for _ in $(seq 240); do
    if psql "postgresql://postgres:rwpass@127.0.0.1:$port/postgres" -XAtqc 'SELECT 1' >/dev/null 2>&1; then
      ok=$((ok + 1)); [ $ok -ge 3 ] && return 0; else ok=0; fi
    sleep 1
  done
  echo "$c did not start"; docker logs "$c" 2>&1 | tail -20; exit 1
}
SP=56101 TP=56102
base(){ echo "postgresql://postgres:rwpass@127.0.0.1:$1"; }
q(){ psql "$1" -XAtq -v ON_ERROR_STOP=1 "${@:2}"; }
fresh(){ q "$(base $1)/postgres" -c "DROP DATABASE IF EXISTS \"$2\" WITH (FORCE)" -c "CREATE DATABASE \"$2\""; }

load(){ local url=$1
  case $DATASET in
    chinook)
      get "$DATA/chinook.sql" "$CHINOOK/ChinookDatabase/DataSources/Chinook_PostgreSql.sql"
      sed -E '/^(DROP|CREATE) DATABASE/d; /^\\c /d' "$DATA/chinook.sql" | q "$url" -f - ;;
    pagila)
      get "$DATA/schema.sql" "$PAGILA/pagila-schema.sql"; get "$DATA/data.sql" "$PAGILA/pagila-data.sql"
      q "$url" -f "$DATA/schema.sql"
      # The data covers months the schema has no partition for.
      q "$url" -c "DO \$\$ DECLARE d date := '2022-01-01'; n text; BEGIN
        WHILE d < '2026-08-01' LOOP n := 'payment_p' || to_char(d, 'YYYY_MM');
          IF to_regclass('public.' || n) IS NULL THEN
            EXECUTE format('CREATE TABLE public.%I PARTITION OF public.payment FOR VALUES FROM (%L) TO (%L)', n, d, (d + interval '1 month')::date);
          END IF; d := (d + interval '1 month')::date; END LOOP; END \$\$"
      q "$url" -f "$DATA/data.sql" ;;
    adventureworks)
      get "$DATA/aw.zip" "$AW_ZIP"; echo "$AW_ZIP_SHA256  $DATA/aw.zip" | sha256sum -c --quiet || exit 1
      get "$DATA/install.sql" "$AW/install.sql"; get "$DATA/update_csvs.rb" "$AW/update_csvs.rb"
      (cd "$DATA" && unzip -oq aw.zip && ruby update_csvs.rb >/dev/null && q "$url" -f install.sql) ;;
    gitlab)
      get "$DATA/structure.sql" "$GITLAB"; q "$url" -f "$DATA/structure.sql" ;;
    *) echo "unknown dataset $DATASET" >&2; exit 2 ;;
  esac
}

# What the source changes, as a migration would.
drift(){ case $DATASET in
  chinook) cat <<'SQL'
ALTER TABLE track ADD COLUMN explicit boolean NOT NULL DEFAULT false;
ALTER TABLE track RENAME COLUMN composer TO composer_name;
ALTER TABLE customer ALTER COLUMN email TYPE text;
CREATE TYPE media_tier AS ENUM ('free', 'premium');
ALTER TABLE media_type ADD COLUMN tier media_tier DEFAULT 'free';
CREATE INDEX track_name_lower_idx ON track (lower(name));
ALTER TABLE invoice ADD CONSTRAINT invoice_total_nonneg CHECK (total >= 0) NOT VALID;
CREATE VIEW artist_album_count AS SELECT ar.artist_id, ar.name, count(al.album_id) AS albums
  FROM artist ar LEFT JOIN album al USING (artist_id) GROUP BY ar.artist_id, ar.name;
CREATE FUNCTION touch_invoice() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.total := round(NEW.total, 2); RETURN NEW; END$$;
CREATE TRIGGER invoice_round BEFORE INSERT OR UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION touch_invoice();
ALTER TABLE playlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY playlist_read ON playlist FOR SELECT USING (true);
COMMENT ON TABLE artist IS 'Recording artists';
SQL
  ;;
  pagila) cat <<'SQL'
ALTER TABLE film ADD COLUMN subtitle_langs text[] DEFAULT '{}';
CREATE TABLE payment_p2026_08 PARTITION OF payment FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
ALTER TABLE payment ADD COLUMN channel text DEFAULT 'store';
CREATE INDEX customer_email_lower ON customer (lower(email));
CREATE OR REPLACE FUNCTION last_day(timestamp with time zone) RETURNS date LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT (date_trunc('month', $1) + interval '1 month - 1 day')::date $$;
CREATE MATERIALIZED VIEW film_stats AS SELECT rating, count(*) n, avg(length) avg_len FROM film GROUP BY rating;
ALTER TYPE mpaa_rating ADD VALUE 'X' AFTER 'NC-17';
COMMENT ON COLUMN film.fulltext IS 'tsvector maintained by trigger';
SQL
  ;;
  adventureworks) cat <<'SQL'
ALTER DOMAIN public."Phone" ADD CONSTRAINT phone_len CHECK (length(VALUE) <= 40) NOT VALID;
ALTER TABLE sales.store RENAME TO retail_store;
ALTER TABLE person.person ADD COLUMN preferred_name public."Name";
CREATE SCHEMA reporting;
CREATE VIEW reporting.sales_by_territory AS SELECT territoryid, sum(totaldue) total FROM sales.salesorderheader GROUP BY territoryid;
GRANT USAGE ON SCHEMA reporting TO PUBLIC;
SQL
  ;;
  gitlab) cat <<'SQL'
ALTER TABLE projects ADD COLUMN archived_reason text;
ALTER TABLE issues ALTER COLUMN title TYPE text;
CREATE INDEX index_issues_on_title_lower ON issues (lower(title));
ALTER TABLE merge_requests ADD CONSTRAINT check_mr_title_len CHECK (char_length(title) <= 1024) NOT VALID;
CREATE OR REPLACE FUNCTION gitlab_drift_noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER trg_drift_noop BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION gitlab_drift_noop();
SQL
  ;;
esac; }

# ── Oracles ─────────────────────────────────────────────────────────────────
PLATFORM="'auth','storage','extensions','graphql','graphql_public','realtime','supabase_functions','supabase_migrations','vault','pgsodium','pgsodium_masks','net','cron','pgbouncer','_realtime','_analytics','pgmq','pgtle','supaforge'"
schemas(){ q "$1" -c "SELECT string_agg(quote_literal(nspname), ',' ORDER BY nspname) FROM pg_namespace
  WHERE nspname !~ '^(pg_|information_schema$)' AND nspname NOT IN ($PLATFORM)"; }
state(){ local sc; sc=$(schemas "$1"); [ -n "$sc" ] || { echo '{}'; return; }
  sed "s/__SCHEMAS__/$sc/" "$STATE_SQL" | q "$1" -f - \
    | jq -S 'del(.meta.server_version_num) | walk(if type == "object" and has("position") then del(.position) else . end)'; }
rows(){ q "$1" -c "SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND NOT c.relispartition AND n.nspname = ANY (ARRAY[$(schemas "$1")]) ORDER BY 1" \
  | while read -r t; do echo "$t $(q "$1" -c "SELECT count(*) || ' ' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') FROM $t x")"; done; }
# Not counted: RLS coverage (the datasets have no policies), and the note that
# a Supabase platform extension stays in Supabase's schema, which is reported
# by design with nothing to apply.
issues(){ jq '[.. | objects | select(has("issues") and (.check // .name) != "rls-coverage") | .issues[]
    | select((.severity == "info" and (.id | test("-extension-schema-[0-9]+$")) and (has("sql") | not)) | not)] | length' "$1" 2>/dev/null || echo '?'; }
SAME=$([ "$(major $SOURCE)" = "$(major $TARGET)" ] && echo 1 || echo 0)

record(){ printf '%s\t%s\t%s\t%s\n' "$DATASET $SOURCE>$TARGET" "$1" "$2" "$3" >> "$RES"; printf '  %-8s %-4s %s\n' "$1" "$2" "$3"; }
# check STEP SOURCE_URL TARGET_URL APPLY_JSON [rows]
check(){ local step=$1 src=$2 tgt=$3 json=$4 why=()
  cfg "$tgt"; "${SF[@]}" diff --json > "$OUT/$step.rescan.json" 2> "$OUT/$step.rescan.err"
  local n; n=$(issues "$OUT/$step.rescan.json")
  [ "$n" = 0 ] || why+=("re-scan finds $n")
  [ -n "$json" ] && [ "$(jq '[.errors[]?] | length' "$json" 2>/dev/null || echo 1)" != 0 ] && why+=("$(jq '[.errors[]?] | length' "$json") fix(es) failed")
  if [ "$SAME" = 1 ]; then
    state "$src" > "$OUT/$step.src.state"; state "$tgt" > "$OUT/$step.tgt.state"
    [ "$(jq '.tables // [] | length' "$OUT/$step.src.state")" -gt 0 ] || why+=("source state empty")
    diff -q "$OUT/$step.src.state" "$OUT/$step.tgt.state" >/dev/null || why+=("state differs ($(diff "$OUT/$step.src.state" "$OUT/$step.tgt.state" | grep -c '^[<>]') lines)")
  fi
  if [ "${5:-}" = rows ]; then rows "$src" > "$OUT/$step.src.rows"; rows "$tgt" > "$OUT/$step.tgt.rows"
    diff -q "$OUT/$step.src.rows" "$OUT/$step.tgt.rows" >/dev/null || why+=("rows differ")
  fi
  if [ ${#why[@]} -eq 0 ]; then record "$step" PASS ok; else record "$step" FAIL "$(IFS=';'; echo "${why[*]}")"; fi
}
cfg(){ printf '{"environments":{"src":{"dbUrl":"%s"},"tgt":{"dbUrl":"%s"}},"source":"src","target":"tgt"}\n' "$SRC" "$1" > "$OUT/supaforge.config.json"; }

# ── Run ─────────────────────────────────────────────────────────────────────
echo "== $DATASET: $SOURCE > $TARGET"
start "$SOURCE" rw-src $SP; start "$TARGET" rw-tgt $TP
fresh $SP rw; SRC=$(base $SP)/rw
load "$SRC" > "$OUT/load.log" 2>&1 || { echo "loading $DATASET failed"; tail -20 "$OUT/load.log"; exit 1; }
grep -m3 ERROR "$OUT/load.log" && { echo "loading $DATASET reported errors"; exit 1; }
cd "$OUT"

fresh $TP rw_clone; T1=$(base $TP)/rw_clone; cfg "$T1"
"${SF[@]}" clone -e src --local-url "$(base $TP)/postgres" --local-db rw_clone --force --apply --json > clone.json 2> clone.err \
  && check clone "$SRC" "$T1" "" rows || record clone FAIL "clone exited $? ($(grep -m1 -E '✗|Error' clone.err))"

# A Supabase target is synced into its own postgres database, beside its platform schemas.
if [ "$TARGET" = sb15 ]; then T2=$(base $TP)/postgres; else fresh $TP rw_sync; T2=$(base $TP)/rw_sync; fi
cfg "$T2"; "${SF[@]}" diff --apply --allow-destructive --json > sync.json 2> sync.err
check sync "$SRC" "$T2" sync.json

drift | q "$SRC" -f - > drift.log 2>&1 || { echo "the drift script failed"; cat drift.log; exit 1; }
rows "$T1" | awk '{print $1, $2}' | LC_ALL=C sort > drift.before
cfg "$T1"; "${SF[@]}" diff --apply --allow-destructive --prove --json > drift.json 2> drift.err
check drift "$SRC" "$T1" drift.json
proved=$(jq -r '.proved | tostring' drift.json); [ "$proved" = false ] && record drift-prove FAIL "$(jq -r '.reason // ""' drift.json): $(jq -r '.residual // [] | join("; ")' drift.json | cut -c1-200)"
# Every table the clone had before still holds as many rows (a renamed one is
# matched by the re-scan, not here).
lost=$(rows "$T1" | awk '{print $1, $2}' | LC_ALL=C sort | LC_ALL=C join drift.before - | awk '$2 != $3' | wc -l)
[ "$lost" = 0 ] && record drift-rows PASS ok || record drift-rows FAIL "$lost table(s) changed row count"

fresh $TP rw_restore; T3=$(base $TP)/rw_restore; cfg "$T3"
"${SF[@]}" snapshot -e src --apply --json > snap.json 2> snap.err || record restore FAIL "snapshot exited $?"
"${SF[@]}" restore -e tgt --from-snapshot latest --apply --json > restore.json 2> restore.err
check restore "$SRC" "$T3" restore.json

# ── Verdict against the known gaps ──────────────────────────────────────────
bad=0
while IFS=$'\t' read -r pair step verdict detail; do
  gap=$(jq -r --arg k "$pair $step" '.[$k] // empty' "$GAPS")
  if [ "$verdict" = FAIL ] && [ -z "$gap" ]; then echo "NEW FAILURE: $pair $step — $detail"; bad=1
  elif [ "$verdict" = PASS ] && [ -n "$gap" ]; then echo "NOW PASSES, remove from known-gaps.json: $pair $step ($gap)"; bad=1; fi
done < "$RES"
docker rm -f rw-src rw-tgt >/dev/null 2>&1
exit $bad
