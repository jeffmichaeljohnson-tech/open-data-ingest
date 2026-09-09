/**
 * worship.ts — the PURE core of the OSM place-of-worship snapshot builder.
 *
 * This is the "no I/O" half (build.ts is the thin Deno shell that reads the encoded
 * tiles off disk and prints the publish plan). Everything here — reading a PWT1
 * tile header, base64-wrapping its exact bytes, content-addressing it, and shaping
 * a PublishableSnapshot the atlas planner will stamp with ODbL — is testable with NO
 * network and NO filesystem.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FEED EXISTS SEPARATELY FROM atlas-ingest-worldbank
 * ────────────────────────────────────────────────────────────────────────────
 * World Bank is `aggregate_statistics` — a picture of numbers. The worship points
 * are the OTHER class that `LICENCE_REGISTER` in publish/snapshotPublish.ts
 * draws: a snapshot of the OSM worship points is the DATA in re-usable form —
 * coordinates you can extract — so on the OSMF's own definition it is a DERIVATIVE
 * DATABASE, and ODbL makes the labelling a CONDITION, not a courtesy: every file that
 * carries the coordinates must carry the ODbL licence, the "© OpenStreetMap
 * contributors" attribution, and the §4.6 data-availability statement.
 *
 * `../../publish/snapshotPublish.ts` already implements that distinction and THROWS
 * on a mislabel — but nothing had ever exercised the derivative_database path. This
 * module is what fires it: it builds the worship snapshot and hands it to the SAME
 * planPublish, so the guard that was only ever proven on a fixture now runs on the
 * real artifact the globe renders.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY TILED, AND WHY base64(PWT1) RATHER THAN A JSON POINT ARRAY
 * ────────────────────────────────────────────────────────────────────────────
 * Measured on the shipped dataset (107,903 points), NOT estimated:
 *   • one JSON artifact of `{lat,lon,religion}` objects  → 43.8 B/pt → ~67 MB at the
 *     full 1.6M points. Unfetchable on page load. This is the representation the brief
 *     warned about, and the measurement confirms it.
 *   • PWT1 (the globe's proven wire format: 5 B/pt, uint16-quantised within the tile
 *     bbox ≈ 17 m at a 10° tile) → 7.7 MB at full scale.
 *   • base64(PWT1) embedded in the JSON snapshot → 6.67 B/pt (~10.3 MB at full).
 *   • quantised int arrays as JSON → 13.23 B/pt — TWICE base64's cost, and it throws
 *     away the format the client already decodes.
 *
 * So the payload is the EXACT PWT1 bytes the globe already fetches, base64-wrapped so
 * the ODbL block travels in the SAME file (the whole requirement — the licence must
 * be attached to every artifact a client could fetch, never sitting only on an index
 * while the tiles ship bare). The +33% base64 overhead buys keeping licence and data
 * inseparable, and no single fetched artifact is large: the always-loaded overview is
 * ~2 KB, and the peak page-load fetch is overview + the few detail tiles under the
 * camera, never the planet. LOD by zoom is inherited from the tile pyramid, not
 * re-invented here.
 *
 * Deno-native: Web Crypto (`crypto.subtle`), `TextEncoder`, `btoa`/`atob`. No Node
 * imports, no external modules — the same house pattern as worldbank.ts.
 */

import type { PublishableSnapshot } from '../../publish/snapshotPublish.ts';

// ===========================================================================
// THE LICENCE KEY — the one register row this feed publishes under.
// ===========================================================================

/**
 * The feed_key whose descriptor in the publish layer's LICENCE_REGISTER is the ODbL
 * `derivative_database` row. EVERY worship artifact — index, overview and each detail
 * tile — is planned with THIS descriptor, so the ODbL obligation is attached to every
 * fetchable file, not just the index. The per-tile snapshot's own `feed_key` differs
 * (it names the tile, for a distinct R2 key), so the publish CLI is pointed at this
 * licence explicitly via `--feed osm_worship_points`.
 */
