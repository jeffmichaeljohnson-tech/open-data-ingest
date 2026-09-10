/**
 * worldbank.mutants.test.ts — mutation-hardening tests for the pure World Bank layer.
 *
 * Companion to worldbank.test.ts; no overlap. Each test names the DEFECT it prevents
 * in SECURITY.md terms: an HTML/WAF/error payload read as zero rows, a null cell stored
 * as a fake zero, an intensive percentage that loses its denominator (and so gets summed
 * into a nonsense continent total), a bare observation with no vintage, and a content
 * hash that stops tracking the data or its provenance.
 *
 * --allow-read only. No tautologies; throw/skip tests carry a positive control.
 */
import { assert, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import {
  buildCrosswalkIndex,
  buildSnapshot,
  ELECTRICITY_ACCESS_PCT,
  type ObservationRecord,
  parseWorldBankResponse,
  POPULATION_TOTAL,
  transformWorldBankRows,
  type WorldBankRow,
} from './worldbank.ts';

const CROSSWALK_ROWS = [
  { iso_a3: 'NGA', wb_code: 'NGA', m49_macro_region_code: 2 },
  { iso_a3: 'GHA', wb_code: 'GHA', m49_macro_region_code: 2 },
];
const IDX = buildCrosswalkIndex(CROSSWALK_ROWS);

const BASE_OPTS = {
  crosswalk: IDX,
  releaseVersion: '2026-07-13',
  sourcePublishedAt: '2026-07-13',
  retrievedAt: '2026-08-17T12:00:00.000Z',
  licenceKey: 'cc_by_4',
};

function wbRow(iso: string, name: string, date: string, value: number | null): WorldBankRow {
  return { indicator: { id: 'X', value: 'X' }, country: { id: iso.slice(0, 2), value: name }, countryiso3code: iso, date, value, unit: '', obs_status: '', decimal: 0 };
}

/** A ready-made observation record for snapshot-ordering tests. */
function obs(over: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    indicator: 'population_total',
    area_type: 'country',
    area_code: 'NGA',
    ref_period: '2024',
    value: 1,
    unit: 'people',
    agg_method: 'sum',
    denominator_indicator: null,
    denominator_value: null,
    source: 'World Bank',
    source_dataset: 'SP.POP.TOTL',
    release_version: 'v1',
    reference_year: 2024,
    source_published_at: null,
    retrieved_at: '2026-08-17T12:00:00.000Z',
    licence_key: 'cc_by_4',
    ...over,
  };
}

// ===========================================================================
// INDICATOR CONFIG — L109/L110. These codes are the join/provenance keys.
// ===========================================================================

Deno.test('ELECTRICITY_ACCESS_PCT carries its exact WB code and observation name — L109/L110', () => {
  // Mutants blank these string literals. The wbIndicator is the API code the fetch uses
  // and the source_dataset provenance; the observationIndicator is the stored key.
  assertEquals(ELECTRICITY_ACCESS_PCT.wbIndicator, 'EG.ELC.ACCS.ZS');
  assertEquals(ELECTRICITY_ACCESS_PCT.observationIndicator, 'electricity_access_pct');
  assertEquals(ELECTRICITY_ACCESS_PCT.unit, 'percent');
  assertEquals(ELECTRICITY_ACCESS_PCT.aggMethod, 'weighted_mean');
});

// ===========================================================================
// PARSE — a non-array/short/wrong-shape payload THROWS, never reads as zero rows.
// ===========================================================================

Deno.test('parse: a non-array body names the shape — L184 ternary', () => {
  // Mutant L184 `body === null ? 'null' : typeof body` collapse would misreport the shape.
  assertThrows(() => parseWorldBankResponse(null), Error, 'got null');
  assertThrows(() => parseWorldBankResponse(42), Error, 'got number');
  assertThrows(() => parseWorldBankResponse({ foo: 1 }), Error, 'got object');
});

