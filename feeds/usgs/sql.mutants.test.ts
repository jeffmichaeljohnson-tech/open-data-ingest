/**
 * sql.mutants.test.ts — closing the mutation gaps on feeds/usgs/sql.ts.
 *
 * SECURITY.md names "Injection into generated SQL" the most serious class, and this
 * emitter scored among the weakest. These tests add the missing coverage in the
 * finding's priority order: escaping/injection, the append-only property, NULL vs a
 * genuine zero, then the remaining structural literals.
 *
 * Records are built DIRECTLY (the SQL emitter is the unit under test) and expected
 * statements are frozen, hand-written oracles rather than strings re-derived by the
 * same logic the source uses, so every assertion can fail.
 *
 * Unlike the GDACS emitter, this one passes lon/lat/magnitude THROUGH `lit`, so the
 * numeric branch of `lit` is genuinely exercised here.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { buildEventInsert, buildFeedSeed, buildHeartbeatUpsert, buildLicenceSeed } from './sql.ts';
import type { EventRecord } from './usgs.ts';

/** A fully-populated USGS quake. occurred_at and retrieved_at differ so the two
 *  ::timestamptz casts can be told apart. */
function rec(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    feed_key: 'usgs_quakes',
    external_id: 'us6000tlbz',
    event_type: 'earthquake',
    occurred_at: '2026-08-17T00:00:00.000Z',
    lon: 151.3834,
    lat: 46.4341,
    depth_km: 90.992,
    magnitude: 5.1,
    magnitude_kind: 'richter',
    magnitude_scale: 'mb',
    place: 'Kuril Islands',
    source: 'USGS',
    release_version: '1787004086000',
    retrieved_at: '2026-08-17T12:00:00.000Z',
    licence_key: 'usgs_pd',
    ...overrides,
  };
}

// Frozen oracle for the canonical row: column order (including magnitude_scale, which
// this emitter carries and GDACS does not), the leading '(' and trailing ')', every
// ', ' separator, both ::timestamptz casts, the fully-qualified geom, and the clause.
const CANONICAL_INSERT =
  'insert into atlas.event (feed_key, external_id, event_type, occurred_at, geom, magnitude, magnitude_kind, magnitude_scale, source, release_version, retrieved_at, licence_key)\n' +
  "values\n  ('usgs_quakes', 'us6000tlbz', 'earthquake', '2026-08-17T00:00:00.000Z'::timestamptz, " +
  'public.ST_SetSRID(public.ST_MakePoint(151.3834, 46.4341), 4326), ' +
  "5.1, 'richter', 'mb', 'USGS', '1787004086000', '2026-08-17T12:00:00.000Z'::timestamptz, 'usgs_pd')\n" +
  'on conflict on constraint event_dedup do nothing;\n';

// ---------------------------------------------------------------------------
// 1. ESCAPING / INJECTION.
// ---------------------------------------------------------------------------

Deno.test('usgs sql — a single quote in the feature id is doubled; the id cannot end its literal', () => {
  const ordinary = buildEventInsert([rec({ external_id: 'us6000tlbz' })]); // negative control
  assertStringIncludes(ordinary, "'us6000tlbz'");

  const sql = buildEventInsert([rec({ external_id: "us'; DROP TABLE atlas.event; --" })]);
  assertStringIncludes(sql, "'us''; DROP TABLE atlas.event; --'");
  assert(!sql.includes("'us'; DROP"), 'the single unescaped quote form must never appear');
  assertStringIncludes(sql, "('usgs_quakes', 'us''; DROP TABLE atlas.event; --', 'earthquake', ");
});

Deno.test('usgs sql — a payload of every SQL metacharacter stays inside one quoted literal', () => {
  const payload = "x'); DROP TABLE atlas.event; --\\\n$$" + String.fromCharCode(0) + 'end';
  const sql = buildEventInsert([rec({ external_id: payload })]);
  const expectedLiteral = "'x''); DROP TABLE atlas.event; --\\\n$$" + String.fromCharCode(0) + "end'";
  assertStringIncludes(sql, expectedLiteral);
  assertStringIncludes(sql, 'on conflict on constraint event_dedup do nothing;\n');
});

