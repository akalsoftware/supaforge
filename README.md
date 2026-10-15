# SupaForge

> Diff and sync your Supabase environments.

[![CI](https://github.com/akalsoftware/supaforge/actions/workflows/ci.yml/badge.svg)](https://github.com/akalsoftware/supaforge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@akal/supaforge.svg)](https://www.npmjs.com/package/@akal/supaforge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Supabase projects running as dev, staging and production drift apart, and
nothing in Supabase tells you. A policy added in staging never reaches
production; a bucket goes public in one place only; a cron job, webhook or
grant exists on one side and not the other.

SupaForge finds every one of those differences across the whole project, not
just the schema. It then makes the target match the source safely, and can
prove the result before it touches anything.

**CVE-2025-48757** found 170+ apps with exposed databases because RLS policies
never reached production. SupaForge catches that on the first scan.

Built by **[Akal](https://github.com/akalsoftware)**.

## Why SupaForge

- **The whole project.** It compares more than tables and columns:
  - RLS policies and RLS coverage;
  - storage buckets and their policies;
  - auth config and Edge Functions;
  - cron jobs, queues, webhooks and Realtime;
  - Vault, extensions, roles and grants;
  - reference data and migration history.
- **Fixes, not just reports.** Fixes run in dependency order, in one
  transaction, and roll back cleanly if anything fails. Anything that would
  lose data or open up access waits for an explicit `--allow-destructive`.
- **Proof before change.** `--prove` rehearses the migration on a throwaway
  copy of the target and applies nothing unless the result matches the
  source.
- **One project is enough.** Snapshot a project's structure and
  configuration, restore it into an empty database (Supabase or plain
  PostgreSQL), or clone it locally with its data.
- **Hosted and self-hosted.** It works with Supabase Cloud, self-hosted
  stacks, and local clones.
- **Built for pipelines and agents.** `--ci` gives GitHub annotations and
  meaningful exit codes, `--json` output is machine-readable throughout, and a
  built-in MCP server lets AI agents scan and fix safely.

## Quick start

```bash
npm install -g @akal/supaforge

supaforge init              # create supaforge.config.json
supaforge diff              # what has drifted?
supaforge diff --detail     # with the SQL
supaforge diff --apply      # fix the target
```

Only one project?

```bash
supaforge snapshot --env=prod --apply                       # record it
supaforge restore --env=local --from-snapshot=latest --apply
supaforge clone --env=prod --apply                          # local copy, data included
```

Everything that writes previews first. Add `--apply` to make it happen.

Also on Homebrew (`brew install akalsoftware/tap/supaforge`), as a
[GitHub Action](https://github.com/akalsoftware/supaforge-action), and as an
MCP server for Cursor, VS Code and Claude, with one-click installs — see
[Install](packages/cli/README.md#install).

**[Full documentation →](packages/cli/README.md)**: the checks, commands,
safety model, snapshots and restore, migrations, configuration, self-hosted
Supabase, CI and MCP.

## Under the hood

The schema and data checks are powered by
[DBDiff](https://github.com/DBDiff/DBDiff), installed automatically as a
native binary with no PHP needed. Every release is tested by migrating a
corpus of PostgreSQL shapes in both directions, and checking each result
against an independent catalog oracle and against `--prove`.

| Path | What |
| --- | --- |
| [`packages/cli`](packages/cli) | The `supaforge` CLI and library, published as [`@akal/supaforge`](https://www.npmjs.com/package/@akal/supaforge) |
| [`packages/mcp`](packages/mcp) | A standalone build of the MCP server, not published. Use `supaforge mcp` |

## Development

```bash
git clone https://github.com/akalsoftware/supaforge.git
cd supaforge/packages/cli
npm install
npm test && npm run lint
./bin/dev.js diff
```

The integration, database e2e, scenario and Supabase e2e suites are described
in the [package README](packages/cli/README.md#development). CI runs all of
them on every pull request.

### Releasing

Run the **Trigger Release** workflow (Actions → Trigger Release) with `patch`,
`minor`, `major` or an exact version. It bumps the version, tags it, and
publishes to npm.

`node scripts/release.js patch` does the same steps locally, as a dry run
unless given `--apply`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Copyright (c) 2026 Akal Software Ltd
