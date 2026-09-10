/**
 * unhcr.mutants.test.ts — mutation-hardening tests for the pure UNHCR layer.
 *
 * Companion to unhcr.test.ts; no overlap. Each test names the DEFECT it prevents in
 * SECURITY.md terms: a malformed/foreign payload read as "no displacement anywhere"
 * (the worst possible lie here), a null measure fabricated into a zero, a non-numeric
 * sentinel silently coerced instead of throwing, a bare (vintage-less) observation,
 * and a content/vintage hash that stops tracking the data or its provenance.
 *
 * --allow-read only. No tautologies; throw/skip tests carry a positive control.
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from '@std/assert';
import {
  buildCrosswalkIndex,
  buildSnapshot,
  computeReleaseToken,
  type ObservationRecord,
  parseUnhcrResponse,
  transformUnhcrRows,
  UNHCR_INDICATORS,
  type UnhcrPopulationRow,
} from './unhcr.ts';

const CROSSWALK_ROWS = [
  { iso_a3: 'AFG', m49_macro_region_code: 142 },
  { iso_a3: 'SYR', m49_macro_region_code: 142 },
  { iso_a3: 'ISL', m49_macro_region_code: 150 },
];

const OPTS = {
  crosswalk: buildCrosswalkIndex(CROSSWALK_ROWS),
  releaseVersion: 'sha256:testvintage',
  sourcePublishedAt: null,
  retrievedAt: '2026-08-17T12:00:00.000Z',
  licenceKey: 'unhcr_cc_by_igo',
  feedKey: 'unhcr_population',
};

function row(
  coo_iso: string,
  coo_name: string,
  year: number | string,
  refugees: number | string | null,
  asylum_seekers: number | string | null,
  idps: number | string | null,
): UnhcrPopulationRow {
  return {
    year: year as number,
    coo_id: 0,
    coo_name,
    coo: coo_iso,
    coo_iso,
    coa_iso: '-',
    refugees: refugees as number | string,
    asylum_seekers: asylum_seekers as number | string,
    idps: idps as number | string,
  };
}

/** A ready-made observation record, so the snapshot-ordering tests can vary exactly
 *  the fields the sort keys on without going through the transform. */
function obs(over: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    indicator: 'refugees_origin',
    area_type: 'country',
    area_code: 'AFG',
    ref_period: '2024',
    value: 1,
    unit: 'people',
    agg_method: 'sum',
    denominator_indicator: null,
    denominator_value: null,
    source: 'UNHCR',
    source_dataset: 'population.refugees[coo]',
    release_version: 'v1',
    reference_year: 2024,
    source_published_at: null,
    retrieved_at: '2026-08-17T12:00:00.000Z',
    licence_key: 'unhcr_cc_by_igo',
    feed_key: 'unhcr_population',
    ...over,
  };
}

// ===========================================================================
// THE INDICATOR REGISTER — L193.
// ===========================================================================

Deno.test('UNHCR_INDICATORS lists the four shipped indicators, in order — L193 ArrayDeclaration', () => {
  // Mutant L193 empties the array, which would make the transform emit nothing while
  // still passing every "no throw" test. The register IS the feed's contract.
  assertEquals(UNHCR_INDICATORS.map((c) => c.observationIndicator), [
    'refugees_origin',
    'asylum_seekers_origin',
    'idps',
    'forcibly_displaced_origin',
  ]);
});

// ===========================================================================
// PARSE — the shape guard names the shape; a foreign payload never reads as empty.
// ===========================================================================

Deno.test('parse: the "not an object" message names the shape — L220 ternary', () => {
  assertThrows(() => parseUnhcrResponse(null), Error, 'got null');
  assertThrows(() => parseUnhcrResponse([1, 2]), Error, 'got array');
  assertThrows(() => parseUnhcrResponse(42), Error, 'got number');
});

Deno.test('parse: the no-items throw appends the API message when present, nothing when absent — L225', () => {
  // Mutant L225 `typeof obj.message === 'string' ? ': ' + msg : ''` collapse would either
  // drop the operator-facing reason or append a literal "undefined". Both are refuted.
  assertThrows(() => parseUnhcrResponse({ message: 'Welcome to the API' }), Error, 'Welcome to the API');
  const noMsg = () => parseUnhcrResponse({ foo: 1 });
  assertThrows(noMsg, Error, "no 'items'");
  try {
    noMsg();
  } catch (e) {
    assert(!(e as Error).message.includes('undefined'), 'a missing message must not leak the word "undefined"');
  }
});

