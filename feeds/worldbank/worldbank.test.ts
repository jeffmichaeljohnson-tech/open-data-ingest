/**
 * worldbank.test.ts — offline tests for the pure World Bank layer.
 *
 * Run with `deno test` from this directory. Deno is chosen deliberately: this is a
 * Supabase Edge Function, Deno IS its runtime, and `deno test` runs the TypeScript
 * with no build step and no dependency on apps/web's vitest (which this lane must
 * not touch). Every test is fixture-driven — no network, no database — because the
 * whole reason worldbank.ts is split from index.ts is that its logic is provable
 * offline. The one live-data dependency (do the indicator codes and `lastupdated`
 * token exist?) is verified by the proof harness against the real API, not mocked
 * here.
 */
import {
  assert,
  assertEquals,
  assertThrows,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  parseWorldBankResponse,
  buildCrosswalkIndex,
  transformWorldBankRows,
  denominatorMapFromRecords,
  buildSnapshot,
  POPULATION_TOTAL,
  ELECTRICITY_ACCESS_PCT,
  type WorldBankRow,
  type CrosswalkEntry,
} from './worldbank.ts';
import { buildObservationInsert } from './sql.ts';

// A tiny crosswalk: two real countries with wb_code, and one row WITHOUT a wb_code
// (a territory World Bank does not report) that must never be a join target.
const CROSSWALK_ROWS = [
  { iso_a3: 'NGA', wb_code: 'NGA', m49_macro_region_code: 2 }, // Africa
  { iso_a3: 'GHA', wb_code: 'GHA', m49_macro_region_code: 2 }, // Africa
  { iso_a3: 'XKX', wb_code: 'XKX', m49_macro_region_code: 150 }, // Kosovo: iso_a3 != real ISO, wb_code present
  { iso_a3: 'ESH', wb_code: '', m49_macro_region_code: 2 }, // Western Sahara: NO wb_code
];

function wbRow(iso: string, name: string, date: string, value: number | null): WorldBankRow {
  return {
    indicator: { id: 'X', value: 'X' },
    country: { id: iso.slice(0, 2), value: name },
    countryiso3code: iso,
    date,
    value,
    unit: '',
    obs_status: '',
    decimal: 0,
  };
}

Deno.test('parseWorldBankResponse — valid 2-element page', () => {
  const body = [
    { page: 1, pages: 1, per_page: 2, total: 2, lastupdated: '2026-07-13' },
    [wbRow('USA', 'United States', '2024', 340003797)],
  ];
  const parsed = parseWorldBankResponse(body);
  assertEquals(parsed.meta.lastupdated, '2026-07-13');
  assertEquals(parsed.rows?.length, 1);
});

Deno.test('parseWorldBankResponse — null second element means no data, not a throw', () => {
  const parsed = parseWorldBankResponse([{ page: 1, pages: 0, per_page: 2, total: 0 }, null]);
  assertEquals(parsed.rows, null);
});

Deno.test('parseWorldBankResponse — API error shape is surfaced with its message', () => {
  const err = [{ message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] }];
  // The parser surfaces the human-readable `value`, which is what an operator needs to read.
  assertThrows(() => parseWorldBankResponse(err), Error, 'The provided parameter value is not valid');
});

Deno.test('parseWorldBankResponse — a non-array (HTML/WAF page) throws clearly', () => {
  assertThrows(() => parseWorldBankResponse('<!doctype html>' as unknown), Error, 'not an array');
});

Deno.test('buildCrosswalkIndex — a row with an empty wb_code is NOT indexed', () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  assert(idx.has('NGA'));
  assert(idx.has('XKX'));
  assertEquals(idx.has(''), false); // Western Sahara's empty wb_code never becomes a key
  assertEquals(idx.size, 3);
});