export const WORSHIP_LICENCE_KEY = 'osm_worship_points';

// ===========================================================================
// PWT1 — the on-the-wire tile format (mirrors apps/web/src/globe/pwt.ts).
// Re-declared here (not imported) because that module lives under apps/web/src,
// is owned by the globe lane, and pulls in three/React types; the wire contract is
// tiny and a roundtrip test guards this copy against drift.
//   [0]  4 bytes  magic 'P''W''T''1'
//   [4]  uint32   count            (little-endian)
//   [8]  float32  minLon   [12] float32 minLat
//   [16] float32  spanLon  [20] float32 spanLat
//   [24] body     count × { uint16 lonQ, uint16 latQ, uint8 religion }
// ===========================================================================

const PWT_HEADER_BYTES = 24;
const PWT_POINT_BYTES = 5;

/** The header fields of a PWT1 tile — enough to describe the tile without decoding every point. */
export interface PwtHeader {
  count: number;
  minLon: number;
  minLat: number;
  spanLon: number;
  spanLat: number;
}

/** Read (and validate) a PWT1 header. Throws on bad magic or a truncated body. */
export function readPwtHeader(bytes: Uint8Array): PwtHeader {
  if (bytes.length < PWT_HEADER_BYTES) throw new Error('pwt: buffer shorter than the 24-byte header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Magic is written big-endian-visually as the ASCII 'PWT1'.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x57 || bytes[2] !== 0x54 || bytes[3] !== 0x31) {
    throw new Error('pwt: bad magic (expected PWT1)');
  }
  const count = dv.getUint32(4, true);
  const expected = PWT_HEADER_BYTES + count * PWT_POINT_BYTES;
  if (bytes.length !== expected) {
    throw new Error(`pwt: body length ${bytes.length} does not match header count ${count} (expected ${expected})`);
  }
  return {
    count,
    minLon: dv.getFloat32(8, true),
    minLat: dv.getFloat32(12, true),
    spanLon: dv.getFloat32(16, true),
    spanLat: dv.getFloat32(20, true),
  };
}

/** A decoded PWT1 point (dequantised). Used by the roundtrip test, not the publish path. */
export interface DecodedPoint {
  lat: number;
  lon: number;
  religion: number;
}

/** Encode points into a PWT1 tile. Present so the roundtrip test can prove the codec offline. */
export function encodePwt(points: DecodedPoint[], h: Omit<PwtHeader, 'count'>): Uint8Array {
  const n = points.length;
  const bytes = new Uint8Array(PWT_HEADER_BYTES + n * PWT_POINT_BYTES);
  const dv = new DataView(bytes.buffer);
  bytes[0] = 0x50;
  bytes[1] = 0x57;
  bytes[2] = 0x54;
  bytes[3] = 0x31;
  dv.setUint32(4, n, true);
  dv.setFloat32(8, h.minLon, true);
  dv.setFloat32(12, h.minLat, true);
  dv.setFloat32(16, h.spanLon, true);
  dv.setFloat32(20, h.spanLat, true);
  let o = PWT_HEADER_BYTES;
  for (const p of points) {
    // clamp exactly as encode.mjs does — a point on the tile's far edge quantises to 65535, not overflow
    const clamp = (v: number) => (v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v));
    const lq = clamp(((p.lon - h.minLon) / h.spanLon) * 65535);
    const tq = clamp(((p.lat - h.minLat) / h.spanLat) * 65535);
    dv.setUint16(o, lq, true);
    dv.setUint16(o + 2, tq, true);
    bytes[o + 4] = p.religion & 0xff;
    o += PWT_POINT_BYTES;
  }
  return bytes;
}

