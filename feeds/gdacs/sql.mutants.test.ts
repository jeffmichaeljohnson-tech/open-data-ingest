/**
 * sql.mutants.test.ts — closing the mutation gaps on feeds/gdacs/sql.ts.
 *
 * SECURITY.md names "Injection into generated SQL" the most serious class in this
 * project, and a generated-mutant run scored this file the weakest. These tests are
 * the missing coverage, organised by the priority order in the finding:
 *   1. escaping / injection — a feed value must stay a VALUE, never become syntax
 *   2. the append-only ON CONFLICT DO NOTHING property
 *   3. NULL versus a genuine value, kept distinct in the generated statement
 *   4. the remaining structural literals (parens, commas, casts, headers, seeds)
 *
 * These tests build GdacsEvent records DIRECTLY rather than through the transform,
 * because the concern under test is the SQL emitter alone. Expected statements are
 * frozen, hand-written oracles (never re-derived by the same string-building the
 * source uses), so an assertion can actually fail.
 *
 * A note on the escaping: `lit` doubles a single quote and leaves every other byte
 * untouched. That is COMPLETE and CORRECT under PostgreSQL's default
 * `standard_conforming_strings = on`, where the only byte that can end a single-
 * quoted literal is an unescaped `'`. Backslash, newline, NUL, `--`, `;` and `$$`
 * are all inert inside the literal, so doubling the quote contains them.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { buildEventInsert, buildFeedSeed, buildHeartbeatUpsert, buildLicenceSeed } from './sql.ts';
import type { GdacsEvent } from './gdacs.ts';

/** A fully-populated, located GDACS event. occurred_at and retrieved_at are kept
 *  DIFFERENT so a test can tell the two ::timestamptz casts apart. */
function ev(overrides: Partial<GdacsEvent> = {}): GdacsEvent {
  return {
    feed_key: 'gdacs_events',
    external_id: 'TC-1001297-55',
    event_type: 'cyclone',
    occurred_at: '2026-08-14T21:58:21.000Z',
    lon: 120.6,
    lat: 27.9,
    magnitude: null,
    magnitude_kind: null,
    source: 'GDACS',
    release_version: '2026-08-17T09:28:28.000Z',
    retrieved_at: '2026-08-17T22:00:00.000Z',
    licence_key: 'gdacs_cc_by_4',
    event_type_code: 'TC',
    event_id: '1001297',
    episode_id: '55',
    name: 'Tropical Cyclone DOLPHIN-26',
    alert_level: 'Orange',
    alert_score: 2,
    severity_value: 18419,
    severity_text: 'Orange impact',
    severity_unit: 'ha',
    affected_iso3: ['PHL'],
    source_country_claim: 'PHL',
    glide: 'XX-2026-000001-PHL',
    report_url: 'https://www.gdacs.org/report.aspx?eventid=1001297',
    ...overrides,
  };
}

// A frozen oracle for the canonical row. Pins column order, the leading '(' and
// trailing ')', every ', ' separator, both ::timestamptz casts, the fully-qualified
// geom, the two NULL magnitude cells, and the append-only conflict clause — one
// assertion closing the paren/comma/cast/header structural mutants together.
const CANONICAL_INSERT =
  'insert into atlas.event (feed_key, external_id, event_type, occurred_at, geom, magnitude, magnitude_kind, source, release_version, retrieved_at, licence_key)\n' +
  "values\n  ('gdacs_events', 'TC-1001297-55', 'cyclone', '2026-08-14T21:58:21.000Z'::timestamptz, " +
  "public.st_setsrid(public.st_makepoint(120.6, 27.9), 4326), NULL, NULL, 'GDACS', " +
  "'2026-08-17T09:28:28.000Z', '2026-08-17T22:00:00.000Z'::timestamptz, 'gdacs_cc_by_4')\n" +
  'on conflict on constraint event_dedup do nothing;\n';

// ---------------------------------------------------------------------------
// 1. ESCAPING / INJECTION — the security claim, made real.
// ---------------------------------------------------------------------------

