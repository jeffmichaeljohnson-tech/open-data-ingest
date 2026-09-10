/**
 * worship.mutants.test.ts — mutation-hardening tests for the pure OSM worship builder.
 *
 * Companion to worship.test.ts; no overlap. Each test names the DEFECT it prevents:
 * a corrupt PWT1 tile whose magic passes anyway, a base64/hex codec that silently
 * drops a byte, an artifact that loses its ODbL identity strings or its content hash,
 * a tile R2 key that mis-encodes its coordinates, and an index whose point tally or
 * ordering drifts. SECURITY.md items 3 and 4 (provenance carried, content hash stable
 * and moving) are the through-line.
 *
 * --allow-read only. No tautologies; every throw is paired with a positive control.
 */
import { assert, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import {
  base64ToBytes,
  buildIndexSnapshot,
  buildTileSnapshot,
  bytesToBase64,
  type DecodedPoint,
  decodePwt,
  encodePwt,
  INDEX_FEED_KEY,
  OVERVIEW_FEED_KEY,
  readPwtHeader,
  tileFeedKey,
  type WorshipIndexEntry,
} from './worship.ts';

const META = { generatedAt: '2026-08-17T12:00:00.000Z', releaseVersion: '2026-08-17', retrievedAt: '2026-08-17T01:51:51.737Z' };

/** 8 deterministic points inside the (0,50) 10° cell — the fixture the goldens pin. */
function sampleTileBytes(): Uint8Array {
  const pts: DecodedPoint[] = [];
  for (let i = 0; i < 8; i++) pts.push({ lon: (i / 8) * 10, lat: 50 + (i / 8) * 10, religion: i % 8 });
  return encodePwt(pts, { minLon: 0, minLat: 50, spanLon: 10, spanLat: 10 });
}

/** Fixed index entries, deliberately out of feed_key order and mixing layers. */
function indexEntries(): WorshipIndexEntry[] {
  return [
    { feed_key: 'osm_worship_tile_b', layer: 'detail', content_hash: 'hb', point_count: 3, bytes: 10, tile: { lon: 10, lat: 50 } },
    { feed_key: 'osm_worship_tile_a', layer: 'detail', content_hash: 'ha', point_count: 2, bytes: 20, tile: { lon: 0, lat: 50 } },
    { feed_key: OVERVIEW_FEED_KEY, layer: 'overview', content_hash: 'hov', point_count: 100, bytes: 5 },
  ];
}

// ===========================================================================
// PWT1 MAGIC — L98. Each of the four magic bytes must be checked; corrupting any
// one alone must still be refused, or a foreign/corrupt tile would decode as points.
// ===========================================================================

Deno.test('readPwtHeader: corrupting ANY single magic byte is refused — L98 four-way guard', () => {
  // Mutants disable individual clauses of `bytes[0]!==0x50 || …[1]!==0x57 || …[2]!==0x54
  // || …[3]!==0x31`. worship.test.ts only flips byte[0]; here each of the other three is
  // flipped alone and must still throw 'bad magic'.
  for (const idx of [0, 1, 2, 3]) {
    const bad = sampleTileBytes();
    bad[idx] = 0x00;
    assertThrows(() => readPwtHeader(bad), Error, 'bad magic', `corrupting magic byte ${idx} must be refused`);
  }
  // positive control: the untouched tile reads its real point count.
  assertEquals(readPwtHeader(sampleTileBytes()).count, 8);
});

// ===========================================================================
// BASE64 / HEX CODECS — a dropped byte or an unpadded hex nibble is a silent
// corruption of the very data the ODbL block is protecting.
// ===========================================================================

Deno.test('base64 roundtrip preserves EVERY byte, including a leading zero and a high byte', () => {
  // A byte value < 16 hex-encodes to one nibble; a codec bug there would silently drop a
  // point coordinate. This pins the base64 bridge over the full 0x00-0xFF range.
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  assertEquals([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
});

// ===========================================================================
// tileFeedKey — L275. Coordinate sign encoding: 0 is positive, negatives get 'n'.
// ===========================================================================

Deno.test('tileFeedKey: zero and positive coords are bare; only negatives get the "n" prefix — L275', () => {
  // Mutant `v < 0` → `v <= 0` (or the conditional → true) would prefix a zero/positive
  // coordinate with 'n', producing the WRONG immutable R2 key. worship.test.ts covers
  // the negative case; this pins the zero boundary and the positive case.
  assertEquals(tileFeedKey(0, 50), 'osm_worship_tile_0_50');
  assertEquals(tileFeedKey(20, 30), 'osm_worship_tile_20_30');
  assertEquals(tileFeedKey(-10, 0), 'osm_worship_tile_n10_0'); // lat 0 stays bare, lon -10 gets n
});

// ===========================================================================
// buildTileSnapshot — identity strings, vintage array, bbox/tile objects, hash.
// ===========================================================================

Deno.test('buildTileSnapshot: identity, attribution and vintage are all present — L298/L302/L303/L305', async () => {
  // Mutants blank the schema_version/source/attribution strings or empty the
  // release_versions array. Every OSM artifact must carry its ODbL identity + vintage.
  const snap = await buildTileSnapshot(sampleTileBytes(), tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  assertEquals(snap.schema_version, 'atlas.worship.v1');
  assertEquals(snap.source, 'OpenStreetMap via Overpass API');
  assertEquals(snap.attribution, '© OpenStreetMap contributors');
  assertEquals(snap.release_versions, ['2026-08-17']);
  assertEquals(snap.point_count, 8);
});

Deno.test('buildTileSnapshot: bbox carries the header extent, and the tile origin only for a detail tile — L309/L310', async () => {
  // Mutant L309 bbox → {} would drop the tile's geographic extent; L310 `...(tile ? {tile} : {})`
  // → {} would drop the detail tile's own cell origin. An overview carries NO tile origin.
  const detail = await buildTileSnapshot(sampleTileBytes(), tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  assertEquals(detail.bbox, { minLon: 0, minLat: 50, spanLon: 10, spanLat: 10 });
  assertEquals(detail.tile, { lon: 0, lat: 50, tileDeg: 10 });
  const overview = await buildTileSnapshot(sampleTileBytes(), OVERVIEW_FEED_KEY, 'overview', META);
  assertEquals(overview.tile, undefined); // no tile origin on the whole-globe overview
});

Deno.test('buildTileSnapshot: content hash is a stable golden and is 64 hex chars — L194-L203 sha256HexBytes', async () => {
  // Golden from the unmutated builder over the fixed tile. It moves under any codec
  // mutation. The 64-length assertion additionally refutes L201 `.padStart(2, '0')` → '',
  // because this hash contains a byte < 16 (the '0a' pair) that would lose its pad.
  const snap = await buildTileSnapshot(sampleTileBytes(), tileFeedKey(0, 50), 'detail', META, { lon: 0, lat: 50, tileDeg: 10 });
  assertEquals(snap.content_hash, 'f30a4a85fc8bacc573713f61031547f48eabbdd009bfa917056e014954878a01');
  assertEquals(snap.content_hash.length, 64);
});

// ===========================================================================
// buildIndexSnapshot — sort, the detail-only point tally, identity, and hash.
// ===========================================================================

Deno.test('buildIndexSnapshot: entries are sorted by feed_key — L328 sort', async () => {
  // Mutant L328 `[...entries].sort(...)` → `[...entries]` (or the arrow → undefined, or
  // the array → []) would leave the index in arbitrary order, so its content hash would
  // depend on input order. Entries fed b-before-a must come back a-before-b.
  const index = await buildIndexSnapshot(indexEntries(), { tileDeg: 10, overviewCellDeg: 0.5, taginfoTotal: 1615357 }, META);
  assertEquals(index.entries.map((e) => e.feed_key), ['osm_worship_overview', 'osm_worship_tile_a', 'osm_worship_tile_b']);
});

Deno.test('buildIndexSnapshot: total_points sums ONLY the detail tiles — L329', async () => {
  // One case pins the whole L329 chain: the `.filter(e => e.layer === 'detail')` (its
  // MethodExpression, equality, and 'detail' literal) and the `.reduce((n,e) => n + e.point_count, 0)`
  // (its arrow and `+`). The overview's 100 points must NOT be counted; only 2 + 3 = 5.
  const index = await buildIndexSnapshot(indexEntries(), { tileDeg: 10, overviewCellDeg: 0.5, taginfoTotal: 1615357 }, META);
  assertEquals(index.total_points, 5);
});

Deno.test('buildIndexSnapshot: identity, layer, attribution, vintage and taginfo are present — L338/L342/L343/L345/L346', async () => {
  const index = await buildIndexSnapshot(indexEntries(), { tileDeg: 10, overviewCellDeg: 0.5, taginfoTotal: 1615357 }, META);
  assertEquals(index.schema_version, 'atlas.worship-index.v1');
  assertEquals(index.feed_key, INDEX_FEED_KEY);
  assertEquals(index.layer, 'index');
  assertEquals(index.source, 'OpenStreetMap via Overpass API');
  assertEquals(index.attribution, '© OpenStreetMap contributors');
  assertEquals(index.release_versions, ['2026-08-17']);
  assertEquals(index.taginfo_total, 1615357);
});

Deno.test('buildIndexSnapshot: content hash is a stable golden — pins canonicalJson (L356-L360) + hash core (L330/L331/L334)', async () => {
  // Golden from the unmutated builder over the fixed entries. It moves under any change
  // to the index's canonical serialisation, to its hash-core object shape/strings, or to
  // the entries-projection arrow. The hash is over the SORTED entries, so it is stable
  // across input order; a changed entry moves it (asserted below).
  const index = await buildIndexSnapshot(indexEntries(), { tileDeg: 10, overviewCellDeg: 0.5, taginfoTotal: 1615357 }, META);
  assertEquals(index.content_hash, '441f9d167f0af4fcabd195698cd93777cd123bb43edfce841ded671dda29cf63');
  assertEquals(index.content_hash.length, 64);

  // moves when an entry's content_hash moves (the index tracks the tile set)…
  const changed = indexEntries();
  changed[0].content_hash = 'DIFFERENT';
  const movedHash = await buildIndexSnapshot(changed, { tileDeg: 10, overviewCellDeg: 0.5, taginfoTotal: 1615357 }, META);
  assertNotEquals(movedHash.content_hash, index.content_hash);

  // …and is STABLE when only the input order changes (proves the sort feeds the hash).
  const reordered = [indexEntries()[2], indexEntries()[0], indexEntries()[1]];
  const reHash = await buildIndexSnapshot(reordered, { tileDeg: 10, overviewCellDeg: 0.5, taginfoTotal: 1615357 }, META);
  assertEquals(reHash.content_hash, index.content_hash);
});

// ===========================================================================
// EQUIVALENT MUTANTS — recorded, not tested (a test for them could only be a
// tautology). See the file-level report for the full reasoning:
//   • L139 clamp `v < 0` → `v <= 0` and `v > 65535` → `v >= 65535`: at the exact
//     bound, Math.round(bound) already equals the clamped bound, so both forms
//     return the identical value. No input distinguishes them.
//   • L180 bytesToBase64 `i < bytes.length` → `i <= bytes.length`: the extra
//     iteration reads an empty subarray, String.fromCharCode() === '', so the
//     accumulated string is unchanged.
//   • L189 base64ToBytes `i < bin.length` → `i <= bin.length`: out[bin.length] is
//     an out-of-range TypedArray write (silently ignored) of charCodeAt(len)=NaN,
//     so the output bytes are unchanged.
// A decode-side length backstop already exists (readPwtHeader length check), so the
// codec round-trip is proven exact by the base64/roundtrip tests above.
// ===========================================================================
Deno.test('codec roundtrip is exact for a tile whose points sit ON the cell edges (documents the L139 clamp is not lossy at the bound)', () => {
  // Points exactly on min and max edges quantise to 0 and 65535 respectively; decoding
  // returns the edges within the documented tolerance. This is the positive control that
  // the clamp boundary behaviour (whose `<`/`>` mutants are equivalent) is nonetheless
  // correct — it is NOT an attempt to kill an equivalent mutant.
  const tile = { minLon: 0, minLat: 0, spanLon: 10, spanLat: 10 };
  const decoded = decodePwt(encodePwt([{ lon: 0, lat: 0, religion: 0 }, { lon: 10, lat: 10, religion: 1 }], tile));
  assert(Math.abs(decoded[0].lon - 0) < 1e-6);
  assert(Math.abs(decoded[1].lon - 10) < 1e-6);
  assert(Math.abs(decoded[1].lat - 10) < 1e-6);
});
