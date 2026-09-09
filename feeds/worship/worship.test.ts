/**
 * worship.test.ts — offline proof of the OSM worship snapshot builder AND of the
 * derivative_database licence path it exercises for the first time.
 *
 * Run with `deno test --allow-read` from this directory. Every test is fixture-driven
 * — no network, no R2, no disk (the one `--allow-read` test reads a committed tile off
 * the repo to prove the codec on REAL bytes, and is skipped if that asset is absent).
 *
 * The licence tests import the REAL planPublish and LICENCE_REGISTER from
 * `_atlas-publish` (read-only) so the guard is proven on the artifact this builder
 * actually produces — not re-asserted against a hand-made block. A guard that has only
 * ever been shown to PASS is not yet a guard, so every accept here is paired with a
 * falsifying reject: strip one ODbL field and the SAME artifact must be refused.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
  assertStringIncludes,
  assertAlmostEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  planPublish,
  LICENCE_REGISTER,
  type LicenceDescriptor,
} from '../../publish/snapshotPublish.ts';
import {
  encodePwt,
  decodePwt,
  readPwtHeader,
  bytesToBase64,
  base64ToBytes,
  buildTileSnapshot,
  buildIndexSnapshot,
  tileFeedKey,
  OVERVIEW_FEED_KEY,
  INDEX_FEED_KEY,
  WORSHIP_LICENCE_KEY,
  type WorshipTileSnapshot,
  type WorshipIndexEntry,
  type DecodedPoint,
} from './worship.ts';

// --- fixtures ---------------------------------------------------------------

const META = {
  generatedAt: '2026-08-17T12:00:00.000Z',
  releaseVersion: '2026-08-17',
  retrievedAt: '2026-08-17T01:51:51.737Z',
};

/** A deterministic detail tile: a spread of points inside the 10° cell at (0,50). */
function sampleTileBytes(n = 32): Uint8Array {
  const pts: DecodedPoint[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({ lon: 0 + (i / n) * 10, lat: 50 + ((i * 7) % n) / n * 10, religion: i % 8 });
  }
  return encodePwt(pts, { minLon: 0, minLat: 50, spanLon: 10, spanLat: 10 });
}

/** The ODbL descriptor the real register carries — the one every worship artifact uses. */
const ODBL: LicenceDescriptor = LICENCE_REGISTER[WORSHIP_LICENCE_KEY];

// ===========================================================================
// (1) THE PWT1 CODEC — the wire format this builder wraps must roundtrip, or the
//     bytes we base64 into a licensed artifact are not the points we claim.
// ===========================================================================
Deno.test('PWT1 encode → decode roundtrips within the 10° quantisation step', () => {
  const pts: DecodedPoint[] = [
    { lon: 3.4, lat: 6.5, religion: 1 },
    { lon: -0.12, lat: 51.5, religion: 5 },
    { lon: 9.999, lat: 59.999, religion: 7 },
  ];
  const bytes = encodePwt(pts, { minLon: -10, minLat: 0, spanLon: 20, spanLat: 60 });
  const back = decodePwt(bytes);
  assertEquals(back.length, pts.length);
  for (let i = 0; i < pts.length; i++) {
    // 20°/65535 ≈ 3e-4° lon, 60°/65535 ≈ 9e-4° lat — comfortably finer than 1e-2.
    assertAlmostEquals(back[i].lon, pts[i].lon, 1e-2);
    assertAlmostEquals(back[i].lat, pts[i].lat, 1e-2);
    assertEquals(back[i].religion, pts[i].religion);
  }
});

Deno.test('readPwtHeader rejects bad magic and a truncated body — a malformed tile never publishes', () => {
  const good = sampleTileBytes(4);
  const header = readPwtHeader(good);
  assertEquals(header.count, 4);

  const badMagic = good.slice();
  badMagic[0] = 0x00;
  assertThrows(() => readPwtHeader(badMagic), Error, 'bad magic');

  const truncated = good.slice(0, good.length - 1);
  assertThrows(() => readPwtHeader(truncated), Error, 'does not match header count');
});

