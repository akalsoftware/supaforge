/**
 * Values that travel as text between servers that print them differently.
 *
 * Each server's DateStyle, IntervalStyle, TimeZone, extra_float_digits and
 * bytea_output decide how a value prints, and two servers rarely agree —
 * Supabase ships extra_float_digits = 0. Text printed under one and read
 * under another changed the value: 2 January printed `02/01/2026` under DMY
 * came back as 1 February, and a double came back rounded to 15 digits.
 *
 * Every value here is compared by what it is, not how it prints: dates by
 * their distance from an epoch, doubles by their bytes.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const skew = (settings: Record<string, string>) => `DO $$ BEGIN ${Object.entries(settings)
  .map(([k, v]) => `EXECUTE format('ALTER DATABASE %I SET ${k} = %L', current_database(), '${v}');`).join(' ')} END $$;`

const CAL = 'CREATE TABLE public.cal (id int PRIMARY KEY, d date, ts timestamp, tz timestamptz, iv interval, f float8, b bytea);'
const ROWS = `INSERT INTO public.cal VALUES
  (1, '2026-01-02', '2026-01-13 03:04:05.123456', '2026-01-02 03:04:05.5+00', '-1 year +2 days -03:04:05', 0.30000000000000004, '\\x00ff'),
  (2, '4713-01-01 BC', '0001-01-13 00:00:00 BC', 'infinity', '1 mon', 1.7976931348623157e308, '\\x'),
  (3, '2026-12-31', '2026-02-13 23:59:59', '1999-12-31 23:59:59.999999+00', '13 days', 1/3::float8, '\\x5c27');`

/** Each row as what it is, whatever the session prints it as. */
const EXACT = `SELECT string_agg(concat_ws('|', id, d - date '2000-01-01', extract(epoch from ts), extract(epoch from tz),
  extract(month from iv), extract(day from iv), extract(epoch from iv), encode(float8send(f), 'hex'), encode(b, 'hex')), ' / ' ORDER BY id)
  FROM public.cal`

describeE2E('e2e: values between servers that print them differently', () => {
  let h: PgHarness
  let ws: string

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', skew({
      DateStyle: 'SQL, DMY', IntervalStyle: 'sql_standard', TimeZone: 'Pacific/Chatham', extra_float_digits: '0', bytea_output: 'escape',
    }) + CAL + ROWS + 'CREATE TABLE public.extra (id int PRIMARY KEY, note text);')
    await h.applySql('target', skew({ DateStyle: 'German, DMY', IntervalStyle: 'iso_8601', TimeZone: 'America/St_Johns', extra_float_digits: '0' }) + CAL
      + 'CREATE TABLE public.extra (id int PRIMARY KEY);')
    await h.createDatabase('target', 'sf_restored')
    ws = await h.workspace({
      environments: {
        source: { dbUrl: h.connectionString('source') },
        target: { dbUrl: h.connectionString('target') },
        restored: { dbUrl: h.urlFor('target', 'sf_restored') },
      },
      checks: { data: { tables: ['cal'] } },
    })
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('syncs rows exactly, and then finds them equal', async () => {
    const run = await h.cli(['diff', '--check', 'data', '--apply', '--json'], { cwd: ws })
    expect(JSON.parse(run.stdout).errors).toEqual([])
    expect(await h.sql('target', EXACT)).toBe(await h.sql('source', EXACT))

    const again = JSON.parse((await h.cli(['diff', '--check', 'data', '--json'], { cwd: ws })).stdout)
    expect(again.checks.flatMap((c: { issues: unknown[] }) => c.issues)).toEqual([])
  }, 300_000)

  it('restores a snapshot\'s rows exactly into a server that reads dates another way', async () => {
    const snap = await h.cli(['snapshot', '-e', 'source', '--apply'], { cwd: ws })
    expect(snap.code, snap.stdout + snap.stderr).toBe(0)
    const [snapshot] = await readdir(join(ws, '.supaforge', 'snapshots'))
    const restore = await h.cli(['restore', '-e', 'restored', '--from-snapshot', snapshot, '--apply'], { cwd: ws })
    expect(restore.code, restore.stdout + restore.stderr).toBe(0)
    expect(await h.sqlIn('target', 'sf_restored', EXACT)).toBe(await h.sql('source', EXACT))
  }, 600_000)

  // The other side of pinning: SQL the user wrote is read as psql would read
  // it, under the database's own DateStyle — day first, on this target.
  it('runs a migration under the database\'s own settings', async () => {
    await mkdir(join(ws, 'supabase', 'migrations'), { recursive: true })
    await writeFile(join(ws, 'supabase', 'migrations', '20260101000000_dates.sql'),
      "CREATE TABLE public.dated (d date); INSERT INTO public.dated VALUES ('02/01/2026');\n")
    const run = await h.cli(['migrate', 'run', '-e', 'target', '--apply'], { cwd: ws })
    expect(run.code, run.stdout + run.stderr).toBe(0)
    expect(await h.sql('target', `SELECT to_char(d, 'YYYY-MM-DD') FROM public.dated`)).toBe('2026-01-02')
  }, 300_000)

  it('loads a --prove sample from a target that prints dates day first', async () => {
    const run = await h.cli(['diff', '--check', 'schema', '--apply', '--prove'], { cwd: ws })
    expect(run.code, run.stdout + run.stderr).toBe(0)
    expect(run.stdout).not.toContain('Rows not checked')
    expect(run.stdout).toMatch(/Rows kept/)
  }, 600_000)
})
