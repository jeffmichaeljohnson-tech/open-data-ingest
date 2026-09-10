/**
 * usgs.mutants.test.ts — mutation-hardening tests for the pure USGS layer.
 *
 * Companion to usgs.test.ts; no overlap. Every test names the DEFECT it prevents in
 * the SECURITY.md vocabulary: a foreign/malformed payload reading as zero earthquakes,
 * a null measure stored as a fake zero, a coordinate/magnitude/time sentinel stored
 * instead of skipped, a bare record with no vintage, and a content hash that stops
 * tracking the data or starts tracking the clock.
 *
 * No network, no disk, --allow-read only. No tautologies; skip/throw tests carry a
 * positive control so an always-skip or always-throw function cannot pass.
 */
import { assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import { buildSnapshot, type EventRecord, parseUsgsResponse, transformUsgsFeatures, type UsgsFeature } from './usgs.ts';

const OPTS = { feedKey: 'usgs_quakes', releaseVersion: '1787004086000', retrievedAt: '2026-08-17T12:00:00.000Z', licenceKey: 'usgs_pd' };

/** A well-formed feature; `props`/`coords` override the defaults. Uses `in` so an
 *  explicit null (mag:null, time:null) is preserved rather than defaulted. */
function feature(
  id: string,
  coords: number[] | null,
  props: Partial<{ mag: number | null; magType: string | null; type: string | null; time: number | null; place: unknown }> = {},
): UsgsFeature {
  return {
    type: 'Feature',
    id,
    geometry: coords === null ? null : { type: 'Point', coordinates: coords },
    properties: {
      mag: 'mag' in props ? (props.mag ?? null) : 5.1,
      magType: 'magType' in props ? (props.magType ?? null) : 'mb',
      type: 'type' in props ? (props.type ?? null) : 'earthquake',
      time: 'time' in props ? (props.time ?? null) : 1787002595887,
      place: 'place' in props ? props.place : 'Kuril Islands',
    } as UsgsFeature['properties'],
  };
}

function collection(features: UsgsFeature[], generated = 1787004086000, metaExtra: Record<string, unknown> = {}): unknown {
  return { type: 'FeatureCollection', metadata: { generated, ...metaExtra }, features };
}

/** A ready-made EventRecord, for snapshot-ordering tests that need control over
 *  fields the transform derives (release_version, occurred_at). */
function record(over: Partial<EventRecord> = {}): EventRecord {
  return {
    feed_key: 'usgs_quakes',
    external_id: 'id',
    event_type: 'earthquake',
    occurred_at: '2026-08-17T00:00:00.000Z',
    lon: 1,
    lat: 2,
    depth_km: 10,
    magnitude: 5,
    magnitude_kind: 'richter',
    magnitude_scale: 'mb',
    place: 'somewhere',
    source: 'USGS',
    release_version: '1',
    retrieved_at: '2026-08-17T12:00:00.000Z',
    licence_key: 'usgs_pd',
    ...over,
  };
}

// ===========================================================================
// PARSE — the shape guard names the offending shape; a foreign payload never
// reads as "no earthquakes". Pins the message ternaries (L156/L174) and the
// metadata guard (L166) that usgs.test.ts asserts only loosely.
// ===========================================================================

Deno.test('parse: the "not a GeoJSON object" message names the actual shape — L156 ternary', () => {
  // Mutants collapse `body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body`.
  // Each shape must be named precisely, so an operator reading the log knows what arrived.
  assertThrows(() => parseUsgsResponse(null), Error, 'got null');
  assertThrows(() => parseUsgsResponse([{ foo: 1 }]), Error, 'got array');
  assertThrows(() => parseUsgsResponse(42), Error, 'got number');
});

Deno.test('parse: metadata that is null or a non-object throws "no metadata" — L166 guard', () => {
  // Mutant L166 `meta === undefined || meta === null || typeof meta !== 'object'` → any
  // collapse would let a null/primitive metadata through to `meta.generated`, which
  // then crashes with an unrelated message. It must be refused as "no metadata".
  assertThrows(() => parseUsgsResponse({ type: 'FeatureCollection', metadata: null, features: [] }), Error, 'no metadata');
  assertThrows(() => parseUsgsResponse({ type: 'FeatureCollection', metadata: 'x', features: [] }), Error, 'no metadata');
});

Deno.test('parse: the features-not-array message names "absent" vs the wrong type — L174 ternary', () => {
  // Mutant L174 `obj.features === undefined ? 'absent' : typeof obj.features` collapse
  // would misreport why the shape is wrong. Absent and wrong-typed features are distinct.
  assertThrows(() => parseUsgsResponse({ type: 'FeatureCollection', metadata: { generated: 1 } }), Error, 'is absent');
  assertThrows(() => parseUsgsResponse({ type: 'FeatureCollection', metadata: { generated: 1 }, features: 5 }), Error, 'is number');
});

Deno.test('parse: meta.count falls back to features.length ONLY when it is not a number — L180', () => {
  // Mutant L180 forces the ternary to a constant or flips `typeof meta.count === 'number'`.
  // A numeric count is trusted; a missing or non-numeric count is replaced by the actual
  // feature count — never the other way round (which would misreport the batch size).
  const withCount = parseUsgsResponse(collection([feature('a', [1, 1, 5]), feature('b', [2, 2, 5])], 1, { count: 99 }));
  assertEquals(withCount.meta.count, 99);
  const noCount = parseUsgsResponse(collection([feature('a', [1, 1, 5]), feature('b', [2, 2, 5])], 1));
  assertEquals(noCount.meta.count, 2); // fell back to features.length
  const badCount = parseUsgsResponse(collection([feature('a', [1, 1, 5])], 1, { count: '7' }));
  assertEquals(badCount.meta.count, 1); // a string count is not trusted
});

Deno.test('parse: optional string meta fields are kept only when they are strings — L181-L184', () => {
  // The title/status/url/api coercions each survived as ternary/equality/string mutants.
  // A present string is carried; a wrong-typed value becomes undefined, never a blank.
  const p = parseUsgsResponse(collection([feature('a', [1, 1, 5])], 1, { title: 'USGS M4.5+', status: 200, url: 'http://u', api: '2.7.0' }));
  assertEquals(p.meta.title, 'USGS M4.5+');
  assertEquals(p.meta.status, 200);
  assertEquals(p.meta.url, 'http://u');
  assertEquals(p.meta.api, '2.7.0');
  const q = parseUsgsResponse(collection([feature('a', [1, 1, 5])], 1, { title: 123, status: 'nope', url: 5, api: {} }));
  assertEquals(q.meta.title, undefined);
  assertEquals(q.meta.status, undefined);
  assertEquals(q.meta.url, undefined);
  assertEquals(q.meta.api, undefined);
});

// ===========================================================================
// TRANSFORM — coordinate/time/magnitude sentinels are SKIPPED, not stored; a null
// magnitude is stored as null (not a fake zero); scale/type/place are labelled.
// ===========================================================================

Deno.test('transform: a skipped feature with no id records "(no id)", not an empty id — L231', () => {
  // Mutant L231 `'(no id)'` → `''` would give a skip row an empty, meaningless id.
  const { skipped } = transformUsgsFeatures([{ type: 'Feature', geometry: null, properties: feature('x', [1, 1, 5]).properties } as UsgsFeature], OPTS);
  assertEquals(skipped[0].id, '(no id)');
});

Deno.test('transform: coordinate range boundaries are inclusive; just-outside and NaN are skipped — L244/L245', () => {
  // Pins every comparison operator in the compound guard in both directions. A point at
  // exactly ±180/±90 is a real place and must be KEPT; a value strictly beyond, or a
  // non-finite one, is corruption (a swapped lon/lat, a sentinel) and is SKIPPED.
  const keep = (coords: number[]) => transformUsgsFeatures([feature('k', coords)], OPTS).records.length;
  const drop = (coords: number[]) => transformUsgsFeatures([feature('d', coords)], OPTS);
  assertEquals(keep([-180, 45, 5]), 1);
  assertEquals(keep([180, 45, 5]), 1);
  assertEquals(keep([45, -90, 5]), 1);
  assertEquals(keep([45, 90, 5]), 1);
  for (const bad of [[-180.0001, 0, 5], [180.0001, 0, 5], [0, -90.0001, 5], [0, 90.0001, 5], [NaN, 0, 5], [0, NaN, 5]]) {
    const { records, skipped } = drop(bad);
    assertEquals(records.length, 0, `expected ${JSON.stringify(bad)} to be skipped`);
    assertEquals(skipped[0].reason, 'invalid_coordinates');
  }
});

Deno.test('transform: a NaN time is skipped as missing_time, never allowed to crash the batch — L255', () => {
  // Mutant L255 logical `typeof time !== 'number' && !Number.isFinite(time)` (instead of
  // ||) lets NaN fall through to `new Date(NaN).toISOString()`, which THROWS and loses
  // the whole batch. A NaN time must be a recorded skip, and a real quake beside it must
  // survive — that pairing is the positive control.
  const { records, skipped } = transformUsgsFeatures([feature('bad', [1, 1, 5], { time: NaN }), feature('good', [2, 2, 5])], OPTS);
  assertEquals(records.length, 1);
  assertEquals(records[0].external_id, 'good');
  assertEquals(skipped[0].reason, 'missing_time');
});

Deno.test('transform: the largest valid epoch is KEPT; one past it is skipped — L255 Math.abs boundary', () => {
  // Mutant L255 `Math.abs(time) > MAX_EPOCH_MS` → `>= MAX_EPOCH_MS` would reject the
  // extreme-but-valid timestamp that `new Date` still accepts. Boundary must be inclusive.
  const MAX = 8.64e15;
  assertEquals(transformUsgsFeatures([feature('edge', [1, 1, 5], { time: MAX })], OPTS).records.length, 1);
  assertEquals(transformUsgsFeatures([feature('over', [1, 1, 5], { time: MAX + 1 })], OPTS).skipped[0].reason, 'missing_time');
});

Deno.test('transform: a null magnitude is STORED as null (absence != zero); an out-of-range one skips — L264/L266', () => {
  // Mutant L264 `props.mag === null || props.mag === undefined` → false would send a
  // legitimate "located, magnitude unknown" event down the out-of-range skip path,
  // losing real data. A null mag is stored as null and kind null — never a fabricated 0.
  const nullMag = transformUsgsFeatures([feature('n', [1, 1, 5], { mag: null, magType: null })], OPTS);
  assertEquals(nullMag.records.length, 1);
  assertEquals(nullMag.records[0].magnitude, null);
  assertEquals(nullMag.records[0].magnitude_kind, null);
});

Deno.test('transform: the seismic magnitude bounds are inclusive; outside is a sentinel skip — L266 >=/<=', () => {
  // Mutants `props.mag >= MAG_MIN` → `>` and `props.mag <= MAG_MAX` → `<` would reject a
  // magnitude sitting exactly on the physical bound. MAG_MIN=-2, MAG_MAX=12.
  assertEquals(transformUsgsFeatures([feature('min', [1, 1, 5], { mag: -2 })], OPTS).records[0].magnitude, -2);
  assertEquals(transformUsgsFeatures([feature('max', [1, 1, 5], { mag: 12 })], OPTS).records[0].magnitude, 12);
  assertEquals(transformUsgsFeatures([feature('lo', [1, 1, 5], { mag: -2.0001 })], OPTS).skipped[0].reason, 'magnitude_out_of_range');
  assertEquals(transformUsgsFeatures([feature('hi', [1, 1, 5], { mag: 12.0001 })], OPTS).skipped[0].reason, 'magnitude_out_of_range');
});

Deno.test('transform: magType and event_type are trimmed; blank/absent become null / "earthquake" — L273/L281', () => {
  // Mutants drop the `.trim()` or collapse the `typeof … === 'string' && … !== ''` guard.
  const trimmed = transformUsgsFeatures([feature('t', [1, 1, 5], { magType: '  mww  ', type: '  quarry blast  ' })], OPTS).records[0];
  assertEquals(trimmed.magnitude_scale, 'mww');
  assertEquals(trimmed.event_type, 'quarry blast');
  const blank = transformUsgsFeatures([feature('b', [1, 1, 5], { magType: '   ', type: '' })], OPTS).records[0];
  assertEquals(blank.magnitude_scale, null); // a whitespace-only scale is not a scale
  assertEquals(blank.event_type, 'earthquake'); // the documented default, not a blank
});

Deno.test('transform: depth is kept only when finite; a NaN/absent depth becomes null — L285', () => {
  // Mutant L285 collapses `typeof depth === 'number' && Number.isFinite(depth)`. A real
  // depth is carried; a non-finite or absent one is null, never a fake number.
  assertEquals(transformUsgsFeatures([feature('d', [1, 1, 33.3])], OPTS).records[0].depth_km, 33.3);
  assertEquals(transformUsgsFeatures([feature('n', [1, 1, NaN])], OPTS).records[0].depth_km, null);
  assertEquals(transformUsgsFeatures([feature('m', [1, 1])], OPTS).records[0].depth_km, null); // no depth element
});

Deno.test('transform: place is kept only when it is a string — L291', () => {
  // Mutant L291 flips `typeof props.place === 'string'`. A numeric place is not a place.
  assertEquals(transformUsgsFeatures([feature('p', [1, 1, 5], { place: 'Kuril Islands' })], OPTS).records[0].place, 'Kuril Islands');
  assertEquals(transformUsgsFeatures([feature('p', [1, 1, 5], { place: 12345 })], OPTS).records[0].place, null);
});

// ===========================================================================
// SNAPSHOT — sort order, release-version set, identity strings, canonicalJson.
// ===========================================================================

Deno.test('snapshot: events sort by (occurred_at, external_id); a tie falls to external_id — L393 sort + ||', async () => {
  // Mutant L393 `.sort(...)` → `() => undefined` (no reorder) and the inner `||` → `&&`.
  // Two events with the SAME occurred_at but out-of-order ids must come back id-sorted,
  // and a later occurred_at must sort after an earlier one.
  const snap = await buildSnapshot(
    [
      record({ external_id: 'z', occurred_at: '2026-01-01T00:00:00.000Z' }),
      record({ external_id: 'a', occurred_at: '2026-01-01T00:00:00.000Z' }),
      record({ external_id: 'm', occurred_at: '2025-01-01T00:00:00.000Z' }),
    ],
    { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: 'now' },
  );
  assertEquals(snap.events.map((e) => e.external_id), ['m', 'a', 'z']);
});

Deno.test('snapshot: release_versions is the DEDUPED, SORTED set of vintages — L395', async () => {
  // Mutant L395 drops `.sort()` (or the map). Two records carrying vintages in reverse
  // order, one duplicated, must yield a sorted, unique list — a fast staleness read.
  const snap = await buildSnapshot(
    [record({ external_id: 'a', release_version: 'v2' }), record({ external_id: 'b', release_version: 'v1' }), record({ external_id: 'c', release_version: 'v2' })],
    { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: 'now' },
  );
  assertEquals(snap.release_versions, ['v1', 'v2']);
});

Deno.test('snapshot: identity strings are exact — L412/L414', async () => {
  const snap = await buildSnapshot([record()], { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: 'now' });
  assertEquals(snap.schema_version, 'atlas.snapshot.v1');
  assertEquals(snap.source, 'USGS');
  assertEquals(snap.feed_key, 'usgs_quakes');
});

Deno.test('snapshot: content hash is a stable golden over fixed data — pins canonicalJson (L341-L345) + hash core (L401/L403)', async () => {
  // Golden produced by the unmutated builder over this exact fixture. Any change to the
  // canonical serialisation (dropped key-sort, blanked delimiter, flipped null/array
  // branch) or to a hash-core identity string moves the digest and fails here. The
  // record carries a null field (depth is finite, but place stays a string; magnitude
  // holds a number and magnitude_scale a string) plus nested-free but multi-key objects.
  const { records } = transformUsgsFeatures([feature('us6000tlbz', [151.3834, 46.4341, 90.992])], OPTS);
  const snap = await buildSnapshot(records, { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: '2026-08-17T12:00:00.000Z' });
  assertEquals(snap.content_hash, '340ecd08cb4ba44be763f179922cbb27adb2038f2d6cea507beedbcc2a7b01b9');
  assertEquals(snap.content_hash.length, 64);
  // the golden pins content, not a constant: a changed magnitude moves it.
  const moved = await buildSnapshot(records.map((r) => ({ ...r, magnitude: 5.2 })), { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: '2026-08-17T12:00:00.000Z' });
  assertNotEquals(moved.content_hash, snap.content_hash);
});

Deno.test('snapshot: a null-bearing record hashes without throwing — canonicalJson null branch (L341)', async () => {
  // Mutant L341 `value === null` → `value !== null` makes canonicalJson fall through on
  // null and call Object.keys(null), which THROWS. A record with null magnitude/scale/
  // place/depth must still hash cleanly, so this refutes the equality mutant.
  const snap = await buildSnapshot([record({ magnitude: null, magnitude_kind: null, magnitude_scale: null, place: null, depth_km: null })], {
    feedKey: 'usgs_quakes',
    licenceKey: 'usgs_pd',
    generatedAt: 'now',
  });
  assertEquals(snap.content_hash.length, 64);
});
