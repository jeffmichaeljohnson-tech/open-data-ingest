/**
 * usgs.test.ts — offline tests for the pure USGS layer.
 *
 * Run with `deno test` from this directory. Deno is chosen deliberately: this is a
 * Supabase Edge Function, Deno IS its runtime, and `deno test` runs the TypeScript
 * with no build step and no dependency on apps/web's vitest (which this lane must not
 * touch). Every test is fixture-driven — no network, no database — because the whole
 * reason usgs.ts is split from index.ts is that its logic is provable offline. The one
 * live-data dependency (does the 4.5_day feed really have this shape?) was verified by
 * fetching it, not mocked here.
 *
 * The fixtures below are trimmed from a REAL 4.5_day response captured 2026-08-17
 * (feature id 'us6000tlbz', place 'Kuril Islands', magType 'mb', geometry
 * [151.3834, 46.4341, 90.992]).
 */
import {
  assert,
  assertEquals,
  assertThrows,
  assertStringIncludes,
  assertNotEquals,
} from '@std/assert';
import {
  parseUsgsResponse,
  transformUsgsFeatures,
  buildSnapshot,
  type UsgsFeature,
} from './usgs.ts';
import { buildEventInsert, buildLicenceSeed, buildFeedSeed, buildHeartbeatUpsert } from './sql.ts';

const OPTS = {
  feedKey: 'usgs_quakes',
  releaseVersion: '1787004086000',
  retrievedAt: '2026-08-17T12:00:00.000Z',
  licenceKey: 'usgs_pd',
};

/** A well-formed feature, shaped exactly like the live 4.5_day response. */
function feature(
  id: string,
  coords: number[] | null,
  props: Partial<{ mag: number | null; magType: string | null; type: string | null; time: number | null; place: string }> = {},
): UsgsFeature {
  // Use `in` rather than `??` so an EXPLICIT null (mag:null, time:null) is passed
  // through instead of being replaced by the default — the whole point of those cases.
  return {
    type: 'Feature',
    id,
    geometry: coords === null ? null : { type: 'Point', coordinates: coords },
    properties: {
      mag: 'mag' in props ? (props.mag ?? null) : 5.1,
      magType: 'magType' in props ? (props.magType ?? null) : 'mb',
      type: 'type' in props ? (props.type ?? null) : 'earthquake',
      time: 'time' in props ? (props.time ?? null) : 1787002595887,
      place: props.place ?? 'Kuril Islands',
    },
  };
}

function collection(features: UsgsFeature[], generated = 1787004086000): unknown {
  return {
    type: 'FeatureCollection',
    metadata: { generated, url: 'https://earthquake.usgs.gov/...', title: 'USGS M4.5+', status: 200, api: '2.7.0', count: features.length },
    features,
    bbox: [-180, -90, 0, 180, 90, 700],
  };
}

// ---------------------------------------------------------------------------
// PARSE
// ---------------------------------------------------------------------------

Deno.test('parse — a well-formed FeatureCollection yields metadata + features', () => {
  const parsed = parseUsgsResponse(collection([feature('us6000tlbz', [151.3834, 46.4341, 90.992])]));
  assertEquals(parsed.meta.generated, 1787004086000);
  assertEquals(parsed.features.length, 1);
  assertEquals(parsed.features[0].id, 'us6000tlbz');
});

Deno.test('parse — an EMPTY feature list is data (no throw), not an error', () => {
  const parsed = parseUsgsResponse(collection([]));
  assertEquals(parsed.features.length, 0);
  assertEquals(parsed.meta.generated, 1787004086000); // vintage still present
});

Deno.test('parse — an UNKNOWN shape THROWS, never returns zero rows', () => {
  // not an object
  assertThrows(() => parseUsgsResponse('<!doctype html>' as unknown), Error, 'not a GeoJSON object');
  // an array (e.g. a different API's payload)
  assertThrows(() => parseUsgsResponse([{ foo: 1 }] as unknown), Error, 'not a GeoJSON object');
  // wrong type field
  assertThrows(() => parseUsgsResponse({ type: 'Topology', metadata: { generated: 1 }, features: [] }), Error, "expected 'FeatureCollection'");
  // missing metadata
  assertThrows(() => parseUsgsResponse({ type: 'FeatureCollection', features: [] }), Error, 'no metadata');
  // metadata without a numeric generated token
  assertThrows(() => parseUsgsResponse({ type: 'FeatureCollection', metadata: {}, features: [] }), Error, 'metadata.generated');
  // features not an array
  assertThrows(() => parseUsgsResponse({ type: 'FeatureCollection', metadata: { generated: 1 }, features: {} }), Error, 'expected an array');
});

// ---------------------------------------------------------------------------
// TRANSFORM
// ---------------------------------------------------------------------------

