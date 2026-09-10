/**
 * sql.mutants.test.ts — closing the mutation gaps on feeds/worldbank/sql.ts.
 *
 * SECURITY.md names "Injection into generated SQL" the most serious class, and this
 * emitter scored among the weakest. Coverage is added in the finding's priority
 * order: escaping/injection, the append-only property, NULL vs a genuine zero vs an
 * absent value (the nullable source_published_at cast is the sharp case here), then
 * the remaining structural literals.
 *
 * The override tests deliberately use release_version and source_published_at values
 * that DIFFER from each other and from the record's own — the existing suite reused
 * one date for both, so a value dropped from the release_version slot was silently
 * covered by its twin in the source_published_at slot.
 *
 * Records are built directly and expected statements are frozen, hand-written oracles.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { buildObservationInsert } from './sql.ts';
import type { ObservationRecord } from './worldbank.ts';

function obs(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    indicator: 'population_total',
    area_type: 'country',
    area_code: 'NGA',
    ref_period: '2024',
    value: 227882945,
    unit: 'people',
    agg_method: 'sum',
    denominator_indicator: null,
    denominator_value: null,
    source: 'World Bank',
    source_dataset: 'SP.POP.TOTL',
    release_version: '2026-07-13',
    reference_year: 2024,
    source_published_at: '2026-07-13',
    retrieved_at: '2026-08-17T12:00:00.000Z',
    licence_key: 'cc_by_4',
    ...overrides,
  };
}

const HEADER =
  'insert into atlas.observation (indicator, area_type, area_code, ref_period, value, unit, agg_method, denominator_indicator, denominator_value, source, source_dataset, release_version, reference_year, source_published_at, retrieved_at, licence_key)\n';

const CANONICAL_INSERT = HEADER +
  "values\n  ('population_total', 'country', 'NGA', '2024', 227882945, 'people', 'sum', NULL, NULL, 'World Bank', 'SP.POP.TOTL', '2026-07-13', 2024, " +
  "'2026-07-13'::timestamptz, '2026-08-17T12:00:00.000Z'::timestamptz, 'cc_by_4')\n" +
  'on conflict on constraint observation_vintage_natural_key do nothing;\n';

// ---------------------------------------------------------------------------
// 1. ESCAPING / INJECTION.
// ---------------------------------------------------------------------------

Deno.test('worldbank sql — a single quote in a feed value is doubled; the value cannot end its literal', () => {
  const ordinary = buildObservationInsert([obs({ source_dataset: 'SP.POP.TOTL' })]); // negative control
  assertStringIncludes(ordinary, "'SP.POP.TOTL'");

  // source_dataset is the feed-supplied indicator code — a natural untrusted string.
  const sql = buildObservationInsert([obs({ source_dataset: "SP'; DROP TABLE atlas.observation; --" })]);
  assertStringIncludes(sql, "'SP''; DROP TABLE atlas.observation; --'");
  assert(!sql.includes("'SP'; DROP"), 'the single unescaped quote form must never appear');
  assertStringIncludes(sql, "'World Bank', 'SP''; DROP TABLE atlas.observation; --', ");
});

Deno.test('worldbank sql — a payload of every SQL metacharacter stays inside one quoted literal', () => {
  const payload = "x'); DROP TABLE atlas.observation; --\\\n$$" + String.fromCharCode(0) + 'end';
  const sql = buildObservationInsert([obs({ area_code: payload })]);
  const expectedLiteral = "'x''); DROP TABLE atlas.observation; --\\\n$$" + String.fromCharCode(0) + "end'";
  assertStringIncludes(sql, expectedLiteral);
  assertStringIncludes(sql, 'on conflict on constraint observation_vintage_natural_key do nothing;\n');
});

// ---------------------------------------------------------------------------
// 2. APPEND-ONLY.
// ---------------------------------------------------------------------------

Deno.test('worldbank sql — the insert is DO NOTHING; a re-ingest of the same release is a no-op', () => {
  const sql = buildObservationInsert([obs()]);
  assertStringIncludes(sql, 'on conflict on constraint observation_vintage_natural_key do nothing;\n');
  assert(!sql.includes('do update set'), 'an observation insert must never become an upsert');
});

Deno.test('worldbank sql — a later release override lands a NEW row; release_version is not confused with source_published_at', () => {
  // Distinct values everywhere so a dropped or swapped slot is visible.
  const record = obs({ release_version: 'REL-A', source_published_at: 'PUB-A' });

  // NO override: the row must carry its OWN release_version, not a NULL. Catches a
  // `??`-to-`&&` mutation that nulls the value when no override is passed.
  const original = buildObservationInsert([record]);
  assertStringIncludes(original, "'REL-A'");
  assertStringIncludes(original, "'PUB-A'::timestamptz");

  // WITH override: both slots take their OVERRIDE value, and neither keeps the original.
  const later = buildObservationInsert([record], { releaseVersion: 'REL-B', sourcePublishedAt: 'PUB-B' });
  assertStringIncludes(later, "'REL-B'");
  assertStringIncludes(later, "'PUB-B'::timestamptz");
  assert(!later.includes("'REL-A'"), 'the release_version override must replace the original');
  assert(!later.includes("'PUB-A'"), 'the source_published_at override must replace the original');
});

Deno.test('worldbank sql — an explicit null source_published_at override renders NULL, not the original', () => {
  // The `!== undefined` test must let an explicit null through as a real override,
  // distinct from an absent override. A mutant collapsing that test would keep 'PUB-A'.
  const sql = buildObservationInsert([obs({ source_published_at: 'PUB-A' })], { sourcePublishedAt: null });
  assert(!sql.includes("'PUB-A'"), 'an explicit null override must replace the original value');
  assertStringIncludes(sql, ', 2024, NULL, '); // reference_year, then a bare NULL (no cast)
});

// ---------------------------------------------------------------------------
// 3. NULL vs a genuine value — the nullable timestamp cast, and zero vs absent.
// ---------------------------------------------------------------------------

Deno.test('worldbank sql — a present source_published_at is cast; a null one is a bare NULL', () => {
  const present = buildObservationInsert([obs({ source_published_at: '2026-07-13' })]);
  assertStringIncludes(present, "'2026-07-13'::timestamptz"); // a real date carries the cast

  const missing = buildObservationInsert([obs({ source_published_at: null })]);
  assertStringIncludes(missing, ', 2024, NULL, ');
  // A null must NOT be cast — 'NULL::timestamptz' would mean the branch collapsed the
  // absent case into the present one (or emptied/inverted the ternary).
  assert(!missing.includes('NULL::timestamptz'), 'a null timestamp must never carry a cast');
});

Deno.test('worldbank sql — a genuine zero is stored as 0; an absent denominator is NULL', () => {
  const zeroValue = buildObservationInsert([obs({ value: 0 })]);
  assertStringIncludes(zeroValue, "'2024', 0, 'people'"); // a measured 0 is data, unquoted

  const zeroDenom = buildObservationInsert([obs({ denominator_value: 0 })]);
  assertStringIncludes(zeroDenom, ", 0, 'World Bank'"); // denominator 0 is data
  const absentDenom = buildObservationInsert([obs({ denominator_value: null })]);
  assertStringIncludes(absentDenom, ", NULL, 'World Bank'"); // an absent denominator is NULL, not 0
});

Deno.test('worldbank sql — a non-finite value renders as NULL, never as an empty cell', () => {
  const sql = buildObservationInsert([obs({ value: Infinity })]);
  assertStringIncludes(sql, "'2024', NULL, 'people'");
  assert(!sql.includes('Infinity'));
});

// ---------------------------------------------------------------------------
// 4. STRUCTURE — parens, commas, casts, header, empty-guard, multi-row.
// ---------------------------------------------------------------------------

Deno.test('worldbank sql — the canonical single-row insert matches its frozen statement exactly', () => {
  assertEquals(buildObservationInsert([obs()]), CANONICAL_INSERT);
});

Deno.test('worldbank sql — the null-source_published_at row matches its frozen statement exactly', () => {
  const expected = HEADER +
    "values\n  ('population_total', 'country', 'NGA', '2024', 227882945, 'people', 'sum', NULL, NULL, 'World Bank', 'SP.POP.TOTL', '2026-07-13', 2024, " +
    "NULL, '2026-08-17T12:00:00.000Z'::timestamptz, 'cc_by_4')\n" +
    'on conflict on constraint observation_vintage_natural_key do nothing;\n';
  assertEquals(buildObservationInsert([obs({ source_published_at: null })]), expected);
});

Deno.test('worldbank sql — an empty batch is a comment, never an INSERT with an empty VALUES list', () => {
  const sql = buildObservationInsert([]);
  assertEquals(sql, '-- (no observation records to insert)\n');
  assert(!sql.includes('insert into'), 'zero rows must not emit a headless insert');
});

Deno.test('worldbank sql — multiple observations become one insert with a row separator between tuples', () => {
  const sql = buildObservationInsert([obs({ area_code: 'NGA' }), obs({ area_code: 'GHA' })]);
  assertStringIncludes(sql, '),\n  (');
  assertEquals(sql.split('insert into atlas.observation').length - 1, 1, 'one header for the whole batch');
  assertStringIncludes(sql, "'NGA'");
  assertStringIncludes(sql, "'GHA'");
});

Deno.test('worldbank sql — retrieved_at keeps its ::timestamptz cast', () => {
  const sql = buildObservationInsert([obs({ source_published_at: null })]); // only retrieved_at is a cast now
  assertStringIncludes(sql, "'2026-08-17T12:00:00.000Z'::timestamptz");
  assertEquals(sql.split('::timestamptz').length - 1, 1, 'exactly one cast when source_published_at is null');
});
