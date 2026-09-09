/**
 * unhcr.test.ts — offline tests for the pure UNHCR displacement layer.
 *
 * Run with `deno test` from this directory. Deno is the Edge Function runtime, so
 * `deno test` runs the TypeScript with no build step and no dependency on apps/web's
 * vitest. Every test is fixture-driven — no network, no database — because the whole
 * reason unhcr.ts is split from index.ts is that its logic is provable offline. The
 * one live-data dependency (does the endpoint exist, is coo_iso really iso_a3?) is
 * verified against the real API in the report, not mocked here.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { buildCrosswalkIndex, buildSnapshot, computeReleaseToken, parseUnhcrResponse, transformUnhcrRows, type UnhcrPopulationRow } from './unhcr.ts';
import { buildObservationInsert } from './sql.ts';

// A tiny crosswalk: real countries keyed by iso_a3 (UNHCR joins on iso_a3 directly).
// TIB/UNK/XXA are deliberately ABSENT — they are UNHCR non-country codes that must
// never resolve to a country.
const CROSSWALK_ROWS = [
  { iso_a3: 'AFG', m49_macro_region_code: 142 }, // Asia
  { iso_a3: 'SYR', m49_macro_region_code: 142 }, // Asia
  { iso_a3: 'ISL', m49_macro_region_code: 150 }, // Europe
];

const OPTS = {
  crosswalk: buildCrosswalkIndex(CROSSWALK_ROWS),
  releaseVersion: 'sha256:testvintage',
  sourcePublishedAt: null,
  retrievedAt: '2026-08-17T12:00:00.000Z',
  licenceKey: 'unhcr_cc_by_igo',
  feedKey: 'unhcr_population',
};

/** Build a UNHCR origin row. Counts may be number OR string, mirroring the real API. */
function row(
  coo_iso: string,
  coo_name: string,
  year: number,
  refugees: number | string | null,
  asylum_seekers: number | string | null,
  idps: number | string | null,
  extra: Partial<UnhcrPopulationRow> = {},
): UnhcrPopulationRow {
  return {
    year,
    coo_id: 0,
    coo_name,
    coo: coo_iso,
    coo_iso,
    coa_iso: '-',
    refugees: refugees as number | string,
    asylum_seekers: asylum_seekers as number | string,
    idps: idps as number | string,
    ...extra,
  };
}

Deno.test('parse — a well-formed response returns its items', () => {
  const body = { page: 1, maxPages: 1, items: [row('AFG', 'Afghanistan', 2024, 6403144, 296033, 3222397)] };
  const parsed = parseUnhcrResponse(body);
  assertEquals(parsed.items.length, 1);
  assertEquals(parsed.items[0].coo_iso, 'AFG');
});

Deno.test('parse — the API root/welcome object (no items) THROWS, never returns zero rows', () => {
  // The real base returns {"message":"Welcome to the API..."} — an object with no items.
  assertThrows(() => parseUnhcrResponse({ message: 'Welcome to the API' }), Error, "no 'items'");
});

Deno.test('parse — an HTML/WAF page (not an object) THROWS with the shape named', () => {
  assertThrows(() => parseUnhcrResponse('<!doctype html>' as unknown), Error, 'not an object');
});

Deno.test('parse — items present but not an array is schema drift and THROWS', () => {
  assertThrows(() => parseUnhcrResponse({ items: 'nope' } as unknown), Error, 'not an array');
});

Deno.test('transform — a well-formed row yields all four extensive indicators, summable', () => {
  const { records, skipped } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, 6403144, 296033, 3222397)], OPTS);
  assertEquals(skipped.length, 0);
  const byInd = Object.fromEntries(records.map((r) => [r.indicator, r]));
  assertEquals(new Set(records.map((r) => r.indicator)), new Set(['refugees_origin', 'asylum_seekers_origin', 'idps', 'forcibly_displaced_origin']));
  // every measure is extensive: unit 'people', agg 'sum', no denominator
  for (const r of records) {
    assertEquals(r.unit, 'people');
    assertEquals(r.agg_method, 'sum');
    assertEquals(r.denominator_value, null);
    assertEquals(r.area_code, 'AFG');
    assertEquals(r.reference_year, 2024);
    assertEquals(r.release_version, 'sha256:testvintage'); // vintage carried
    assertEquals(r.feed_key, 'unhcr_population');
  }
  // the composite is the transparent sum of its three components
  assertEquals(byInd['forcibly_displaced_origin'].value, 6403144 + 296033 + 3222397);
});

Deno.test('transform — a country code that does NOT resolve is dropped whole and recorded', () => {
  // TIB (Tibetan) is a real UNHCR origin code that is NOT an ISO country.
  const { records, skipped } = transformUnhcrRows([row('TIB', 'Tibetan', 2024, 100, 0, 0)], OPTS);
  assertEquals(records.length, 0);
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0].reason, 'aggregate_or_unmapped');
  assertEquals(skipped[0].indicator, null); // the WHOLE row dropped, not one measure
  assertEquals(skipped[0].coo_iso, 'TIB');
});

Deno.test('transform — the UNHCR non-country aggregates (UNK, XXA) are all dropped', () => {
  const rows = [
    row('UNK', 'Unknown', 2024, 5000, 100, 0),
    row('XXA', 'Stateless', 2024, 200, 50, 0),
    row('SYR', 'Syrian Arab Republic', 2024, 4865764, 100000, 5542227), // a real country stays
  ];
  const { records, skipped } = transformUnhcrRows(rows, OPTS);
  // only SYR's four indicators survive
  assertEquals(new Set(records.map((r) => r.area_code)), new Set(['SYR']));
  assertEquals(records.length, 4);
  assertEquals(skipped.filter((s) => s.reason === 'aggregate_or_unmapped').length, 2);
});