Deno.test('base64 roundtrips arbitrary bytes exactly (incl. high bytes)', () => {
  const bytes = new Uint8Array([0, 1, 2, 80, 87, 84, 49, 200, 255, 128, 65535 & 0xff]);
  assertEquals([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
});

// ===========================================================================
// (2) THE DERIVATIVE-DATABASE LICENCE PATH — the guard that had never fired.
//     ACCEPT the correct artifact; then FALSIFY: strip each ODbL field and prove
//     the SAME artifact is refused.
// ===========================================================================
Deno.test('a worship tile artifact carries ODbL, attribution, licence URL and the §4.6 notice', async () => {
  const snap = await buildTileSnapshot(sampleTileBytes(), tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  const plan = planPublish(snap, { clock: 'geometry', licence: ODBL, sourceChangedAt: META.releaseVersion });
  const artifact = JSON.parse(plan.objects.find((o) => o.kind === 'artifact')!.body);

  assertEquals(artifact.licence.spdx, 'ODbL-1.0');
  assertEquals(artifact.licence.is_reusable_database, true); // it IS the data, re-usable
  assertStringIncludes(artifact.licence.attribution, 'OpenStreetMap contributors');
  assertStringIncludes(artifact.licence.licence_url, 'odbl');
  assert(typeof artifact.licence.data_availability === 'string' && artifact.licence.data_availability.length > 0);
  // and the payload the licence is protecting is actually present and decodable
  assertEquals(artifact.points_encoding, 'PWT1+base64');
  assertEquals(decodePwt(base64ToBytes(artifact.pwt_base64)).length, artifact.point_count);
});

Deno.test('FALSIFY: the SAME tile artifact is REFUSED when any one ODbL field is removed', async () => {
  const snap = await buildTileSnapshot(sampleTileBytes(), tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  const plan = () => (deficient: LicenceDescriptor) =>
    planPublish(snap, { clock: 'geometry', licence: deficient, sourceChangedAt: META.releaseVersion });
  const attempt = plan();

  // missing the licence URL
  assertThrows(() => attempt({ ...ODBL, licenceUrl: undefined }), Error, 'licence URL');
  // missing the §4.6 data-availability notice
  assertThrows(() => attempt({ ...ODBL, dataAvailabilityNotice: undefined }), Error, 'data-availability notice');
  // downgraded to a non-database licence (CC-BY on a re-usable database)
  assertThrows(() => attempt({ ...ODBL, spdx: 'CC-BY-4.0' }), Error, 'database/share-alike licence');
  // attribution stripped
  assertThrows(() => attempt({ ...ODBL, attribution: '' }), Error, 'attribution');

  // control: the UNMODIFIED descriptor still succeeds, so the rejections above are the
  // stripped field talking, not a broken snapshot.
  assert(attempt(ODBL).objects.length === 2);
});

Deno.test('EVERY artifact class carries the ODbL block — overview and index too, not just the tiles', async () => {
  const tileBytes = sampleTileBytes();
  const tile = await buildTileSnapshot(tileBytes, tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  const overview = await buildTileSnapshot(sampleTileBytes(8), OVERVIEW_FEED_KEY, 'overview', META);
  const entries: WorshipIndexEntry[] = [
    { feed_key: tile.feed_key, layer: 'detail', content_hash: tile.content_hash, point_count: tile.point_count, bytes: 1, tile: { lon: 0, lat: 50 } },
    { feed_key: overview.feed_key, layer: 'overview', content_hash: overview.content_hash, point_count: overview.point_count, bytes: 1 },
  ];
  const index = await buildIndexSnapshot(entries, { tileDeg: 10, overviewCellDeg: 0.5, taginfoTotal: 1615357 }, META);

  for (const snap of [tile, overview, index]) {
    const artifact = JSON.parse(
      planPublish(snap, { clock: 'geometry', licence: ODBL, sourceChangedAt: META.releaseVersion }).objects.find((o) => o.kind === 'artifact')!.body,
    );
    assertEquals(artifact.licence.spdx, 'ODbL-1.0', `${snap.feed_key} must carry ODbL`);
    assertEquals(artifact.licence.is_reusable_database, true, `${snap.feed_key} is re-usable data`);
    assertStringIncludes(artifact.licence.attribution, 'OpenStreetMap contributors');
    assert(artifact.licence.data_availability.length > 0, `${snap.feed_key} must carry the §4.6 notice`);
  }
});

// ===========================================================================
// (3) CONTENT ADDRESSING — same data ⇒ same key; changed data ⇒ different key.
// ===========================================================================
Deno.test('identical tile bytes at different wall-clock times land at the SAME immutable key', async () => {
  const bytes = sampleTileBytes();
  const a = await buildTileSnapshot(bytes, tileFeedKey(0, 50), 'detail', { ...META, generatedAt: '2026-08-17T00:00:00.000Z' }, { lon: 0, lat: 50, tileDeg: 10 });
  const b = await buildTileSnapshot(bytes, tileFeedKey(0, 50), 'detail', { ...META, generatedAt: '2026-09-01T09:30:00.000Z' }, { lon: 0, lat: 50, tileDeg: 10 });
  assertEquals(a.content_hash, b.content_hash);
  const ka = planPublish(a, { clock: 'geometry', licence: ODBL, sourceChangedAt: META.releaseVersion }).objects.find((o) => o.kind === 'artifact')!.key;
  const kb = planPublish(b, { clock: 'geometry', licence: ODBL, sourceChangedAt: META.releaseVersion }).objects.find((o) => o.kind === 'artifact')!.key;
  assertEquals(ka, kb);
  assertStringIncludes(ka, `atlas/geometry/${tileFeedKey(0, 50)}/${a.content_hash}.json`);
});

Deno.test('a changed point moves the tile to a DIFFERENT immutable key', async () => {
  const a = await buildTileSnapshot(sampleTileBytes(32), tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  const b = await buildTileSnapshot(sampleTileBytes(33), tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  assertNotEquals(a.content_hash, b.content_hash);
});

Deno.test('each detail tile gets its OWN R2 key; negatives are encoded, never a bare minus in the path segment', async () => {
  const west = await buildTileSnapshot(encodePwt([{ lon: -75, lat: -25, religion: 0 }], { minLon: -80, minLat: -30, spanLon: 10, spanLat: 10 }), tileFeedKey(-80, -30), 'detail', META, { lon: -80, lat: -30, tileDeg: 10 });
  assertEquals(west.feed_key, 'osm_worship_tile_n80_n30');  // gitleaks:allow -- a tile name derived from coordinates, not a credential
  const key = planPublish(west, { clock: 'geometry', licence: ODBL, sourceChangedAt: META.releaseVersion }).objects.find((o) => o.kind === 'artifact')!.key;
  assertStringIncludes(key, 'atlas/geometry/osm_worship_tile_n80_n30/');
  assert(!key.includes('-'), 'no bare minus should reach the R2 key');
});

// ===========================================================================
// (4) SIZE — the reason this is tiled. The compact artifact must be far smaller than
//     the naive-object JSON the brief warned about, and no single fetched tile large.
// ===========================================================================
Deno.test('base64(PWT1) is dramatically smaller than a naive {lat,lon,religion} JSON of the same points', async () => {
  const n = 5000;
  const pts: DecodedPoint[] = [];
  for (let i = 0; i < n; i++) pts.push({ lon: (i % 1000) / 100, lat: 50 + (i % 1000) / 100, religion: i % 8 });
  const bytes = encodePwt(pts, { minLon: 0, minLat: 50, spanLon: 10, spanLat: 10 });
  const snap = await buildTileSnapshot(bytes, tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  const artifactBytes = planPublish(snap, { clock: 'geometry', licence: ODBL, sourceChangedAt: META.releaseVersion }).objects.find((o) => o.kind === 'artifact')!.bytes;

  const naive = JSON.stringify({ points: pts.map((p) => ({ lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), religion: p.religion })) }).length;
  // base64 tile (payload + licence block + metadata) must beat naive objects by a wide
  // margin — measured ~6.7 B/pt vs ~44 B/pt, so at least 4× smaller even with overhead.
  assert(artifactBytes * 4 < naive, `expected the base64 tile (${artifactBytes} B) to be >4× smaller than naive JSON (${naive} B)`);
});

// ===========================================================================
// (5) END TO END — encode real bytes, wrap them, and prove the artifact decodes
//     back to exactly what went in.
//
//     This used to read a committed tile from `apps/web/public/`, three levels
//     above this repository, inside a try/catch that returned on failure. The
//     path can never resolve here, so the catch always ran and Deno reported the
//     test as PASSING — a test counted in the suite total that asserted nothing.
//     The comment said "skipped (not failed)"; Deno has no skip for that shape,
//     and the intent did not survive contact with the mechanism.
//
//     Encoding the bytes here is strictly better: it exercises the same
//     round-trip, it cannot silently degrade, and it needs no file on disk.
// ===========================================================================
Deno.test('a real encoded tile wraps into a valid, decodable ODbL artifact', async () => {
  const points = [
    { lon: -0.1276, lat: 51.5074, religion: 0 },
    { lon: 2.3522, lat: 48.8566, religion: 1 },
    { lon: 13.405, lat: 52.52, religion: 2 },
    { lon: -74.006, lat: 40.7128, religion: 0 },
  ];
  const bytes = encodePwt(points, { minLon: -180, minLat: -90, spanLon: 360, spanLat: 180 });

  const snap = await buildTileSnapshot(bytes, OVERVIEW_FEED_KEY, 'overview', META);
  const artifact = JSON.parse(
    planPublish(snap, { clock: 'geometry', licence: ODBL, sourceChangedAt: META.releaseVersion })
      .objects.find((o) => o.kind === 'artifact')!.body,
  );

  assertEquals(artifact.licence.spdx, 'ODbL-1.0');
  assertEquals(artifact.licence.is_reusable_database, true);
  assertStringIncludes(artifact.licence.attribution, 'OpenStreetMap');

  const decoded = decodePwt(base64ToBytes(artifact.pwt_base64));
  assertEquals(decoded.length, artifact.point_count);
  assertEquals(decoded.length, points.length);

  // Quantisation is lossy by design, so assert the documented tolerance rather
  // than equality. A silently wrong codec would fail here.
  for (let i = 0; i < points.length; i++) {
    assert(Math.abs(decoded[i].lon - points[i].lon) < 0.01, `lon drifted at ${i}`);
    assert(Math.abs(decoded[i].lat - points[i].lat) < 0.01, `lat drifted at ${i}`);
    assertEquals(decoded[i].religion, points[i].religion);
  }
});

Deno.test('a coordinate outside the tile is clamped to the edge, never wrapped', () => {
  // Found by mutation: removing the clamp left the suite green, and a range
  // assertion was too weak to catch it — setUint16 truncates, so a wrapped
  // value still lands INSIDE the tile, just at the wrong place. Measured with
  // the clamp removed: lon -50 decoded to 0.0008 and lon 500 to 9.9925 instead
  // of the exact edges. So the assertion has to be exactness, not range.
  const tile = { minLon: 0, minLat: 0, spanLon: 10, spanLat: 10 };
  const decoded = decodePwt(encodePwt([
    { lon: -50, lat: -50, religion: 0 },
    { lon: 500, lat: 500, religion: 1 },
  ], tile));

  assertAlmostEquals(decoded[0].lon, 0, 1e-9, 'a point west of the tile did not clamp to the west edge');
  assertAlmostEquals(decoded[0].lat, 0, 1e-9, 'a point south of the tile did not clamp to the south edge');
  assertAlmostEquals(decoded[1].lon, 10, 1e-9, 'a point east of the tile did not clamp to the east edge');
  assertAlmostEquals(decoded[1].lat, 10, 1e-9, 'a point north of the tile did not clamp to the north edge');
});