Deno.test('usgs heartbeat — feedKey, releaseToken and now are all escaped, not just some', () => {
  const clean = buildHeartbeatUpsert({ feedKey: 'usgs_quakes', releaseToken: '1787004086000', rowCount: 24, now: '2026-08-17T12:00:00.000Z' });
  assertStringIncludes(clean, "values ('usgs_quakes', '2026-08-17T12:00:00.000Z'::timestamptz"); // negative control

  const sql = buildHeartbeatUpsert({ feedKey: "f'; DROP--", releaseToken: "t'; DELETE--", rowCount: 1, now: "2026'; --" });
  assertStringIncludes(sql, "'f''; DROP--'"); // feedKey escaped
  assertStringIncludes(sql, "'t''; DELETE--'"); // releaseToken escaped
  assertStringIncludes(sql, "'2026''; --'::timestamptz"); // now escaped, cast intact
  assert(!sql.includes("'f'; DROP--'"), 'no unescaped feedKey');
});

// ---------------------------------------------------------------------------
// 2. APPEND-ONLY.
// ---------------------------------------------------------------------------

Deno.test('usgs sql — the event insert is DO NOTHING; a re-poll can never rewrite a landed quake', () => {
  const sql = buildEventInsert([rec()]);
  assertStringIncludes(sql, 'on conflict on constraint event_dedup do nothing;\n');
  // DO NOTHING keeps the first landing authoritative. A mutation to DO UPDATE would
  // let a later poll overwrite recorded values, and would be visible right here.
  assert(!sql.includes('do update set'), 'an event insert must never become an upsert');
});

Deno.test('usgs sql — the id-suffix override applies to EVERY row, landing new quakes distinctly', () => {
  const original = buildEventInsert([rec()]);
  assertStringIncludes(original, "'us6000tlbz'");
  assert(!original.includes('-NEW'));

  const suffixed = buildEventInsert([rec({ external_id: 'a' }), rec({ external_id: 'b' })], { idSuffix: '-NEW' });
  assertStringIncludes(suffixed, "'a-NEW'");
  assertStringIncludes(suffixed, "'b-NEW'"); // the suffix reaches the second row too, not just the first
});

// ---------------------------------------------------------------------------
// 3. NULL vs a genuine value — an unknown magnitude is NULL, a measured 0 is 0.
// ---------------------------------------------------------------------------

Deno.test('usgs sql — an unknown magnitude is NULL, a measured magnitude is its number', () => {
  const known = buildEventInsert([rec({ magnitude: 5.1, magnitude_kind: 'richter' })]);
  assertStringIncludes(known, ', 5.1, ' + "'richter'"); // a real magnitude is an unquoted number

  const unknown = buildEventInsert([rec({ magnitude: null, magnitude_kind: null })]);
  // geom, then magnitude, magnitude_kind, magnitude_scale: an unknown magnitude is NULL,
  // never an empty cell and never a fabricated zero.
  assertStringIncludes(unknown, '4326), NULL, NULL, ');
  assert(!unknown.includes(', , '), 'a null must never render as an empty cell');
});

Deno.test('usgs sql — a genuine zero magnitude is stored as 0, distinct from an absent one', () => {
  // Absence (null) and a measured zero are different facts and must not collapse.
  const zero = buildEventInsert([rec({ magnitude: 0, magnitude_kind: 'richter' })]);
  assertStringIncludes(zero, '4326), 0, ' + "'richter'"); // 0 is data, not NULL
  const absent = buildEventInsert([rec({ magnitude: null, magnitude_kind: null })]);
  assertStringIncludes(absent, '4326), NULL, NULL, ');
});

Deno.test('usgs sql — a non-finite magnitude renders as NULL, never as an empty cell', () => {
  // lit's number branch returns 'NULL' for a non-finite value; a mutant emptying that
  // literal would drop the cell. A finite value proves the branch is really taken.
  const sql = buildEventInsert([rec({ magnitude: Infinity, magnitude_kind: null })]);
  assertStringIncludes(sql, '4326), NULL, NULL, ');
  assert(!sql.includes('Infinity'), 'a non-finite magnitude must not reach the statement');
});

// ---------------------------------------------------------------------------
// 4. STRUCTURE — parens, commas, casts, headers, empty-guard, seeds, heartbeat.
// ---------------------------------------------------------------------------