Deno.test('transform — counts arriving as STRINGS are coerced (real API mixes int and str)', () => {
  const { records } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, '6403144', '296033', '3222397')], OPTS);
  const byInd = Object.fromEntries(records.map((r) => [r.indicator, r.value]));
  assertEquals(byInd['refugees_origin'], 6403144);
  assertEquals(byInd['forcibly_displaced_origin'], 6403144 + 296033 + 3222397);
});

Deno.test('transform — a genuine ZERO is stored as data, not skipped (absence != zero)', () => {
  // Iceland with 0 refugees/asylum/idps is a REAL measured fact and must be kept.
  const { records, skipped } = transformUnhcrRows([row('ISL', 'Iceland', 2024, 0, '0', 0)], OPTS);
  assertEquals(skipped.length, 0);
  assertEquals(records.length, 4);
  const fd = records.find((r) => r.indicator === 'forcibly_displaced_origin')!;
  assertEquals(fd.value, 0); // a true zero, stored
});

Deno.test('transform — a NULL measure is a known-unknown: that indicator is skipped, others emit', () => {
  // idps is null (source has no observation for that cell). refugees/asylum still emit;
  // the composite is NOT computable, so it is skipped — never a fabricated partial total.
  const { records, skipped } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, 6403144, 296033, null)], OPTS);
  const inds = new Set(records.map((r) => r.indicator));
  assert(inds.has('refugees_origin'));
  assert(inds.has('asylum_seekers_origin'));
  assert(!inds.has('idps')); // the null cell is not stored as a fake zero
  assert(!inds.has('forcibly_displaced_origin')); // incomplete composite
  assertEquals(skipped.find((s) => s.indicator === 'idps')?.reason, 'null_value');
  assertEquals(skipped.find((s) => s.indicator === 'forcibly_displaced_origin')?.reason, 'incomplete_composite');
});

Deno.test('transform — a non-numeric non-null count is a shape we do NOT understand and THROWS', () => {
  // A "-" where a count is expected must halt, not be silently coerced to 0.
  assertThrows(
    () => transformUnhcrRows([row('AFG', 'Afghanistan', 2024, '-', 0, 0)], OPTS),
    Error,
    'schema drift',
  );
});

Deno.test('vintage — identical data yields the SAME token; a changed number yields a DIFFERENT one', async () => {
  const base = [row('AFG', 'Afghanistan', 2024, 6403144, 296033, 3222397), row('SYR', 'Syria', 2024, 4865764, 100000, 5542227)];
  const a = await computeReleaseToken(base);
  const bReordered = await computeReleaseToken([base[1], base[0]]); // order must not matter
  assertEquals(a, bReordered);
  assertStringIncludes(a, 'sha256:');
  const changed = [row('AFG', 'Afghanistan', 2024, 6403145, 296033, 3222397), base[1]]; // +1 refugee
  const c = await computeReleaseToken(changed);
  assert(c !== a); // a real data change advances the vintage
  // string vs int for the SAME number must NOT change the vintage
  const asStrings = [row('AFG', 'Afghanistan', 2024, '6403144', '296033', '3222397'), row('SYR', 'Syria', 2024, '4865764', '100000', '5542227')];
  assertEquals(await computeReleaseToken(asStrings), a);
});

Deno.test('snapshot — content hash is stable across clocks; every observation carries its vintage', async () => {
  const { records } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, 6403144, 296033, 3222397)], OPTS);
  const s1 = await buildSnapshot(records, { feedKey: 'unhcr_population', licenceKey: 'unhcr_cc_by_igo', generatedAt: '2026-08-17T12:00:00.000Z' });
  const laterClock = records.map((r) => ({ ...r, retrieved_at: '2027-01-01T00:00:00.000Z' }));
  const s2 = await buildSnapshot(laterClock, { feedKey: 'unhcr_population', licenceKey: 'unhcr_cc_by_igo', generatedAt: '2027-01-01T00:00:00.000Z' });
  assertEquals(s1.content_hash, s2.content_hash); // clock-independent
  assertEquals(s1.content_hash.length, 64);
  for (const o of s1.observations) {
    assert(o.source === 'UNHCR');
    assert(o.source_dataset.length > 0);
    assert(o.release_version.length > 0);
    assert(o.reference_year > 0);
    assert(o.retrieved_at.length > 0);
  }
});

Deno.test('sql — insert is append-only (ON CONFLICT DO NOTHING) and carries the vintage', () => {
  const { records } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, 6403144, 296033, 3222397)], OPTS);
  const sql = buildObservationInsert(records);
  assertStringIncludes(sql, 'insert into atlas.observation');
  assertStringIncludes(sql, 'on conflict on constraint observation_vintage_natural_key do nothing');
  assertStringIncludes(sql, "'sha256:testvintage'");
  assertStringIncludes(sql, "'unhcr_population'"); // feed_key present
  // an override simulates a LATER UNHCR restatement of the same year -> new vintage
  const next = buildObservationInsert(records, { releaseVersion: 'sha256:NEWVINTAGE', sourcePublishedAt: '2026-09-01' });
  assertStringIncludes(next, "'sha256:NEWVINTAGE'");
});
