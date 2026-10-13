# SupaForge for VS Code

Find and fix drift between your Supabase environments — schema, RLS policies,
roles and grants, auth, storage, webhooks, cron, vault, migrations and
reference data — from the editor, or let your AI agent do it, with your
approval for every change.

## Your AI agent

In a folder with a `supaforge.config.json`, the extension offers the
SupaForge MCP server to the editor's agent (Copilot agent mode in VS Code
1.101 and later). Ask it:

- *What has drifted between staging and production?*
- *Are there tables in production without RLS?*
- *Show me the SQL to bring production's policies in line — don't run it.*

Scanning writes nothing. Applying fixes asks you first, and drops and deletes
are never applied by the agent.

## Commands

From the Command Palette, under **SupaForge**:

| Command | Runs |
| --- | --- |
| Find Drift | `supaforge diff` |
| Find Drift, with the SQL | `supaforge diff --detail` |
| Preview Fixes | `supaforge diff --apply --dry-run` |
| Apply Fixes… | `supaforge diff --apply`, after you confirm — or with `--prove`, rehearsed on a throwaway copy first |
| Snapshot an Environment… | `supaforge snapshot --env=<name> --apply` |
| Create Config | `supaforge init` |

Each runs in a terminal, so you see exactly what it does.

## Requirements

Node.js 20 or newer. The extension runs SupaForge with `npx`, at the version
it was released with; set `supaforge.cliVersion` to choose another (e.g.
`latest`).

## Getting started

Run **SupaForge: Create Config**, or write `supaforge.config.json` yourself,
reading connection strings from the environment:

```json
{
  "environments": {
    "staging": { "dbUrl": "$STAGING_DATABASE_URL" },
    "production": { "dbUrl": "$PRODUCTION_DATABASE_URL" }
  },
  "source": "staging",
  "target": "production"
}
```

## More

[Documentation](https://github.com/akalsoftware/supaforge/tree/main/packages/cli#readme) ·
[supaforge.dev](https://supaforge.dev) ·
[Issues](https://github.com/akalsoftware/supaforge/issues)