Deno.test('usgs sql — the canonical single-row insert matches its frozen statement exactly', () => {
  assertEquals(buildEventInsert([rec()]), CANONICAL_INSERT);
});

Deno.test('usgs sql — occurred_at and retrieved_at each keep a distinct ::timestamptz cast', () => {
  const sql = buildEventInsert([rec()]);
  assertStringIncludes(sql, "'2026-08-17T00:00:00.000Z'::timestamptz"); // occurred_at
  assertStringIncludes(sql, "'2026-08-17T12:00:00.000Z'::timestamptz"); // retrieved_at
  assertEquals(sql.split('::timestamptz').length - 1, 2, 'exactly two timestamptz casts');
});

Deno.test('usgs sql — an empty batch is a comment, never an INSERT with an empty VALUES list', () => {
  const sql = buildEventInsert([]);
  assertEquals(sql, '-- (no event records to insert)\n');
  assert(!sql.includes('insert into'), 'zero rows must not emit a headless insert');
});

Deno.test('usgs sql — multiple quakes become one insert with a row separator between tuples', () => {
  const sql = buildEventInsert([rec({ external_id: 'a' }), rec({ external_id: 'b' })]);
  assertStringIncludes(sql, '),\n  (');
  assertEquals(sql.split('insert into atlas.event').length - 1, 1, 'one header for the whole batch');
});

Deno.test('usgs licence seed — every clause is present and idempotent', () => {
  const lic = buildLicenceSeed();
  assertStringIncludes(
    lic,
    'insert into atlas.source_licence (licence_key, label, spdx, url, attribution_required, attribution_text, share_alike, non_commercial, verified, verified_at, notes)',
  );
  assertStringIncludes(lic, "values ('usgs_pd', 'U.S. Government Public Domain (USGS)', null, ");
  assertStringIncludes(lic, "'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits', ");
  assertStringIncludes(lic, "false, 'U.S. Geological Survey', false, false, true, '2026-08-17', ");
  assertStringIncludes(lic, 'U.S. Government works in the U.S. Public Domain');
  assertStringIncludes(lic, 'on conflict (licence_key) do nothing;\n');
});

Deno.test('usgs feed seed — every clause is present and idempotent', () => {
  const feed = buildFeedSeed();
  assertStringIncludes(
    feed,
    'insert into atlas.feed (feed_key, display_name, clock, source_url, licence_key, cadence_hours, max_staleness_hours, change_detection, requires_browser_ua, requires_token, active, notes)',
  );
  assertStringIncludes(feed, "values ('usgs_quakes', 'USGS Earthquakes (M4.5+, past day)', 'event', ");
  assertStringIncludes(feed, "'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson', ");
  assertStringIncludes(feed, "'usgs_pd', 1, 3, 'row_high_water', true, false, true, ");
  assertStringIncludes(feed, 'metadata.generated is the row_high_water change token');
  assertStringIncludes(feed, 'on conflict (feed_key) do nothing;\n');
});

Deno.test('usgs heartbeat — the two-clock upsert matches its frozen statement exactly', () => {
  const expected = 'insert into atlas.feed_heartbeat (feed_key, last_success_at, last_change_at, last_release_token, last_row_count, last_status, last_error, updated_at)\n' +
    "values ('usgs_quakes', '2026-08-17T12:00:00.000Z'::timestamptz, '2026-08-17T12:00:00.000Z'::timestamptz, '1787004086000', 24, 'ok', null, '2026-08-17T12:00:00.000Z'::timestamptz)\n" +
    'on conflict (feed_key) do update set\n' +
    '  last_success_at = excluded.last_success_at,\n' +
    '  last_change_at = excluded.last_change_at,\n' +
    '  last_release_token = excluded.last_release_token,\n' +
    '  last_row_count = excluded.last_row_count,\n' +
    '  last_status = excluded.last_status,\n' +
    '  last_error = null,\n' +
    '  updated_at = excluded.updated_at;\n';
  assertEquals(buildHeartbeatUpsert({ feedKey: 'usgs_quakes', releaseToken: '1787004086000', rowCount: 24, now: '2026-08-17T12:00:00.000Z' }), expected);
});