Deno.test('parse: page/maxPages are trusted only when numeric, else default to 1 — L232/L233', () => {
  // Mutants force the ternary constant or flip the equality. A numeric page is carried;
  // a missing/non-numeric one defaults to 1 — never the raw string.
  const p = parseUnhcrResponse({ page: 3, maxPages: 5, items: [] });
  assertEquals(p.page, 3);
  assertEquals(p.maxPages, 5);
  const q = parseUnhcrResponse({ page: '3', items: [] });
  assertEquals(q.page, 1); // a string page is not trusted
  assertEquals(q.maxPages, 1); // absent → default
});

// ===========================================================================
// CROSSWALK — L249/L250. The join key is trimmed; empty/whitespace never indexes.
// ===========================================================================

Deno.test('buildCrosswalkIndex: keys are trimmed; blank iso_a3 never becomes a key — L249/L250', () => {
  // Mutants drop the `.trim()` (L250) or collapse the `r.iso_a3 && r.iso_a3.trim() !== ''`
  // guard (L249). A padded code must index under its trimmed form; a blank must not index.
  const idx = buildCrosswalkIndex([
    { iso_a3: 'AFG', m49_macro_region_code: 1 },
    { iso_a3: '  SYR  ', m49_macro_region_code: 2 },
    { iso_a3: '', m49_macro_region_code: 3 },
    { iso_a3: '   ', m49_macro_region_code: 4 },
  ]);
  assertEquals(idx.size, 2);
  assert(idx.has('AFG'));
  assert(idx.has('SYR')); // trimmed key
  assert(!idx.has('  SYR  '));
  assertEquals(idx.get('SYR')!.iso_a3, 'SYR'); // trimmed value too
  assert(!idx.has(''));
});

// ===========================================================================
// COUNT COERCION (readCount) — the throw-vs-skip line. SECURITY.md: a shape we do
// not understand HALTS; a null cell is a known-unknown, never a fabricated zero.
// ===========================================================================

Deno.test('readCount via transform: a null measure is a known-unknown skip, never coerced or thrown — L273', () => {
  // Mutant L273 `if (v === null || v === undefined) return missing` → false sends null
  // down to the final throw, turning an ordinary missing cell into a hard error. It must
  // be a recorded null_value skip, and the other measures must still emit (positive control).
  const { records, skipped } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, null, 296033, 3222397)], OPTS);
  assert(!records.some((r) => r.indicator === 'refugees_origin'));
  assert(records.some((r) => r.indicator === 'asylum_seekers_origin'));
  assertEquals(skipped.find((s) => s.indicator === 'refugees_origin')?.reason, 'null_value');
});

Deno.test('readCount via transform: a non-finite number is schema drift and THROWS — L275', () => {
  // Mutant L275 `if (!Number.isFinite(v)) throw` → false would return NaN as a real count.
  assertThrows(() => transformUnhcrRows([row('AFG', 'Afghanistan', 2024, NaN, 0, 0)], OPTS), Error, 'non-finite');
});

Deno.test('readCount via transform: a padded numeric string is trimmed then parsed — L279 .trim()', () => {
  // Mutant L279 `const t = v.trim()` → `v` leaves the spaces, so the digit regex fails and
  // a perfectly good count throws. The real API mixes int and string; padding must coerce.
  const { records } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, '  100  ', 0, 0)], OPTS);
  assertEquals(records.find((r) => r.indicator === 'refugees_origin')?.value, 100);
});

Deno.test('readCount via transform: a whitespace-only string is MISSING, not a fabricated 0 — L280', () => {
  // Mutant L280 `if (t === '') return missing` → false (or the ObjectLiteral → {}) would
  // either throw or emit an undefined value. A blank cell is a null_value skip.
  const { records, skipped } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, '   ', 0, 0)], OPTS);
  assert(!records.some((r) => r.indicator === 'refugees_origin'));
  assertEquals(skipped.find((s) => s.indicator === 'refugees_origin')?.reason, 'null_value');
});