Deno.test('parse: an API error joins its messages with "; " and never leaks a Stryker sentinel — L191/L192', () => {
  // Mutant L192 `join('; ')` → `join('')` would run the messages together; L191 `m.value ?? ''`
  // → a sentinel would surface fake text when a message element has no value.
  assertThrows(
    () => parseWorldBankResponse([{ message: [{ value: 'first problem' }, { value: 'second problem' }] }]),
    Error,
    'first problem; second problem',
  );
  const noValue = () => parseWorldBankResponse([{ message: [{}] }]);
  assertThrows(noValue, Error, 'API error');
  try {
    noValue();
  } catch (e) {
    assert(!(e as Error).message.includes('Stryker'), 'a value-less message element must not leak a sentinel');
  }
});

Deno.test('parse: a one-element array (not the error shape) throws "expected 2" — L195/L196', () => {
  // Mutant L195 `if (body.length < 2)` → false would treat a truncated response as a page
  // with undefined rows and mislabel the failure. A short array must be named as such.
  assertThrows(() => parseWorldBankResponse([{ page: 1, pages: 1, per_page: 1, total: 0 }]), Error, 'expected 2');
});

Deno.test('parse: a second element that is neither array nor null throws — L200/L201; null is data', () => {
  // Mutant L200 `if (rows !== null && !Array.isArray(rows))` → false would let a string
  // `rows` through to the transform. A genuine null (no data) must still parse cleanly.
  assertThrows(() => parseWorldBankResponse([{ page: 1, pages: 1, per_page: 1, total: 0 }, 'nope']), Error, 'neither an array nor null');
  assertEquals(parseWorldBankResponse([{ page: 1, pages: 0, per_page: 1, total: 0 }, null]).rows, null);
});

// ===========================================================================
// CROSSWALK — L215/L216. The wb_code join key is trimmed; blank never indexes.
// ===========================================================================

Deno.test('buildCrosswalkIndex: wb_code is trimmed; blank wb_code never indexes — L215/L216', () => {
  const idx = buildCrosswalkIndex([
    { iso_a3: 'NGA', wb_code: '  NGA  ', m49_macro_region_code: 2 },
    { iso_a3: 'ESH', wb_code: '', m49_macro_region_code: 2 },
    { iso_a3: 'XXX', wb_code: '   ', m49_macro_region_code: 2 },
  ]);
  assertEquals(idx.size, 1);
  assert(idx.has('NGA')); // trimmed key
  assert(!idx.has('  NGA  '));
  assert(!idx.has(''));
});

// ===========================================================================
// TRANSFORM — null cell skipped (absence != zero), intensive keeps its denominator.
// ===========================================================================

Deno.test('transform: a null OR undefined value is skipped, never stored as a fake zero — L276', () => {
  // Mutant L276 `if (row.value === null || row.value === undefined)` → false would push a
  // row with a null value. Both null and undefined must be recorded null_value skips.
  const nullRow = transformWorldBankRows(POPULATION_TOTAL, [wbRow('NGA', 'Nigeria', '2024', null)], BASE_OPTS);
  assertEquals(nullRow.records.length, 0);
  assertEquals(nullRow.skipped[0].reason, 'null_value');
  const undefRow = transformWorldBankRows(POPULATION_TOTAL, [wbRow('GHA', 'Ghana', '2024', undefined as unknown as number)], BASE_OPTS);
  assertEquals(undefRow.records.length, 0);
  assertEquals(undefRow.skipped[0].reason, 'null_value');
  // positive control: a genuine 0 IS stored (a real measured value, not an absence).
  assertEquals(transformWorldBankRows(POPULATION_TOTAL, [wbRow('NGA', 'Nigeria', '2024', 0)], BASE_OPTS).records[0].value, 0);
});

Deno.test('transform: a weighted_mean with NO denominator map at all is skipped, not crashed — L288 optional chain', () => {
  // Mutant L288 `opts.denominatorByIso?.get(...)` → `opts.denominatorByIso.get(...)` throws
  // when no denominator map is supplied. An intensive percentage with no weight cannot be
  // recomputed at the continent, so it must be a recorded missing_denominator skip.
  const { records, skipped } = transformWorldBankRows(ELECTRICITY_ACCESS_PCT, [wbRow('NGA', 'Nigeria', '2023', 60.5)], BASE_OPTS);
  assertEquals(records.length, 0);
  assertEquals(skipped[0].reason, 'missing_denominator');
});

