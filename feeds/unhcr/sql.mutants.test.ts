/**
 * sql.mutants.test.ts — closing the mutation gaps on feeds/unhcr/sql.ts.
 *
 * SECURITY.md names "Injection into generated SQL" the most serious class, and this
 * emitter scored among the weakest. Coverage is added in the finding's priority
 * order: escaping/injection, the append-only property, NULL vs a genuine zero vs an
 * absent value (the nullable source_published_at cast), then structural literals.
 *
 * The UNHCR observation carries one column the World Bank one does not (feed_key),
 * so the column order and the golden statement are its own.
 *
 * Records are built directly and expected statements are frozen, hand-written oracles.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { buildObservationInsert } from './sql.ts';
import type { ObservationRecord } from './unhcr.ts';

function obs(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    indicator: 'refugees_origin',
    area_type: 'country',
    area_code: 'AFG',
    ref_period: '2024',
    value: 6403144,
    unit: 'people',
    agg_method: 'sum',
    denominator_indicator: null,
    denominator_value: null,
    source: 'UNHCR',
    source_dataset: 'population',
    release_version: 'sha256:testvintage',
    reference_year: 2024,
    source_published_at: null,
    retrieved_at: '2026-08-17T12:00:00.000Z',
    licence_key: 'unhcr_cc_by_igo',
    feed_key: 'unhcr_population',
    ...overrides,
  };
}

const HEADER =
  'insert into atlas.observation (indicator, area_type, area_code, ref_period, value, unit, agg_method, denominator_indicator, denominator_value, source, source_dataset, release_version, reference_year, source_published_at, retrieved_at, licence_key, feed_key)\n';

const CANONICAL_INSERT = HEADER +
  "values\n  ('refugees_origin', 'country', 'AFG', '2024', 6403144, 'people', 'sum', NULL, NULL, 'UNHCR', 'population', 'sha256:testvintage', 2024, " +
  "NULL, '2026-08-17T12:00:00.000Z'::timestamptz, 'unhcr_cc_by_igo', 'unhcr_population')\n" +
  'on conflict on constraint observation_vintage_natural_key do nothing;\n';

// ---------------------------------------------------------------------------
// 1. ESCAPING / INJECTION.
// ---------------------------------------------------------------------------

Deno.test('unhcr sql — a single quote in a feed value is doubled; the value cannot end its literal', () => {
  const ordinary = buildObservationInsert([obs({ area_code: 'AFG' })]); // negative control
  assertStringIncludes(ordinary, "'AFG'");

  const sql = buildObservationInsert([obs({ indicator: "a'; DELETE FROM atlas.observation; --" })]);
  assertStringIncludes(sql, "('a''; DELETE FROM atlas.observation; --', 'country', ");
  assert(!sql.includes("('a'; DELETE"), 'the single unescaped quote form must never appear');
});

Deno.test('unhcr sql — a payload of every SQL metacharacter stays inside one quoted literal', () => {
  const payload = "x'); DROP TABLE atlas.observation; --\\\n$$" + String.fromCharCode(0) + 'end';
  const sql = buildObservationInsert([obs({ area_code: payload })]);
  const expectedLiteral = "'x''); DROP TABLE atlas.observation; --\\\n$$" + String.fromCharCode(0) + "end'";
  assertStringIncludes(sql, expectedLiteral);
  assertStringIncludes(sql, 'on conflict on constraint observation_vintage_natural_key do nothing;\n');
});

Deno.test('unhcr sql — the feed_key column is emitted and escaped like any other value', () => {
  const ordinary = buildObservationInsert([obs()]); // negative control
  assertStringIncludes(ordinary, "'unhcr_cc_by_igo', 'unhcr_population')"); // licence_key then feed_key, last two cells
  const sql = buildObservationInsert([obs({ feed_key: "f'; DROP--" })]);
  assertStringIncludes(sql, "'unhcr_cc_by_igo', 'f''; DROP--')");
});

// ---------------------------------------------------------------------------
// 2. APPEND-ONLY.
// ---------------------------------------------------------------------------

Deno.test('unhcr sql — the insert is DO NOTHING; a re-fetch of identical data is a no-op', () => {
  const sql = buildObservationInsert([obs()]);
  assertStringIncludes(sql, 'on conflict on constraint observation_vintage_natural_key do nothing;\n');
  assert(!sql.includes('do update set'), 'an observation insert must never become an upsert');
});

Deno.test('unhcr sql — a source_published_at override reaches the row, distinct from the original', () => {
  // A restatement carries a new published date. The override must reach SQL; a mutant
  // collapsing the override ternary would keep the record's own value instead.
  const later = buildObservationInsert([obs({ source_published_at: 'PUB-A' })], { sourcePublishedAt: 'PUB-B' });
  assertStringIncludes(later, "'PUB-B'::timestamptz");
  assert(!later.includes("'PUB-A'"), 'the override must replace the original published date');
});

Deno.test('unhcr sql — an explicit null source_published_at override renders NULL, not the original', () => {
  const sql = buildObservationInsert([obs({ source_published_at: 'PUB-A' })], { sourcePublishedAt: null });
  assert(!sql.includes("'PUB-A'"), 'an explicit null override must replace the original value');
  assertStringIncludes(sql, ', 2024, NULL, '); // reference_year, then a bare NULL (no cast)
});

// ---------------------------------------------------------------------------
// 3. NULL vs a genuine value.
// ---------------------------------------------------------------------------

Deno.test('unhcr sql — a present source_published_at is cast; a null one is a bare NULL', () => {
  const present = buildObservationInsert([obs({ source_published_at: '2026-09-01' })]);
  assertStringIncludes(present, "'2026-09-01'::timestamptz");

  const missing = buildObservationInsert([obs({ source_published_at: null })]);
  assertStringIncludes(missing, ', 2024, NULL, ');
  assert(!missing.includes('NULL::timestamptz'), 'a null timestamp must never carry a cast');
});

Deno.test('unhcr sql — a genuine zero is stored as 0, distinct from an absent measure', () => {
  // Iceland with 0 refugees is a measured fact; it must not collapse into NULL.
  const zero = buildObservationInsert([obs({ value: 0 })]);
  assertStringIncludes(zero, "'2024', 0, 'people'");
  const nonzero = buildObservationInsert([obs({ value: 6403144 })]);
  assertStringIncludes(nonzero, "'2024', 6403144, 'people'");
});

Deno.test('unhcr sql — a non-finite value renders as NULL, never as an empty cell', () => {
  const sql = buildObservationInsert([obs({ value: Infinity })]);
  assertStringIncludes(sql, "'2024', NULL, 'people'");
  assert(!sql.includes('Infinity'));
});

// ---------------------------------------------------------------------------
// 4. STRUCTURE.
// ---------------------------------------------------------------------------

Deno.test('unhcr sql — the canonical single-row insert matches its frozen statement exactly', () => {
  assertEquals(buildObservationInsert([obs()]), CANONICAL_INSERT);
});

Deno.test('unhcr sql — an empty batch is a comment, never an INSERT with an empty VALUES list', () => {
  const sql = buildObservationInsert([]);
  assertEquals(sql, '-- (no observation records to insert)\n');
  assert(!sql.includes('insert into'), 'zero rows must not emit a headless insert');
});

Deno.test('unhcr sql — multiple observations become one insert with a row separator between tuples', () => {
  const sql = buildObservationInsert([obs({ area_code: 'AFG' }), obs({ area_code: 'SYR' })]);
  assertStringIncludes(sql, '),\n  (');
  assertEquals(sql.split('insert into atlas.observation').length - 1, 1, 'one header for the whole batch');
  assertStringIncludes(sql, "'AFG'");
  assertStringIncludes(sql, "'SYR'");
});

Deno.test('unhcr sql — retrieved_at keeps its ::timestamptz cast when source_published_at is null', () => {
  const sql = buildObservationInsert([obs({ source_published_at: null })]);
  assertStringIncludes(sql, "'2026-08-17T12:00:00.000Z'::timestamptz");
  assertEquals(sql.split('::timestamptz').length - 1, 1, 'exactly one cast when source_published_at is null');
});