Deno.test('transform — a well-formed quake becomes a full, vintage-carrying record', () => {
  const { records, skipped } = transformUsgsFeatures([feature('us6000tlbz', [151.3834, 46.4341, 90.992])], OPTS);
  assertEquals(skipped.length, 0);
  assertEquals(records.length, 1);
  const r = records[0];
  assertEquals(r.external_id, 'us6000tlbz');
  assertEquals(r.event_type, 'earthquake');
  assertEquals(r.lon, 151.3834);
  assertEquals(r.lat, 46.4341);
  assertEquals(r.depth_km, 90.992);
  assertEquals(r.magnitude, 5.1);
  assertEquals(r.magnitude_kind, 'richter'); // the CHECK-admitted, non-summable bucket
  assertEquals(r.magnitude_scale, 'mb'); // the TRUE scale, preserved not flattened
  assertEquals(r.source, 'USGS');
  assertEquals(r.release_version, '1787004086000'); // vintage carried
  assertEquals(r.retrieved_at, '2026-08-17T12:00:00.000Z');
  assertEquals(r.occurred_at, new Date(1787002595887).toISOString());
  assertEquals(r.licence_key, 'usgs_pd');
});

Deno.test('transform — a NULL/missing geometry is skipped with a reason, never faked', () => {
  const { records, skipped } = transformUsgsFeatures([feature('nogeo', null)], OPTS);
  assertEquals(records.length, 0);
  assertEquals(skipped[0].reason, 'missing_geometry');
});

Deno.test('transform — a feature with depth but NO magnitude is STORED (mag null), not dropped', () => {
  // A located event of unknown magnitude is real data — location measured, magnitude
  // not. It is stored with magnitude null and magnitude_kind null, never a fake zero.
  const { records, skipped } = transformUsgsFeatures(
    [feature('nomag', [10, 20, 33.3], { mag: null, magType: null })],
    OPTS,
  );
  assertEquals(skipped.length, 0);
  assertEquals(records.length, 1);
  assertEquals(records[0].magnitude, null);
  assertEquals(records[0].magnitude_kind, null);
  assertEquals(records[0].depth_km, 33.3);
});

Deno.test('transform — different magTypes are LABELLED, never flattened together', () => {
  const { records } = transformUsgsFeatures(
    [
      feature('a', [1, 1, 10], { magType: 'mww', mag: 6.2 }),
      feature('b', [2, 2, 10], { magType: 'ml', mag: 4.6 }),
      feature('c', [3, 3, 10], { magType: 'md', mag: 4.5 }),
    ],
    OPTS,
  );
  assertEquals(records.map((r) => r.magnitude_scale), ['mww', 'ml', 'md']);
  // all three share the coarse non-summable bucket, but keep their distinct scale
  assertEquals([...new Set(records.map((r) => String(r.magnitude_kind)))], ['richter']);
});

Deno.test('transform — a finite but out-of-range magnitude is a sentinel, skipped', () => {
  const { records, skipped } = transformUsgsFeatures([feature('sentinel', [1, 1, 10], { mag: 99 })], OPTS);
  assertEquals(records.length, 0);
  assertEquals(skipped[0].reason, 'magnitude_out_of_range');
});

Deno.test('transform — impossible coordinates (swapped lon/lat) are skipped', () => {
  const { records, skipped } = transformUsgsFeatures([feature('swap', [46.4, 181.3, 5])], OPTS);
  assertEquals(records.length, 0);
  assertEquals(skipped[0].reason, 'invalid_coordinates');
});

Deno.test('transform — a missing origin time is skipped (occurred_at cannot be faked)', () => {
  const { records, skipped } = transformUsgsFeatures([feature('notime', [1, 1, 5], { time: null })], OPTS);
  assertEquals(records.length, 0);
  assertEquals(skipped[0].reason, 'missing_time');
});

Deno.test('transform — a finite but out-of-range epoch is skipped, never allowed to crash the batch', () => {
  // A corrupt/sentinel timestamp such as 1e20 is `Number.isFinite`, so it slipped
  // past the missing-time check — then `new Date(1e20).toISOString()` throws
  // "Invalid time value", turning ONE bad feature into a lost batch. That breaks
  // the module's contract: a per-feature problem SKIPS with a reason, it never
  // throws. A real quake in the same batch must still survive the bad neighbour.
  const good = feature('us-good', [1, 1, 5]);
  const bad = feature('us-bad', [2, 2, 5], { time: 1e20 });
  const negBad = feature('us-negbad', [3, 3, 5], { time: -1e20 });
  const { records, skipped } = transformUsgsFeatures([good, bad, negBad], OPTS);
  assertEquals(records.length, 1, 'the one valid quake survived');
  assertEquals(records[0].external_id, 'us-good');
  const badReasons = skipped.filter((s) => s.id === 'us-bad' || s.id === 'us-negbad');
  assertEquals(badReasons.length, 2);
  for (const s of badReasons) assertEquals(s.reason, 'missing_time');
});

Deno.test('transform — a non-earthquake type is recorded verbatim, not assumed', () => {
  const { records } = transformUsgsFeatures([feature('blast', [1, 1, 0], { type: 'quarry blast', magType: 'ml', mag: 1.8 })], OPTS);
  assertEquals(records[0].event_type, 'quarry blast');
});

Deno.test('transform — the empty feed transforms to zero records without error', () => {
  const { records, skipped } = transformUsgsFeatures([], OPTS);
  assertEquals(records.length, 0);
  assertEquals(skipped.length, 0);
});