Deno.test('transform — population maps via wb_code, drops aggregates, sets sum/extensive', () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  const rows = [
    wbRow('NGA', 'Nigeria', '2024', 227882945),
    wbRow('GHA', 'Ghana', '2024', 33787914),
    wbRow('ARB', 'Arab World', '2024', 464000000), // AGGREGATE — no wb_code match, must drop
    wbRow('WLD', 'World', '2024', 8000000000), // AGGREGATE
  ];
  const { records, skipped } = transformWorldBankRows(POPULATION_TOTAL, rows, {
    crosswalk: idx,
    releaseVersion: '2026-07-13',
    sourcePublishedAt: '2026-07-13',
    retrievedAt: '2026-08-17T12:00:00.000Z',
    licenceKey: 'cc_by_4',
  });
  assertEquals(records.length, 2); // only NGA + GHA
  assertEquals(skipped.filter((s) => s.reason === 'aggregate_or_unmapped').length, 2);
  const nga = records.find((r) => r.area_code === 'NGA')!;
  assertEquals(nga.indicator, 'population_total');
  assertEquals(nga.unit, 'people');
  assertEquals(nga.agg_method, 'sum'); // EXTENSIVE — summable
  assertEquals(nga.denominator_value, null);
  assertEquals(nga.reference_year, 2024);
  assertEquals(nga.release_version, '2026-07-13'); // vintage carried
});

Deno.test('transform — a null value is skipped, never stored as a fake zero', () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  const { records, skipped } = transformWorldBankRows(POPULATION_TOTAL, [wbRow('NGA', 'Nigeria', '2024', null)], {
    crosswalk: idx,
    releaseVersion: '2026-07-13',
    sourcePublishedAt: '2026-07-13',
    retrievedAt: '2026-08-17T12:00:00.000Z',
    licenceKey: 'cc_by_4',
  });
  assertEquals(records.length, 0);
  assertEquals(skipped[0].reason, 'null_value');
});

Deno.test('transform — electricity is weighted_mean/intensive and CARRIES its denominator', () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  const denom = new Map<string, number>([['NGA', 227882945], ['GHA', 33787914]]);
  const { records } = transformWorldBankRows(ELECTRICITY_ACCESS_PCT, [wbRow('NGA', 'Nigeria', '2023', 60.5)], {
    crosswalk: idx,
    releaseVersion: '2026-07-13',
    sourcePublishedAt: '2026-07-13',
    retrievedAt: '2026-08-17T12:00:00.000Z',
    licenceKey: 'cc_by_4',
    denominatorByIso: denom,
  });
  const r = records[0];
  assertEquals(r.unit, 'percent');
  assertEquals(r.agg_method, 'weighted_mean'); // INTENSIVE — never summed
  assertEquals(r.denominator_indicator, 'population_total');
  assertEquals(r.denominator_value, 227882945); // the weight the rollup recomputes with
});

Deno.test('transform — electricity with NO denominator is skipped, not stored null', () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  const { records, skipped } = transformWorldBankRows(ELECTRICITY_ACCESS_PCT, [wbRow('NGA', 'Nigeria', '2023', 60.5)], {
    crosswalk: idx,
    releaseVersion: '2026-07-13',
    sourcePublishedAt: '2026-07-13',
    retrievedAt: '2026-08-17T12:00:00.000Z',
    licenceKey: 'cc_by_4',
    denominatorByIso: new Map(), // empty — no weight available
  });
  assertEquals(records.length, 0);
  assertEquals(skipped[0].reason, 'missing_denominator');
});

Deno.test('denominatorMapFromRecords — builds iso -> value from population records', () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  const { records } = transformWorldBankRows(
    POPULATION_TOTAL,
    [wbRow('NGA', 'Nigeria', '2024', 227882945), wbRow('GHA', 'Ghana', '2024', 33787914)],
    { crosswalk: idx, releaseVersion: 'v', sourcePublishedAt: null, retrievedAt: 'now', licenceKey: 'cc_by_4' },
  );
  const m = denominatorMapFromRecords(records);
  assertEquals(m.get('NGA'), 227882945);
  assertEquals(m.get('GHA'), 33787914);
});