Deno.test('transform: area_type is the literal "country", never blank — L306', () => {
  const { records } = transformWorldBankRows(POPULATION_TOTAL, [wbRow('NGA', 'Nigeria', '2024', 227882945)], BASE_OPTS);
  assertEquals(records[0].area_type, 'country');
});

// ===========================================================================
// SNAPSHOT — sort keys, release-version set, identity strings, canonicalJson golden.
// ===========================================================================

Deno.test('snapshot: observations sort by (indicator, area, year, release) with a year tie-break — L434/L435/L437', async () => {
  // Mutant L437 `a.reference_year - b.reference_year` → `+` and L435 `||` → `&&` break
  // the ordering. Fed out of order (including two years for one indicator+area), the
  // output must be fully sorted.
  const snap = await buildSnapshot(
    [
      obs({ indicator: 'population_total', area_code: 'NGA', reference_year: 2024 }),
      obs({ indicator: 'electricity_access_pct', area_code: 'NGA', reference_year: 2024 }),
      obs({ indicator: 'electricity_access_pct', area_code: 'NGA', reference_year: 2020 }),
      obs({ indicator: 'electricity_access_pct', area_code: 'GHA', reference_year: 2024 }),
    ],
    { feedKey: 'worldbank_wdi', licenceKey: 'cc_by_4', generatedAt: 'now' },
  );
  assertEquals(
    snap.observations.map((o) => `${o.indicator}/${o.area_code}/${o.reference_year}`),
    ['electricity_access_pct/GHA/2024', 'electricity_access_pct/NGA/2020', 'electricity_access_pct/NGA/2024', 'population_total/NGA/2024'],
  );
});

Deno.test('snapshot: release_versions is the deduped, sorted vintage set — L441', async () => {
  const snap = await buildSnapshot(
    [obs({ area_code: 'NGA', release_version: '2026-08-01' }), obs({ area_code: 'GHA', release_version: '2026-07-13' }), obs({ area_code: 'NGA', release_version: '2026-08-01' })],
    { feedKey: 'worldbank_wdi', licenceKey: 'cc_by_4', generatedAt: 'now' },
  );
  assertEquals(snap.release_versions, ['2026-07-13', '2026-08-01']);
});

Deno.test('snapshot: identity strings are exact — L458/L460', async () => {
  const snap = await buildSnapshot([obs()], { feedKey: 'worldbank_wdi', licenceKey: 'cc_by_4', generatedAt: 'now' });
  assertEquals(snap.schema_version, 'atlas.snapshot.v1');
  assertEquals(snap.source, 'World Bank');
});

Deno.test('snapshot: content hash is a stable golden — pins canonicalJson (L372-L376) + hash core (L447/L449)', async () => {
  // Golden from the unmutated builder over one NGA/2024 population row. It moves if the
  // canonical serialisation changes or a hash-core identity string is blanked.
  const { records } = transformWorldBankRows(POPULATION_TOTAL, [wbRow('NGA', 'Nigeria', '2024', 227882945)], BASE_OPTS);
  const snap = await buildSnapshot(records, { feedKey: 'worldbank_wdi', licenceKey: 'cc_by_4', generatedAt: '2026-08-17T12:00:00.000Z' });
  assertEquals(snap.content_hash, '68dfc46c4e5175ad920dffe9c06564fed1a3edb312fa3f7fcd8470742347571b');
  assertEquals(snap.content_hash.length, 64);
  const moved = await buildSnapshot(records.map((r) => ({ ...r, value: r.value + 1 })), {
    feedKey: 'worldbank_wdi',
    licenceKey: 'cc_by_4',
    generatedAt: '2026-08-17T12:00:00.000Z',
  });
  assertNotEquals(moved.content_hash, snap.content_hash);
});

Deno.test('snapshot: a record carrying null provenance fields hashes without throwing — canonicalJson null branch (L372)', async () => {
  // Mutant L372 `value === null` → `value !== null` sends null into Object.keys(null),
  // which THROWS. source_published_at is legitimately null, so the snapshot must still hash.
  const snap = await buildSnapshot([obs({ source_published_at: null, denominator_indicator: null, denominator_value: null })], {
    feedKey: 'worldbank_wdi',
    licenceKey: 'cc_by_4',
    generatedAt: 'now',
  });
  assertEquals(snap.content_hash.length, 64);
});