Deno.test('readCount via transform: the count regex is fully anchored — leading/trailing junk THROWS — L281', () => {
  // Mutants drop the `^` or the `$` anchor from /^-?\d+$/. Without `^`, 'abc123' matches
  // and parseInt yields NaN; without `$`, '123abc' matches and parseInt yields a wrong 123.
  // A count with ANY non-digit is schema drift and must throw, not be silently salvaged.
  assertThrows(() => transformUnhcrRows([row('AFG', 'Afghanistan', 2024, 'abc123', 0, 0)], OPTS), Error, 'non-numeric');
  assertThrows(() => transformUnhcrRows([row('AFG', 'Afghanistan', 2024, '123abc', 0, 0)], OPTS), Error, 'non-numeric');
  // positive control: a clean numeric string coerces fine.
  assertEquals(transformUnhcrRows([row('AFG', 'Afghanistan', 2024, '123', 0, 0)], OPTS).records.find((r) => r.indicator === 'refugees_origin')?.value, 123);
});

Deno.test('readCount via transform: a non-string non-number count is schema drift — L285 final throw', () => {
  // Mutant L285 removes the final throw's message content; a boolean where a count is
  // expected must halt with "schema drift", not be silently accepted or crash generically.
  assertThrows(() => transformUnhcrRows([row('AFG', 'Afghanistan', 2024, true as unknown as number, 0, 0)], OPTS), Error, 'schema drift');
});

Deno.test('transform: the schema-drift error names the offending country/year — L346 ctx', () => {
  // Mutant L346 `const ctx = ` ${coo_iso}/${year} `` → `` blanks the context, so an
  // operator triaging a drift cannot see WHICH cell broke. The message must carry 'AFG/2024'.
  assertThrows(() => transformUnhcrRows([row('AFG', 'Afghanistan', 2024, '-', 0, 0)], OPTS), Error, 'AFG/2024');
});

// ===========================================================================
// TRANSFORM — reference year coercion and the fixed area_type.
// ===========================================================================

Deno.test('transform: a string year is coerced to a numeric reference_year — L323', () => {
  // Mutant L323 forces the ternary to `row.year` even for a string, so reference_year
  // would be the STRING '2024' rather than the number 2024. Strict-equality refutes it.
  const { records } = transformUnhcrRows([row('AFG', 'Afghanistan', '2024', 100, 0, 0)], OPTS);
  const r = records.find((x) => x.indicator === 'refugees_origin')!;
  assertEquals(r.reference_year, 2024);
  assertEquals(r.area_type, 'country'); // L326 StringLiteral: never a blank area_type
});

// ===========================================================================
// VINTAGE TOKEN (computeReleaseToken) — the missing/zero distinction and per-field
// provenance. SECURITY.md item 4: the hash must move with the data, not the clock.
// ===========================================================================

Deno.test('vintage: a null measure and a genuine 0 yield DIFFERENT tokens — L428 ternary', async () => {
  // Mutant L428 `r.kind === 'number' ? r.value : null` → false would map every read to
  // null, so idps=0 and idps=null would hash identically — collapsing "we measured zero"
  // into "we have no measurement". They must stay distinct.
  const withZero = await computeReleaseToken([row('AFG', 'Afghanistan', 2024, 100, 0, 0)]);
  const withNull = await computeReleaseToken([row('AFG', 'Afghanistan', 2024, 100, 0, null)]);
  assertNotEquals(withZero, withNull);
});

Deno.test('vintage: each component field is read from its OWN column — L433/L434/L435', async () => {
  // Mutants replace the field name passed to read() with '' (reading row[''] → always
  // null), so changing that component would not move the token. Each component, varied
  // alone, must change the vintage.
  const base = row('AFG', 'Afghanistan', 2024, 100, 200, 300);
  const t0 = await computeReleaseToken([base]);
  assertNotEquals(await computeReleaseToken([row('AFG', 'Afghanistan', 2024, 999, 200, 300)]), t0); // refugees
  assertNotEquals(await computeReleaseToken([row('AFG', 'Afghanistan', 2024, 100, 999, 300)]), t0); // asylum_seekers
  assertNotEquals(await computeReleaseToken([row('AFG', 'Afghanistan', 2024, 100, 200, 999)]), t0); // idps
});