Deno.test('snapshot — content hash is STABLE across identical runs, CHANGES on a value change', async () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  const base = transformWorldBankRows(POPULATION_TOTAL, [wbRow('NGA', 'Nigeria', '2024', 227882945)], {
    crosswalk: idx,
    releaseVersion: '2026-07-13',
    sourcePublishedAt: '2026-07-13',
    retrievedAt: '2026-08-17T12:00:00.000Z',
    licenceKey: 'cc_by_4',
  }).records;
  const a = await buildSnapshot(base, { feedKey: 'worldbank_wdi', licenceKey: 'cc_by_4', generatedAt: '2026-08-17T12:00:00.000Z' });
  // SAME data, DIFFERENT wall-clock (generated_at AND each retrieved_at): the hash
  // addresses the content, so it must be identical — this is what makes it usable
  // as the feedRegistry content_hash change signal (a hash change = a DATA change).
  const laterClock = base.map((r) => ({ ...r, retrieved_at: '2027-01-01T00:00:00.000Z' }));
  const b = await buildSnapshot(laterClock, { feedKey: 'worldbank_wdi', licenceKey: 'cc_by_4', generatedAt: '2027-01-01T00:00:00.000Z' });
  assertEquals(a.content_hash, b.content_hash); // clock-independent
  assertEquals(a.content_hash.length, 64); // sha256 hex
  assert(a.generated_at !== b.generated_at); // the artifacts DO differ in their metadata
  assertEquals(b.observations[0].retrieved_at, '2027-01-01T00:00:00.000Z'); // retrieval time still travels

  const changed = base.map((r) => ({ ...r, value: r.value + 1 }));
  const c = await buildSnapshot(changed, { feedKey: 'worldbank_wdi', licenceKey: 'cc_by_4', generatedAt: '2026-08-17T12:00:00.000Z' });
  assert(c.content_hash !== a.content_hash); // a changed number changes the hash
});

Deno.test('snapshot — EVERY observation carries its full vintage; none is bare', async () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  const { records } = transformWorldBankRows(POPULATION_TOTAL, [wbRow('NGA', 'Nigeria', '2024', 227882945)], {
    crosswalk: idx,
    releaseVersion: '2026-07-13',
    sourcePublishedAt: '2026-07-13',
    retrievedAt: '2026-08-17T12:00:00.000Z',
    licenceKey: 'cc_by_4',
  });
  const snap = await buildSnapshot(records, { feedKey: 'worldbank_wdi', licenceKey: 'cc_by_4', generatedAt: 'now' });
  for (const o of snap.observations) {
    assert(o.source.length > 0);
    assert(o.source_dataset.length > 0);
    assert(o.release_version.length > 0);
    assert(o.reference_year > 0);
    assert(o.retrieved_at.length > 0);
  }
  assertEquals(snap.release_versions, ['2026-07-13']);
});

Deno.test('sql — insert uses ON CONFLICT DO NOTHING (append-only, never overwrite)', () => {
  const idx = buildCrosswalkIndex(CROSSWALK_ROWS);
  const { records } = transformWorldBankRows(POPULATION_TOTAL, [wbRow('NGA', 'Nigeria', '2024', 227882945)], {
    crosswalk: idx,
    releaseVersion: '2026-07-13',
    sourcePublishedAt: '2026-07-13',
    retrievedAt: '2026-08-17T12:00:00.000Z',
    licenceKey: 'cc_by_4',
  });
  const sql = buildObservationInsert(records);
  assertStringIncludes(sql, 'insert into atlas.observation');
  assertStringIncludes(sql, 'on conflict on constraint observation_vintage_natural_key do nothing');
  assertStringIncludes(sql, "'2026-07-13'"); // vintage present in the row

  // override simulates a LATER release restating the same year
  const sqlB = buildObservationInsert(records, { releaseVersion: '2026-08-01', sourcePublishedAt: '2026-08-01' });
  assertStringIncludes(sqlB, "'2026-08-01'");
});