/** Decode a PWT1 tile back into dequantised points. Inverse of {@link encodePwt}. */
export function decodePwt(bytes: Uint8Array): DecodedPoint[] {
  const h = readPwtHeader(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: DecodedPoint[] = [];
  let o = PWT_HEADER_BYTES;
  for (let i = 0; i < h.count; i++) {
    const lq = dv.getUint16(o, true);
    const tq = dv.getUint16(o + 2, true);
    const religion = dv.getUint8(o + 4);
    out.push({
      lon: h.minLon + (lq / 65535) * h.spanLon,
      lat: h.minLat + (tq / 65535) * h.spanLat,
      religion,
    });
    o += PWT_POINT_BYTES;
  }
  return out;
}

// ===========================================================================
// BASE64 — bytes ⇄ ascii, so the binary tile rides inside the JSON snapshot next
// to its licence block. btoa/atob are latin1-only, so we bridge through a binary
// string in bounded chunks (a 100k-point tile is ~500 KB — well within a call, but
// chunking keeps the argument spread off the stack for the largest tiles).
// ===========================================================================

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** sha256 hex of raw bytes — the natural content address for a binary tile. */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh, definitely-ArrayBuffer-backed view: Deno's lib types reject a
  // Uint8Array whose backing buffer is only ArrayBufferLike (it could be Shared).
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ===========================================================================
// THE SNAPSHOTS — one per fetchable artifact, each a PublishableSnapshot the atlas
// planner stamps with the ODbL derivative_database licence.
// ===========================================================================

/**
 * Metadata shared by every worship artifact in a build. `retrievedAt`/`generatedAt`
 * are wall-clock and stay OUT of the content hash (the hash is over the tile bytes),
 * so re-encoding identical OSM data at a different time lands at the SAME immutable
 * key — exactly the property worldbank.ts's builder guarantees for aggregates.
 */
export interface WorshipBuildMeta {
  /** ISO-8601 instant this snapshot was built (wall clock). */
  generatedAt: string;
  /** the source release token — OSM has no page-level date, so we use the harvest date. */
  releaseVersion: string;
  /** ISO-8601 instant the OSM data was harvested. */
  retrievedAt: string;
}

/**
 * A worship snapshot ready for planPublish. It structurally satisfies
 * PublishableSnapshot (schema_version, feed_key, content_hash, generated_at,
 * release_versions) and adds the licensed payload, which planPublish spreads into the
 * artifact body untouched. `license_key` names the register row; the full ODbL block
 * the file must carry is added by the planner from that row.
 */
export interface WorshipSnapshot extends PublishableSnapshot {
  source: string;
  license_key: string;
  attribution: string;
  /** what kind of worship artifact this is — the client reads `index` first. */
  layer: 'index' | 'overview' | 'detail';
}

/** A single tile (overview or detail) with its base64 PWT1 payload. */
export interface WorshipTileSnapshot extends WorshipSnapshot {
  layer: 'overview' | 'detail';
  points_encoding: 'PWT1+base64';
  point_count: number;
  bbox: { minLon: number; minLat: number; spanLon: number; spanLat: number };
  /** for a detail tile, its 10° cell origin; absent on the overview (whole-globe). */
  tile?: { lon: number; lat: number; tileDeg: number };
  pwt_base64: string;
}

/** One row of the index: how to reach a tile artifact and how big it is. */
export interface WorshipIndexEntry {
  feed_key: string;
  layer: 'overview' | 'detail';
  content_hash: string;
  point_count: number;
  bytes: number;
  tile?: { lon: number; lat: number };
}

/** The index artifact — a small map of the whole database, itself ODbL-labelled. */
export interface WorshipIndexSnapshot extends WorshipSnapshot {
  layer: 'index';
  tile_deg: number;
  overview_cell_deg: number;
  total_points: number;
  taginfo_total: number | null;
  entries: WorshipIndexEntry[];
}

/** feed_key for a detail tile: names the 10° cell, so each tile gets its own R2 key. */
export function tileFeedKey(lon: number, lat: number): string {
  // encode negatives as a leading 'n' rather than '-', so the key is human-scannable
  // and unambiguous (a bare '-' is R2-key-safe but reads badly interleaved with '_').
  const enc = (v: number) => (v < 0 ? `n${Math.abs(v)}` : `${v}`);
  return `osm_worship_tile_${enc(lon)}_${enc(lat)}`;
}

export const OVERVIEW_FEED_KEY = 'osm_worship_overview';
export const INDEX_FEED_KEY = 'osm_worship_index';

/**
 * Build a tile snapshot from the EXACT PWT1 bytes on disk. The content hash is over
 * those bytes (not the base64), so it addresses the data itself: the same tile always
 * hashes the same, a changed tile moves the key. Throws if the bytes are not a valid
 * PWT1 tile — a malformed artifact must never reach the publish plan.
 */
export async function buildTileSnapshot(
  bytes: Uint8Array,
  feedKey: string,
  layer: 'overview' | 'detail',
  meta: WorshipBuildMeta,
  tile?: { lon: number; lat: number; tileDeg: number },
): Promise<WorshipTileSnapshot> {
  const h = readPwtHeader(bytes); // validates magic + length
  const content_hash = await sha256HexBytes(bytes);
  const snap = {
    schema_version: 'atlas.worship.v1',
    feed_key: feedKey,
    content_hash,
    generated_at: meta.generatedAt,
    release_versions: [meta.releaseVersion],
    source: 'OpenStreetMap via Overpass API',
    license_key: WORSHIP_LICENCE_KEY,
    attribution: '© OpenStreetMap contributors',
    layer,
    points_encoding: 'PWT1+base64' as const,
    point_count: h.count,
    bbox: { minLon: h.minLon, minLat: h.minLat, spanLon: h.spanLon, spanLat: h.spanLat },
    ...(tile ? { tile: { lon: tile.lon, lat: tile.lat, tileDeg: tile.tileDeg } } : {}),
    pwt_base64: bytesToBase64(bytes),
  };
  return snap;
}

/**
 * Build the index snapshot from the tile entries. Its content hash is over the
 * canonical (sorted) list of entries, so an unchanged tile set yields a stable index
 * key. The index is a Derivative Database too (it enumerates the data's structure and
 * points at re-usable coordinate files), so it carries the SAME ODbL obligation — the
 * planner stamps it from WORSHIP_LICENCE_KEY exactly like the tiles.
 */
export async function buildIndexSnapshot(
  entries: WorshipIndexEntry[],
  opts: { tileDeg: number; overviewCellDeg: number; taginfoTotal: number | null },
  meta: WorshipBuildMeta,
): Promise<WorshipIndexSnapshot> {
  const sorted = [...entries].sort((a, b) => a.feed_key.localeCompare(b.feed_key));
  const totalPoints = sorted.filter((e) => e.layer === 'detail').reduce((n, e) => n + e.point_count, 0);
  const hashCore = canonicalJson({
    schema_version: 'atlas.worship-index.v1',
    tile_deg: opts.tileDeg,
    overview_cell_deg: opts.overviewCellDeg,
    entries: sorted.map((e) => ({ feed_key: e.feed_key, content_hash: e.content_hash, point_count: e.point_count })),
  });
  const content_hash = await sha256HexBytes(new TextEncoder().encode(hashCore));
  return {
    schema_version: 'atlas.worship-index.v1',
    feed_key: INDEX_FEED_KEY,
    content_hash,
    generated_at: meta.generatedAt,
    release_versions: [meta.releaseVersion],
    source: 'OpenStreetMap via Overpass API',
    license_key: WORSHIP_LICENCE_KEY,
    attribution: '© OpenStreetMap contributors',
    layer: 'index',
    tile_deg: opts.tileDeg,
    overview_cell_deg: opts.overviewCellDeg,
    total_points: totalPoints,
    taginfo_total: opts.taginfoTotal,
    entries: sorted,
  };
}

/** Deterministic sorted-key JSON, so the index hash never depends on key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