Deno.test('vintage: token is invariant to row order EVEN within one country across years — L438 sort', async () => {
  // Mutant L438 `a.coo_iso.localeCompare(b) || a.year - b.year` → `a.year + b.year` breaks
  // the year ordering, so the same two rows fed in opposite orders would hash differently.
  const a = await computeReleaseToken([row('AFG', 'A', 2023, 1, 2, 3), row('AFG', 'A', 2024, 4, 5, 6)]);
  const b = await computeReleaseToken([row('AFG', 'A', 2024, 4, 5, 6), row('AFG', 'A', 2023, 1, 2, 3)]);
  assertEquals(a, b);
});

Deno.test('vintage: the token is a stable golden and carries the sha256 prefix — L399-L403 canonicalJson', async () => {
  // Golden produced by the unmutated code over one AFG/2024 row. Any change to the
  // canonical serialisation moves it.
  const token = await computeReleaseToken([row('AFG', 'Afghanistan', 2024, 6403144, 296033, 3222397)]);
  assertStringIncludes(token, 'sha256:');
  assertEquals(token, 'sha256:f71dfdbb5c726e60887961c5f494e79535418b2a1644041ffb467aa748cacddd');
});

// ===========================================================================
// SNAPSHOT — sort keys, release-version set, identity strings, canonicalJson golden.
// ===========================================================================

Deno.test('snapshot: observations sort by (indicator, area, year, release) — L507/L508/L510', async () => {
  // Mutant L510 `a.reference_year - b.reference_year` → `+` and L508 `||` → `&&` break the
  // ordering. Records fed out of order must come back fully sorted, with the year tie-break
  // exercised (same indicator+area, two years).
  const snap = await buildSnapshot(
    [
      obs({ indicator: 'idps', area_code: 'SYR', reference_year: 2024 }),
      obs({ indicator: 'idps', area_code: 'AFG', reference_year: 2024 }),
      obs({ indicator: 'idps', area_code: 'AFG', reference_year: 2020 }),
      obs({ indicator: 'refugees_origin', area_code: 'AFG', reference_year: 2024 }),
    ],
    { feedKey: 'unhcr_population', licenceKey: 'unhcr_cc_by_igo', generatedAt: 'now' },
  );
  assertEquals(
    snap.observations.map((o) => `${o.indicator}/${o.area_code}/${o.reference_year}`),
    ['idps/AFG/2020', 'idps/AFG/2024', 'idps/SYR/2024', 'refugees_origin/AFG/2024'],
  );
});

Deno.test('snapshot: release_versions is the deduped, sorted vintage set — L514', async () => {
  const snap = await buildSnapshot(
    [obs({ area_code: 'AFG', release_version: 'v2' }), obs({ area_code: 'SYR', release_version: 'v1' }), obs({ area_code: 'ISL', release_version: 'v2' })],
    { feedKey: 'unhcr_population', licenceKey: 'unhcr_cc_by_igo', generatedAt: 'now' },
  );
  assertEquals(snap.release_versions, ['v1', 'v2']);
});

Deno.test('snapshot: identity strings are exact — L528/L530', async () => {
  const snap = await buildSnapshot([obs()], { feedKey: 'unhcr_population', licenceKey: 'unhcr_cc_by_igo', generatedAt: 'now' });
  assertEquals(snap.schema_version, 'atlas.snapshot.v1');
  assertEquals(snap.source, 'UNHCR');
});

Deno.test('snapshot: content hash is a stable golden — pins canonicalJson (L399-L403) + hash core (L516-L523)', async () => {
  // Golden from the unmutated builder over one AFG/2024 row's four indicators. It moves
  // if the canonical serialisation changes, if the hash core drops the retrieved_at
  // omission (L523) or its object shape (L516), or if an identity literal is blanked.
  const { records } = transformUnhcrRows([row('AFG', 'Afghanistan', 2024, 6403144, 296033, 3222397)], OPTS);
  const snap = await buildSnapshot(records, { feedKey: 'unhcr_population', licenceKey: 'unhcr_cc_by_igo', generatedAt: '2026-08-17T12:00:00.000Z' });
  assertEquals(snap.content_hash, '5a40f21f22487cb002ffcb4e140b684df551a0b33199a260125b9987a9516bb4');
  assertEquals(snap.content_hash.length, 64);
  const moved = await buildSnapshot(records.map((r) => ({ ...r, value: r.value + 1 })), {
    feedKey: 'unhcr_population',
    licenceKey: 'unhcr_cc_by_igo',
    generatedAt: '2026-08-17T12:00:00.000Z',
  });
  assertNotEquals(moved.content_hash, snap.content_hash);
});