// ---------------------------------------------------------------------------
// SNAPSHOT
// ---------------------------------------------------------------------------

Deno.test('snapshot — content hash is STABLE across identical runs, CHANGES on a data change', async () => {
  const { records } = transformUsgsFeatures([feature('us6000tlbz', [151.3834, 46.4341, 90.992])], OPTS);
  const a = await buildSnapshot(records, { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: '2026-08-17T12:00:00.000Z' });

  // SAME data, DIFFERENT wall-clock (generated_at AND each retrieved_at): the hash
  // addresses the content, so it must be identical — what makes it a usable content
  // change signal (a hash change = a DATA change, never a clock tick).
  const laterClock = records.map((r) => ({ ...r, retrieved_at: '2027-01-01T00:00:00.000Z' }));
  const b = await buildSnapshot(laterClock, { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: '2027-01-01T00:00:00.000Z' });
  assertEquals(a.content_hash, b.content_hash); // clock-independent
  assertEquals(a.content_hash.length, 64); // sha256 hex
  assertNotEquals(a.generated_at, b.generated_at); // the artifacts DO differ in metadata
  assertEquals(b.events[0].retrieved_at, '2027-01-01T00:00:00.000Z'); // retrieval time still travels

  const changed = records.map((r) => ({ ...r, magnitude: (r.magnitude ?? 0) + 0.1 }));
  const c = await buildSnapshot(changed, { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: '2026-08-17T12:00:00.000Z' });
  assertNotEquals(c.content_hash, a.content_hash); // a changed number changes the hash
});

Deno.test('snapshot — EVERY event carries its full vintage and its scale; none is bare', async () => {
  const { records } = transformUsgsFeatures(
    [feature('a', [1, 1, 10], { magType: 'mww', mag: 6.0 }), feature('b', [2, 2, 20], { magType: 'mb', mag: 4.7 })],
    OPTS,
  );
  const snap = await buildSnapshot(records, { feedKey: 'usgs_quakes', licenceKey: 'usgs_pd', generatedAt: 'now' });
  assertEquals(snap.event_count, 2);
  for (const e of snap.events) {
    assert(e.source.length > 0);
    assert(e.release_version.length > 0);
    assert(e.retrieved_at.length > 0);
    assert(e.occurred_at.length > 0);
    assert((e.magnitude_scale ?? '').length > 0); // the scale is preserved on every event
  }
  assertEquals(snap.release_versions, ['1787004086000']);
});

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

Deno.test('sql — event insert is append-only (ON CONFLICT DO NOTHING on the dedup key)', () => {
  const { records } = transformUsgsFeatures([feature('us6000tlbz', [151.3834, 46.4341, 90.992])], OPTS);
  const sql = buildEventInsert(records);
  assertStringIncludes(sql, 'insert into atlas.event');
  assertStringIncludes(sql, 'on conflict on constraint event_dedup do nothing');
  // geom is built server-side from lon/lat, fully qualified.
  assertStringIncludes(sql, 'public.ST_SetSRID(public.ST_MakePoint(151.3834, 46.4341), 4326)');
  assertStringIncludes(sql, "'us6000tlbz'");
  assertStringIncludes(sql, "'richter'");
  assertStringIncludes(sql, "'mb'"); // the true scale reaches the DB via magnitude_scale
});

Deno.test('sql — the insert NEVER names an attribution column (the trigger owns those)', () => {
  const { records } = transformUsgsFeatures([feature('x', [1, 1, 5])], OPTS);
  const sql = buildEventInsert(records);
  for (const col of ['attribution_level', 'pip_iso_a3', 'disputed_name', 'continent_m49', 'public_country_iso_a3']) {
    assertEquals(sql.includes(col), false, `insert must not set ${col} — it is server-computed`);
  }
});

Deno.test('sql — idempotent seeds and the two-clock heartbeat upsert are well-formed', () => {
  assertStringIncludes(buildLicenceSeed(), "('usgs_pd'");
  assertStringIncludes(buildLicenceSeed(), 'on conflict (licence_key) do nothing');
  assertStringIncludes(buildFeedSeed(), "('usgs_quakes'");
  assertStringIncludes(buildFeedSeed(), 'on conflict (feed_key) do nothing');
  const hb = buildHeartbeatUpsert({ feedKey: 'usgs_quakes', releaseToken: '1787004086000', rowCount: 24, now: '2026-08-17T12:00:00.000Z' });
  assertStringIncludes(hb, 'insert into atlas.feed_heartbeat');
  assertStringIncludes(hb, "'ok'");
  assertStringIncludes(hb, 'on conflict (feed_key) do update set');
});

Deno.test('sql — a genuinely new quake on a re-run lands as a NEW row (distinct natural key)', () => {
  const { records } = transformUsgsFeatures([feature('us6000tlbz', [151, 46, 90])], OPTS);
  const first = buildEventInsert(records);
  const second = buildEventInsert(records, { idSuffix: '-NEW' });
  assertStringIncludes(first, "'us6000tlbz'");
  assertStringIncludes(second, "'us6000tlbz-NEW'"); // distinct external_id => a new dedup key
});