Deno.test('gdacs sql — a single quote in a feed value is doubled; the value cannot end its literal', () => {
  // NEGATIVE CONTROL: an ordinary value produces the ordinary literal, so this test
  // cannot pass against a function that mangles every value into 'NULL' or ''.
  const ordinary = buildEventInsert([ev({ release_version: '2026-08-17T09:28:28.000Z' })]);
  assertStringIncludes(ordinary, "'2026-08-17T09:28:28.000Z'");

  // INJECTION: a release_version that tries to close the literal and append a
  // statement. Correct escaping doubles the quote, so the payload stays one value.
  const sql = buildEventInsert([ev({ release_version: "v'; DROP TABLE atlas.event; --" })]);
  assertStringIncludes(sql, "'v''; DROP TABLE atlas.event; --'"); // quote doubled, still one literal
  assert(!sql.includes("'v'; DROP"), 'the single unescaped quote form must never appear');
  // structure around the injected value is intact — it did not become syntax
  assertStringIncludes(sql, "'GDACS', 'v''; DROP TABLE atlas.event; --', '2026-08-17T22:00:00.000Z'::timestamptz");
});

Deno.test('gdacs sql — a payload of every SQL metacharacter stays inside one quoted literal', () => {
  // quote + backslash + newline + NUL + comment + statement separator + dollar-quote.
  const payload = "x'); DROP TABLE atlas.event; --\\\n$$" + String.fromCharCode(0) + 'end';
  const sql = buildEventInsert([ev({ external_id: payload })]);
  // Hand-written oracle (NOT re-derived from payload): only the quote is doubled;
  // every other byte is carried verbatim, which is correct under standard_conforming_strings.
  const expectedLiteral = "'x''); DROP TABLE atlas.event; --\\\n$$" + String.fromCharCode(0) + "end'";
  assertStringIncludes(sql, expectedLiteral);
  // and the row still closes and reaches the conflict clause after the payload
  assertStringIncludes(sql, 'on conflict on constraint event_dedup do nothing;\n');
});

Deno.test('gdacs sql — a backslash is passed through literally, never doubled (no over-escaping)', () => {
  const ordinary = buildEventInsert([ev({ external_id: 'FL-1-1' })]); // negative control
  assertStringIncludes(ordinary, "'FL-1-1'");
  // A backslash is inert inside a standard-conforming literal, so it must survive as-is.
  const sql = buildEventInsert([ev({ external_id: 'a\\b' })]);
  assertStringIncludes(sql, "'a\\b'");
});

Deno.test('gdacs heartbeat — the content hash is escaped in BOTH places it appears', () => {
  const clean = buildHeartbeatUpsert('sha-abc', 70); // negative control
  assertStringIncludes(clean, "distinct from 'sha-abc'");
  assertStringIncludes(clean, "'sha-abc', 70, 'ok', now())");

  // The hash reaches SQL twice: the CASE comparison and the VALUES tuple. A quote in
  // it must be doubled at BOTH sites, or one becomes an injection point.
  const sql = buildHeartbeatUpsert("h'; DROP--", 5);
  const occurrences = sql.split("'h''; DROP--'").length - 1;
  assertEquals(occurrences, 2, 'the escaped hash must appear at both call sites');
  assert(!sql.includes("'h'; DROP--'"), 'the unescaped hash must never appear');
  assertStringIncludes(sql, "'h''; DROP--', 5, 'ok', now())"); // rowCount stays an unquoted number
});

// ---------------------------------------------------------------------------
// 2. APPEND-ONLY — ON CONFLICT DO NOTHING, and a mutant to UPSERT would be seen.
// ---------------------------------------------------------------------------

Deno.test('gdacs sql — the event insert is DO NOTHING, never an upsert that overwrites history', () => {
  const sql = buildEventInsert([ev()]);
  assertStringIncludes(sql, 'on conflict on constraint event_dedup do nothing;\n');
  // append-only means the row insert must NOT carry an update action — a mutant that
  // turned DO NOTHING into DO UPDATE (silently overwriting episode history) is visible here.
  assert(!sql.includes('do update set'), 'an event insert must never become an upsert');
});

