<h1 align="center">SupaForge</h1>

<p align="center">
  <strong>Diff, sync and clone Supabase and Postgres environments - and prove every change before it reaches production.</strong>
</p>

<p align="center">
  <a href="https://github.com/akalsoftware/supaforge/actions/workflows/ci.yml"><img src="https://github.com/akalsoftware/supaforge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@akal/supaforge"><img src="https://img.shields.io/npm/v/@akal/supaforge.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@akal/supaforge"><img src="https://img.shields.io/npm/dm/@akal/supaforge.svg" alt="npm downloads"></a>
  <a href="https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.akalsoftware/supaforge"><img src="https://img.shields.io/badge/MCP_Registry-supaforge-blue" alt="MCP Registry"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="https://supaforge.dev">Website</a> ·
  <a href="packages/cli/README.md">Documentation</a> ·
  <a href="https://supaforge.dev/guides">Guides</a> ·
  <a href="https://github.com/akalsoftware/supaforge-action">GitHub Action</a>
</p>

---

Dev, staging and production drift apart, and nothing tells you until
something breaks. A policy added in staging never reaches production. A bucket
is public in one place only. A cron job, webhook or grant exists on one side
and not the other. A migration that worked on your laptop locks a live table.

**SupaForge finds every one of those differences across the whole project, not
just the schema, and makes the target match the source safely.** It works
with Supabase Cloud, self-hosted Supabase, local stacks and plain PostgreSQL.

```bash
npx @akal/supaforge init     # point it at two environments
npx @akal/supaforge diff     # see everything that differs
```

## Why teams use it

- **🔒 Catch security gaps before users do.** An RLS policy that never reached
  production leaves a table open to anyone with the anon key -
  CVE-2025-48757 exposed real apps exactly this way. SupaForge reports missing
  or changed policies, tables with RLS switched off, and what `anon`,
  `authenticated` and `service_role` can touch on each side.
- **🧭 The whole project, not just tables.** Schema and reference data, RLS
  policies, roles and grants, storage buckets and their policies, auth config,
  Edge Functions, cron jobs, queues, webhooks, Realtime, Vault, extensions and
  migration history.
- **🛡️ Fixes you can trust on a live database.** Fixes run in dependency
  order, in one transaction, and roll back cleanly if anything fails. Each
  says which lock it takes and whether it rewrites a table. Anything that loses
  data or opens up access waits for `--allow-destructive`.
- **✅ Proof before change.** `--prove` rehearses the migration on a throwaway
  copy of the target, rows included, and applies nothing unless the result
  matches the source.
- **🤖 Safe for AI agents.** A built-in MCP server lets Claude, Cursor and VS
  Code agents diff and sync your environments, showing you the plan before
  anything is written.
- **⚙️ Built for pipelines.** `--ci` adds GitHub annotations and meaningful
  exit codes, `--json` is machine-readable throughout, and the GitHub Action
  puts a drift summary on every run.

## Quick start

```bash
npm install -g @akal/supaforge

supaforge init              # create supaforge.config.json
supaforge diff              # what has drifted?
supaforge diff --detail     # with the SQL
supaforge diff --apply      # fix the target
supaforge diff --apply --prove   # rehearse on a copy first, then fix
```

Only one project? Snapshot it, restore it anywhere, or clone it locally:

```bash
supaforge snapshot --env=prod --apply                       # record it
supaforge restore --env=local --from-snapshot=latest --apply
supaforge clone --env=prod --apply                          # local copy, data included
```

Everything that writes previews first. Add `--apply` to make it happen.

## Use it where you work

| Where | How |
| --- | --- |
| Terminal | `npm install -g @akal/supaforge`, `npx @akal/supaforge`, or `brew install akalsoftware/tap/supaforge` |
| Docker | `docker run --rm -v "$PWD:/work" ghcr.io/akalsoftware/supaforge diff` |
| GitHub Actions | [`akalsoftware/supaforge-action`](https://github.com/akalsoftware/supaforge-action) |
| Claude Code | `/plugin marketplace add akalsoftware/claude-plugins`, then `/plugin install supaforge@akalsoftware` |
| Claude Desktop, Cursor, VS Code | One-click MCP installs - see [MCP](packages/cli/README.md#mcp-ai-agents) |

**[Full documentation →](packages/cli/README.md)**: every check, command and
flag, the safety model, snapshots and restore, migrations, configuration,
self-hosted Supabase, CI and MCP.

## Under the hood

The schema and data checks are powered by
[DBDiff](https://github.com/DBDiff/DBDiff), installed automatically as a
native binary with no PHP needed. Every release is tested by migrating a
corpus of PostgreSQL shapes in both directions, and checking each result
against an independent catalog oracle and against `--prove`.

| Path | What |
| --- | --- |
| [`packages/cli`](packages/cli) | The `supaforge` CLI and library, published as [`@akal/supaforge`](https://www.npmjs.com/package/@akal/supaforge) |
| [`packages/vscode`](packages/vscode) | The VS Code extension |
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

[MIT](LICENSE). Built by [Akal Software](https://akalsoftware.com).
Copyright (c) 2026 Akal Software Ltd
