# supaforge

> Diff and sync your Supabase environments.

SupaForge compares two Supabase projects (dev and prod, say) across
everything that makes up a project, not just the schema. It reports every
difference and makes the target match the source. Fixes run in dependency
order, in one transaction, and can be proved on a throwaway copy before
anything changes. With a single project, it snapshots, restores and clones it.

- **The whole project.** It covers schema, RLS, storage, auth, Edge Functions,
  cron, webhooks, Realtime, Vault, extensions, grants, reference data and
  migration history.
- **Safe by default.** Every write needs `--apply`, and anything that loses
  data or opens up access also needs `--allow-destructive`. A failed apply
  leaves the target exactly as it was.
- **Provable.** `--prove` rehearses the migration and refuses to apply one
  that wouldn't reproduce the source.
- **Anywhere.** It works with Supabase Cloud, self-hosted stacks, plain
  PostgreSQL targets, CI pipelines and AI agents (MCP).

Built by [Akal](https://github.com/akalsoftware).

## Quick start

```bash
npm install -g @akal/supaforge

supaforge init              # create supaforge.config.json
supaforge diff              # what has drifted?
supaforge diff --detail     # with the SQL
supaforge diff --apply      # fix the target
```

Everything that writes previews first. Add `--apply` to make it happen.

## What it compares

| Check | What it reads | Fixed with |
| --- | --- | --- |
| Schema | [`@dbdiff/cli`](https://github.com/DBDiff/DBDiff): every schema you own | SQL |
| Reference data | Rows of the tables in `checks.data.tables` | SQL |
| RLS policies | `pg_policies`, compared by meaning, not text | SQL |
| RLS coverage | Tables in the target with RLS off (target only) | SQL, opt-in |
| Edge Functions | Management API, Studio, or a functions directory | Deploy command |
| Storage | Buckets and their policies (objects are never copied) | API and SQL |
| Auth config | Management API, or GoTrue on self-hosted | API (hosted) |
| Cron jobs | `cron.job` | SQL |
| Webhooks | Triggers calling `supabase_functions.http_request` | SQL |
| Realtime | Publications, and policies on `realtime.messages` | SQL |
| Vault | Secret names and descriptions (values can't be read) | Command to run |
| Extensions | `pg_extension` | SQL |
| Migration history | Local migration files against `supabase_migrations` (target only) | SQL, opt-in |
| Roles and grants | Custom roles, and grants on tables, views, sequences and functions, including `anon`, `authenticated`, `service_role` | SQL |

The schema check covers tables, columns, keys, indexes, partitions, views,
materialized views, functions, triggers, sequences, enums, composite types,
domains, policies, extensions and comments. It runs in every schema except
Supabase's own (`auth`, `storage`, and so on) and those in `ignoreSchemas`.
Objects owned by an extension belong to it and aren't compared.

A check that can't run, for example without API credentials, says so and why.
It's never reported as a clean pass.

## Commands

```
supaforge init                    Create a config interactively
supaforge diff                    Report drift (alias: hukam)
supaforge sync                    Alias for diff --apply

supaforge snapshot --apply        Capture an environment's structure and configuration
supaforge restore --apply         Rebuild a database from a snapshot or migrations
supaforge clone --apply           Copy a remote database to a local one

supaforge migrate create          Write a migration file from the current drift
supaforge migrate list            Local migrations, applied and pending
supaforge migrate run --apply     Run pending migrations
supaforge migrate baseline --apply  Mark migrations applied without running them

supaforge report                  Recent runs, from a local log
supaforge mcp                     MCP server for AI agents
supaforge help <command>          Every flag, e.g. help diff
```

Useful `diff` flags:

| Flag | Does |
| --- | --- |
| `--check=rls` / `--skip=storage` | One check, or all but some (`--skip` repeats) |
| `--tables=orders,items` / `--exclude-tables='*_log'` | Scope the schema and data checks |
| `--only=<id,...>` | Apply only these findings (ids come from `--json`, globs allowed) |
| `--dry-run` | Print the fixes in the order they'd run, run nothing |
| `--prove` | Rehearse the fixes on a throwaway copy first |
| `--allow-destructive` | Also apply drops and deletes |
| `--apply-posture` | Also apply the target-only checks' fixes |
| `--no-transaction` | Apply fix by fix, keeping what works |
| `--json` / `--ci` | Machine-readable output; CI annotations and exit codes |

## Applying fixes safely

- **Preview first.** `diff`, `snapshot`, `restore`, `clone` and `migrate run`
  write nothing without `--apply`.
- **Destructive fixes need a second flag.** Dropping a schema, table or
  column, deleting or truncating rows, and removing an RLS policy are reported
  but skipped until you add `--allow-destructive`. `migrate run` uses the same
  gate.
- **Dependency order.** Fixes run in dependency order: functions before the
  triggers that call them, columns before their indexes, drops last. A changed
  object that has to be dropped and recreated is a single fix.
- **One transaction.** If a fix fails, the whole set rolls back and the target
  is unchanged. A fix the target can't hold, because it needs an extension or
  a Supabase schema the target lacks, is skipped with the reason, and the rest
  still applies.
- **`--prove`.** The fixes are replayed on a structure-only copy of the target,
  made on the target's own server, the way the apply will run them. Nothing is
  applied unless the result matches the source, and nothing is applied if the
  proof can't run. Changes a copy can't hold, such as cron jobs (pg_cron lives
  in one database per server), are listed as not proved.

```bash
supaforge diff --dry-run                 # the plan, in order
supaforge diff --apply --prove           # rehearse, then apply
supaforge diff --apply --only='schema-create-*'
```

### Posture checks

RLS coverage and migration history look at the target alone, so they report
the same findings whichever pair you diff. They're scored separately
(`Posture score`), don't set the exit code unless you pass
`--fail-on-posture`, and their fixes apply only with `--apply-posture`, or
when you name the check, as in `--check=rls-coverage --apply`. Applying them
blindly would move the target away from the source.

## Snapshot, restore and clone

```bash
supaforge snapshot --env=prod --apply                     # capture
supaforge snapshot --env=prod --migration --apply         # and write what changed since the last one
supaforge restore --env=local --from-snapshot=latest --apply
supaforge clone --env=prod --apply                        # local copy, data included
```

A snapshot records a project's structure and configuration: schema, RLS
policies, cron, webhooks, extensions, storage, auth, Edge Functions,
reference data, Realtime, Vault names and grants. **It is not a
backup.** It holds no rows beyond `checks.data.tables`, and no stored files.

`restore --from-snapshot` puts back:

| Restored | Notes |
| --- | --- |
| Extensions, schema, RLS policies, cron jobs, webhooks, Realtime publications, grants | As SQL, in dependency order. Roles a policy or grant names are created first |
| Storage policies and buckets | Bucket rows are created when the target has a `storage` schema; files never are |
| Reference data | The rows of `checks.data.tables`, parents before children, sequences moved past the restored ids |

It can't put back auth config, Edge Functions (deploy them with
`supabase functions deploy`), or Vault secret values. Each of these is named in
the output.

- **Targets.** Restore runs as one transaction and expects an empty database.
  `--force` clears the snapshot's own schemas first (never Supabase's) and
  puts back the triggers and policies outside them that depended on what it
  cleared.
- **Plain PostgreSQL.** Restoring into plain PostgreSQL works. What can't
  exist there is skipped and named: a foreign key to `auth.users`, a webhook,
  an extension the server doesn't ship, and everything that needs it.
- **Exit code.** A restore that left anything out exits 1. So does one that
  refused to run.
- **JSON.** `--json` prints only JSON, for a preview too.

`clone` copies a remote database into a local server with `pg_dump` and
`pg_restore` (`--schema-only` to leave the rows behind). Extensions the local
server has are installed first. Objects it couldn't restore are listed by
cause. Afterwards the config's `target` points at the clone, so a bare
`diff --apply` writes there rather than to the remote.

## Migrations

```bash
supaforge migrate create --name=add_orders   # from the drift between source and target
supaforge migrate run --env=prod             # preview
supaforge migrate run --env=prod --apply
```

- **Files and history.** Files live in `supabase/migrations` (set
  `checks.migrations.dir` to change it). Applied versions are recorded in
  `supabase_migrations.schema_migrations`, the Supabase CLI's table.
- **Destructive statements.** `migrate create` lists any it wrote, and
  `migrate run` needs `--allow-destructive` to run them.
- **History table permissions.** On a self-hosted stack the history table can
  belong to an admin role. SupaForge then says which `GRANT` is needed instead
  of failing with a bare permission error.
- **Projects without a tracked history.** `checks.migrations.mode` decides
  how the migration-history check reports them: `auto` (one note when nothing
  is tracked), `warn` or `ignore`.

## Configuration

```json
{
  "environments": {
    "dev":  { "dbUrl": "$DEV_DATABASE_URL",  "projectRef": "abc123", "accessToken": "$SUPABASE_ACCESS_TOKEN" },
    "prod": { "dbUrl": "$PROD_DATABASE_URL", "projectRef": "xyz789", "accessToken": "$SUPABASE_ACCESS_TOKEN" }
  },
  "source": "dev",
  "target": "prod",
  "checks": {
    "data": { "tables": ["plans", "feature_flags"] },
    "exclude": ["edge-functions"]
  }
}
```

| Field | Meaning |
| --- | --- |
| `dbUrl` | PostgreSQL connection string. `$VAR` and `${VAR}` are read from the environment |
| `projectRef`, `accessToken` | Enable the Management API checks (auth, Edge Functions) |
| `apiUrl` | A self-hosted API gateway, used instead of `projectRef` |
| `studioUrl`, `functionsPath` | Where self-hosted Edge Functions are read from |
| `source`, `target` | What to compare: the source is the truth, the target gets fixed |
| `ignoreSchemas` | Schemas of your own to leave out |
| `checks.data.tables` | Tables whose rows are compared and snapshotted |
| `checks.exclude` | Checks never to run (merged with `--skip`) |
| `checks.tables`, `checks.excludeTables` | Default scope for the schema and data checks |
| `checks.migrations.dir`, `checks.migrations.mode` | Where migrations live and how the history check reports |

- **Per environment.** `checks.exclude` and `checks.schema.timeout` can also
  be set on an environment, and apply when it's the target.
- **`.env` files.** `.env` files are loaded the Next.js way:
  `.env.{NODE_ENV}.local`, `.env.local`, `.env.{NODE_ENV}`, `.env`. Values
  already in the environment win.
- **Single database.** A config with a single environment and no
  `source`/`target` is fine. Use `snapshot`, `clone` and `restore`.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SUPAFORGE_DBDIFF_TIMEOUT` | `600` | Seconds before the schema or data diff gives up |
| `SUPAFORGE_DBDIFF_MEMORY` | `1G` | Memory limit for `@dbdiff/cli` (`2G`, `-1` for none) |
| `SUPAFORGE_CONNECT_TIMEOUT` | `15` | Seconds to wait for a connection |
| `SUPAFORGE_CHECK_CONCURRENCY` | `4` | Checks run at once. Lower it behind a tight pooler |
| `SUPAFORGE_PG_BIN` | — | A directory of PostgreSQL client tools (`pg_dump`, `psql`), used ahead of `PATH` — for a server newer than the tools on `PATH` |

## Self-hosted Supabase

Set `apiUrl` to the gateway and `accessToken` to the service-role key. All
checks run.

- **Edge Functions.** Self-hosted has no management endpoint for Edge
  Functions, so set `studioUrl` (Studio's port, not the gateway's) or
  `functionsPath` (the mounted functions directory). The two can be mixed
  across environments. Studio's functions API is unauthenticated, so don't
  expose it publicly.
- **Auth config.** On self-hosted, auth config is read from GoTrue's settings
  endpoint, which carries fewer keys and can't be written. Change the
  deployment's environment instead.

## Diffing a clone

A local clone is plain PostgreSQL. Storage, auth, Edge Functions, Vault,
Realtime and Supabase's roles have nothing to compare there, so skip those
checks:

```json
{ "checks": { "exclude": ["storage", "auth", "edge-functions", "vault", "realtime", "roles"] } }
```

When the source is a clone and the target isn't, `diff` warns that `--apply`
would push the clone's shape, absences included, onto the target.

## CI and exit codes

```yaml
- run: npx @akal/supaforge diff --ci
  env:
    DEV_DATABASE_URL: ${{ secrets.DEV_DATABASE_URL }}
    PROD_DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
```

| Code | Meaning |
| --- | --- |
| `0` | Did what was asked, including when there was nothing to do |
| `1` | Found drift, declined to act, or something failed or was left out |
| `2` | Couldn't run: a usage error, or under `--ci` a check that couldn't finish |

`--ci` fails on critical drift by default. Set the threshold with
`--fail-on=warning` or `--fail-on=any`.

## MCP (AI agents)

```json
{ "mcpServers": { "supaforge": { "command": "supaforge", "args": ["mcp"] } } }
```

The server exposes these tools:

| Tool | Annotation |
| --- | --- |
| `scan_drift` | Read-only |
| `get_check_result` | Read-only |
| `apply_fixes` | Destructive. Previews unless `dryRun: false` |
| `take_snapshot` | Writes files |
| `create_migration` | Writes files |

It reads the config in its own directory, and refuses a `configPath` from a
client unless started with `--allow-config-path`.

## Hooks

```ts
import { HookBus, scan, createDefaultRegistry, loadConfig } from '@akal/supaforge'

const bus = new HookBus()
bus.on('supaforge.check.after', ({ check, result }) => {
  if (result.status === 'drifted') console.log(`Drift in ${check}`)
})
await scan(createDefaultRegistry(), { config: await loadConfig() }, bus)
```

## Development

```bash
cd packages/cli
npm install
npm test                 # unit tests
npm run lint             # type-check
./bin/dev.js diff        # run from source
```

| Suite | Command | Needs |
| --- | --- | --- |
| Integration | `npm run test:integration` | Docker or Podman |
| Database e2e | `npm run test:e2e` | Docker or Podman |
| Scenarios | `npx vitest run -c vitest.scenarios.config.ts` | Docker or Podman, `pg_dump` |
| Supabase e2e | `npm run test:e2e:supabase` | Supabase CLI |
| Release candidates | `scripts/test-release-candidates.sh --dbdiff ../DBDiff --pg-conformance ../pg-conformance` | Podman or Docker |

The release-candidates script builds DBDiff's binary and the npm packages
from local checkouts the way a release does, installs SupaForge against them
as a user would, and runs every suite above against that install. It tests
changes that span the three projects together, before any of them is
released.

The scenario suite migrates every case in the
[`@akal/pg-conformance`](https://www.npmjs.com/package/@akal/pg-conformance) corpus in both
directions. It checks the result against the corpus's own state oracle and
against `--prove`.

## License

MIT