Deno.test('gdacs sql — an override lands a later episode as a NEW row, never overwriting the original', () => {
  // NO override: the row must carry the event's OWN release_version, not a NULL. This
  // catches a `??`-to-`&&` mutation that drops the value when no override is given.
  const original = buildEventInsert([ev()]);
  assertStringIncludes(original, "'2026-08-17T09:28:28.000Z'");
  assert(!original.includes('-ep56'));

  // WITH override: both the id suffix AND the replacement vintage must reach the SQL;
  // a mutation that ignores the override would leave the original vintage in place.
  const later = buildEventInsert([ev()], { externalIdSuffix: '-ep56', releaseVersion: '2026-09-01T00:00:00.000Z' });
  assertStringIncludes(later, "'TC-1001297-55-ep56'");
  assertStringIncludes(later, "'2026-09-01T00:00:00.000Z'");
  assert(!later.includes("'2026-08-17T09:28:28.000Z'"), 'the override must replace the original vintage, not sit beside it');
});

// ---------------------------------------------------------------------------
// 3. NULL vs a fabricated point / empty — a null must render as the token NULL.
// ---------------------------------------------------------------------------

Deno.test('gdacs sql — an unlocated event emits a NULL geom, never an empty cell or a fake point', () => {
  const located = buildEventInsert([ev()]); // negative control: a real point
  assertStringIncludes(located, 'public.st_setsrid(public.st_makepoint(120.6, 27.9), 4326)');

  const sql = buildEventInsert([ev({ lon: null, lat: null })]);
  // geom sits between occurred_at and magnitude; a null coordinate is the literal NULL,
  // not '' (which would collapse two commas) and not a fabricated point.
  assertStringIncludes(sql, "'2026-08-14T21:58:21.000Z'::timestamptz, NULL, NULL, NULL, 'GDACS'");
  assert(!sql.includes('st_makepoint'), 'an unlocated event must not build a point');
});

Deno.test('gdacs sql — a non-finite coordinate becomes NULL geom, never makepoint(Infinity)', () => {
  // The isFinite guard is the only thing standing between a corrupt coordinate and a
  // point built from Infinity. A mutant removing it would emit makepoint(Infinity, ...).
  const sql = buildEventInsert([ev({ lon: Infinity, lat: 20 })]);
  assert(!sql.includes('makepoint(Infinity'), 'a non-finite lon must not reach makepoint');
  assert(!sql.includes('makepoint(NULL'), 'the whole geom is NULL, not a partial point');
  assertStringIncludes(sql, '::timestamptz, NULL, NULL, NULL, ');
});

Deno.test('gdacs sql — the two always-NULL magnitude cells render as NULL, not empty strings', () => {
  const sql = buildEventInsert([ev()]);
  // If lit's 'NULL' return were emptied, these would collapse to a doubled comma.
  assertStringIncludes(sql, ', NULL, NULL, ');
  assert(!sql.includes(', , '), 'a null value must never render as an empty cell');
});

// ---------------------------------------------------------------------------
// 4. STRUCTURE — parens, commas, casts, headers, empty-guard, seeds.
// ---------------------------------------------------------------------------

Deno.test('gdacs sql — the canonical single-row insert matches its frozen statement exactly', () => {
  assertEquals(buildEventInsert([ev()]), CANONICAL_INSERT);
});

Deno.test('gdacs sql — occurred_at and retrieved_at each keep a distinct ::timestamptz cast', () => {
  const sql = buildEventInsert([ev()]);
  assertStringIncludes(sql, "'2026-08-14T21:58:21.000Z'::timestamptz"); // occurred_at
  assertStringIncludes(sql, "'2026-08-17T22:00:00.000Z'::timestamptz"); // retrieved_at
  assertEquals(sql.split('::timestamptz').length - 1, 2, 'exactly two timestamptz casts, one per instant');
});

Deno.test('gdacs sql — an empty batch is a comment, never an INSERT with an empty VALUES list', () => {
  const sql = buildEventInsert([]);
  assertEquals(sql, '-- (no GDACS event records to insert)\n');
  assert(!sql.includes('insert into'), 'zero rows must not emit a headless insert');
});

Deno.test('gdacs sql — multiple events become one insert with a row separator between tuples', () => {
  const sql = buildEventInsert([ev(), ev({ external_id: 'FL-2-1' })]);
  assertStringIncludes(sql, '),\n  ('); // the row separator between the two value tuples
  assertEquals(sql.split('insert into atlas.event').length - 1, 1, 'one header for the whole batch');
  assertStringIncludes(sql, "'TC-1001297-55'");
  assertStringIncludes(sql, "'FL-2-1'");
});

Deno.test('gdacs licence seed — every clause is present and idempotent', () => {
  const lic = buildLicenceSeed();
  assertStringIncludes(
    lic,
    'insert into atlas.source_licence (licence_key, label, spdx, url, attribution_required, attribution_text, share_alike, non_commercial, verified, verified_at, notes)',
  );
  assertStringIncludes(lic, "values ('gdacs_cc_by_4', 'CC BY 4.0 (via EC reuse policy)', 'CC-BY-4.0', ");
  assertStringIncludes(lic, "'https://commission.europa.eu/legal-notice_en', true, ");
  assertStringIncludes(lic, "'Source: GDACS (Global Disaster Alert and Coordination System), © European Union, licensed under CC BY 4.0.', ");
  assertStringIncludes(lic, "false, false, true, '2026-08-17', ");
  assertStringIncludes(lic, 'Commission Decision 2011/833/EU');
  assertStringIncludes(lic, "GDACS'' own terms page"); // the source doubles this quote itself
  assertStringIncludes(lic, 'on conflict (licence_key) do nothing;\n');
});

Deno.test('gdacs feed seed — every clause is present and idempotent', () => {
  const feed = buildFeedSeed();
  assertStringIncludes(feed, 'insert into atlas.feed (feed_key, display_name, clock, source_url, licence_key, cadence_hours, max_staleness_hours, ');
  assertStringIncludes(feed, 'change_detection, requires_browser_ua, requires_token, active, notes)');
  assertStringIncludes(feed, "values ('gdacs_events', 'GDACS global disaster alerts', 'event', ");
  assertStringIncludes(feed, "'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH', 'gdacs_cc_by_4', 3, 12, ");
  assertStringIncludes(feed, "'content_hash', true, false, true, ");
  assertStringIncludes(feed, 'Earthquakes excluded by default');
  assertStringIncludes(feed, 'on conflict (feed_key) do nothing;\n');
});

Deno.test('gdacs heartbeat — the two-clock upsert matches its frozen statement exactly', () => {
  // A frozen oracle for every literal chunk of the heartbeat: the insert header, the
  // CASE that gates clock 2 on a real hash change, and each update-set line.
  const expected = 'insert into atlas.feed_heartbeat (feed_key, last_success_at, last_change_at, last_release_token, last_row_count, last_status, updated_at)\n' +
    "values ('gdacs_events', now(),\n" +
    "  case when (select last_release_token from atlas.feed_heartbeat where feed_key = 'gdacs_events') is distinct from 'abc123'\n" +
    '       then now()\n' +
    "       else coalesce((select last_change_at from atlas.feed_heartbeat where feed_key = 'gdacs_events'), now()) end,\n" +
    "  'abc123', 70, 'ok', now())\n" +
    'on conflict (feed_key) do update set\n' +
    '  last_success_at   = excluded.last_success_at,\n' +
    '  last_change_at    = case when atlas.feed_heartbeat.last_release_token is distinct from excluded.last_release_token\n' +
    '                           then now() else atlas.feed_heartbeat.last_change_at end,\n' +
    '  last_release_token = excluded.last_release_token,\n' +
    '  last_row_count    = excluded.last_row_count,\n' +
    "  last_status       = 'ok',\n" +
    '  last_error        = null,\n' +
    '  updated_at        = now();\n';
  assertEquals(buildHeartbeatUpsert('abc123', 70), expected);
});
