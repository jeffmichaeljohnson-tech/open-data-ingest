/**
 * usgs.ts — the PURE core of the USGS earthquake event feed.
 *
 * This is the "no I/O" half, deliberately split from index.ts (which does the fetch
 * and the database write), exactly like worldbank.ts is for the reference feed:
 * everything here — parsing a USGS GeoJSON FeatureCollection, turning each feature
 * into a vintage-carrying event record, and building the content-hashed R2 snapshot —
 * is provable with NO network and NO database. The previous moderation vendor's parser
 * could only be exercised through a live call and hid two defects for seven months;
 * this shape exists so the parser is tested against fixtures instead.
 *
 * WHY THIS FEED IS AN *EVENT* FEED, NOT A REFERENCE ONE. World Bank arrives already
 * keyed by a country code and is attributed by a crosswalk lookup. USGS arrives as a
 * COORDINATE (lon, lat) and is attributed by point-in-polygon on the SERVER — the
 * atlas.event BEFORE INSERT trigger runs atlas.attribute_point() and fills
 * attribution_level / pip_iso_a3 / continent_m49 / public_country_iso_a3 itself. So
 * this module deliberately supplies a correct geom and NOTHING in those columns. The
 * border-buffer rule (a point within ~10km of a land boundary is never publicly
 * attributed to a country) lives in that trigger; we do not reverse-geocode, we do
 * not look up a country, we hand over the coordinate and let the server decide.
 *
 * THE VINTAGE IS THE POINT. Every event carries source ('USGS'), the release token
 * (metadata.generated, the feed's own generation instant), and retrieved_at (when WE
 * fetched it). No number is emitted bare.
 *
 * A MAGNITUDE IS A MAGNITUDE — ITS SCALE IS LABELLED, NOT FLATTENED. USGS reports the
 * magnitude SCALE per event in properties.magType ('mb' body-wave, 'mww' moment,
 * 'ml' local, 'md' duration, 'mh' …). These are physically different scales and must
 * not be blended. Verified live 2026-08-17 that a single day's feed mixes mb, md, mh,
 * ml and mww. The atlas.event.magnitude_kind CHECK only admits
 * ('fatalities','displaced','richter'), so magnitude_kind is set to the coarse,
 * non-summable bucket 'richter' (a seismic magnitude is NEVER summed at rollup) and
 * the PRECISE scale travels in magnitude_scale — the additive column proposed in
 * PROPOSED_20260817300000_usgs_atlas_wiring.sql.txt. That mismatch is called out in
 * the report, not papered over: the schema's three-value CHECK was written for
 * conflict/displacement feeds and 'richter' is a loose fit for a moment magnitude.
 */

// ===========================================================================
// TYPES — the USGS GeoJSON shape, verified live 2026-08-17 against
// earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson.
// ===========================================================================

/** The per-event properties block. Only the fields we actually read are typed; the
 *  many others (felt, cdi, mmi, alert, tsunami, sig, net, …) are left open. */
export interface UsgsFeatureProperties {
  /** magnitude value. USGS may report null (a located event of unknown magnitude). */
  mag: number | null;
  /** the magnitude SCALE — 'mb','mww','ml','md','mh',… Labelled, never flattened. */
  magType: string | null;
  /** event kind as USGS classifies it — 'earthquake','explosion','quarry blast',… */
  type: string | null;
  /** origin time, epoch milliseconds. */
  time: number | null;
  /** human place description, e.g. 'Kuril Islands'. Kept for the snapshot only. */
  place?: string | null;
  [k: string]: unknown;
}

/** A GeoJSON geometry. USGS uses Point with [lon, lat, depthKm]; may be null. */
export interface UsgsGeometry {
  type: string;
  /** [lon, lat, depthKm]. Verified live: always a 3-tuple for located events. */
  coordinates: number[];
}

/** One USGS GeoJSON feature (one earthquake). id is the stable dedup key. */
export interface UsgsFeature {
  type: string;
  /** the stable USGS event id, e.g. 'us6000tlbz'. Becomes external_id. */
  id: string;
  geometry: UsgsGeometry | null;
  properties: UsgsFeatureProperties;
}

/** The page-level metadata. metadata.generated (epoch ms) is the high-water token. */
export interface UsgsMetadata {
  /** epoch ms the feed artifact was generated — the row_high_water change token. */
  generated: number;
  count: number;
  title?: string;
  status?: number;
  url?: string;
  api?: string;
}

/** A parsed USGS response: page metadata + the feature array. */
export interface ParsedUsgsResponse {
  meta: UsgsMetadata;
  features: UsgsFeature[];
}

/**
 * A fully-formed atlas.event row — every column WE own populated, and none we do not.
 * The attribution columns (attribution_level, pip_iso_a3, disputed_name,
 * continent_m49, public_country_iso_a3) are DELIBERATELY ABSENT: the server trigger
 * computes them from geom. We only ever supply lon/lat and the vintage.
 */
export interface EventRecord {
  feed_key: string;
  external_id: string; // USGS feature.id
  event_type: string; // USGS properties.type, recorded verbatim (not assumed 'earthquake')
  occurred_at: string; // ISO-8601, from properties.time
  lon: number;
  lat: number;
  /** seismic depth in km (coordinates[2]). Carried in the snapshot; no DB column. */
  depth_km: number | null;
  magnitude: number | null; // properties.mag; null is a real "unknown magnitude"
  magnitude_kind: 'richter' | null; // the CHECK-admitted, non-summable seismic bucket
  magnitude_scale: string | null; // the PRECISE scale (magType): mb/mww/ml/… — never flattened
  place: string | null; // properties.place, snapshot-only context
  source: string; // 'USGS'
  release_version: string; // metadata.generated (as a string) — the feed vintage
  retrieved_at: string; // when WE fetched it
  licence_key: string; // FK into atlas.source_licence
}

/** Why a USGS feature did NOT become an event — kept for transparency, never silent. */
export interface SkipRecord {
  id: string;
  reason:
    | 'missing_geometry' // a located-event feed with no coordinate cannot be placed on the globe
    | 'invalid_coordinates' // lon/lat non-numeric or physically out of range — corruption, not a reading
    | 'magnitude_out_of_range' // a finite mag outside seismic bounds is a sentinel/parse error, not a quake
    | 'missing_time'; // no origin time — occurred_at is NOT NULL and cannot be honestly faked
  detail: string;
}

export interface TransformResult {
  records: EventRecord[];
  skipped: SkipRecord[];
}

// ===========================================================================
// PARSING — separate a real USGS FeatureCollection from a 200 that is not one.
//
// THE HARD RULE (task requirement): a response whose shape we do NOT understand must
// THROW, never return zero rows. "Could not parse" must never be expressible as
// "nothing happened" — a silent zero would read as "the earth went quiet", the exact
// false-peace failure this whole design guards against. An HTML/WAF page is caught
// upstream by the shared garbage guard before this is called (JSON.parse fails there);
// this function's job is: given parsed JSON, is it a USGS FeatureCollection or not?
// ===========================================================================

/**
 * Parse a USGS GeoJSON response body. A valid response is an object with
 * type === 'FeatureCollection', a metadata object carrying `generated`, and a
 * `features` ARRAY (which may legitimately be empty — a quiet window is data, not an
 * error). Anything else THROWS with the offending shape named, so a caller's catch
 * records a real reason instead of a stack trace, and an unrecognised payload can
 * never be mistaken for "no earthquakes".
 */
export function parseUsgsResponse(body: unknown): ParsedUsgsResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(
      `USGS response is not a GeoJSON object (got ${body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body}) — likely an error page or a different endpoint`,
    );
  }
  const obj = body as Record<string, unknown>;
  if (obj.type !== 'FeatureCollection') {
    throw new Error(
      `USGS response type is '${String(obj.type)}', expected 'FeatureCollection' — refusing to treat an unknown shape as zero earthquakes`,
    );
  }
  const meta = obj.metadata as Record<string, unknown> | undefined;
  if (meta === undefined || meta === null || typeof meta !== 'object') {
    throw new Error("USGS response has no metadata object — cannot read the 'generated' vintage token");
  }
  if (typeof meta.generated !== 'number') {
    throw new Error(`USGS metadata.generated is ${typeof meta.generated}, expected an epoch-ms number (the vintage token)`);
  }
  if (!Array.isArray(obj.features)) {
    throw new Error(
      `USGS response.features is ${obj.features === undefined ? 'absent' : typeof obj.features}, expected an array — an unknown shape must throw, not read as empty`,
    );
  }
  return {
    meta: {
      generated: meta.generated as number,
      count: typeof meta.count === 'number' ? (meta.count as number) : (obj.features as unknown[]).length,
      title: typeof meta.title === 'string' ? (meta.title as string) : undefined,
      status: typeof meta.status === 'number' ? (meta.status as number) : undefined,
      url: typeof meta.url === 'string' ? (meta.url as string) : undefined,
      api: typeof meta.api === 'string' ? (meta.api as string) : undefined,
    },
    features: obj.features as UsgsFeature[],
  };
}

// ===========================================================================
// TRANSFORM — USGS features -> vintage-carrying event records.
//
// Per-feature problems (a null geometry, an out-of-range coordinate, a sentinel
// magnitude, a missing time) SKIP that one row WITH a reason — they never throw and
// never silently drop it. Only an unrecognised top-level shape throws (in the parser
// above). This split is deliberate: one corrupt feature must not lose a whole batch,
// but a payload we cannot recognise must never masquerade as a calm planet.
// ===========================================================================

/** Seismic magnitude physical bounds. Below -2 or above ~10 is a sentinel/parse
 *  error, not a reading (the largest instrumentally recorded is ~9.5). */
const MAG_MIN = -2;
const MAG_MAX = 12;

export interface TransformOptions {
  feedKey: string;
  /** metadata.generated as a string — the vintage / release token. Required. */
  releaseVersion: string;
  /** ISO-8601 instant WE fetched the data. Required — no number without it. */
  retrievedAt: string;
  /** licence_key registered in atlas.source_licence, e.g. 'usgs_pd'. */
  licenceKey: string;
}

/**
 * Map USGS features into event records. Each event carries its coordinate (for the
 * server's point-in-polygon), its magnitude WITH its scale labelled, and its full
 * vintage. Rows that cannot be honestly placed or measured are collected in `skipped`
 * with a reason rather than dropped.
 */
export function transformUsgsFeatures(features: UsgsFeature[], opts: TransformOptions): TransformResult {
  const records: EventRecord[] = [];
  const skipped: SkipRecord[] = [];

  for (const f of features) {
    const id = f?.id ?? '(no id)';
    const props = f?.properties ?? ({} as UsgsFeatureProperties);

    // 1. No geometry -> cannot place a located event on the globe. Skip, transparently.
    if (f.geometry === null || f.geometry === undefined || !Array.isArray(f.geometry.coordinates)) {
      skipped.push({ id, reason: 'missing_geometry', detail: 'feature has null/absent geometry' });
      continue;
    }

    const [lon, lat, depth] = f.geometry.coordinates;
    // 2. Coordinates must be real numbers within the physical envelope. Out-of-range
    //    is corruption (a swapped lon/lat, a sentinel), not a reading.
    if (
      typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180 ||
      typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90
    ) {
      skipped.push({ id, reason: 'invalid_coordinates', detail: `lon=${String(lon)} lat=${String(lat)}` });
      continue;
    }

    // 3. Origin time is required — occurred_at is NOT NULL and a faked time would be a lie.
    if (typeof props.time !== 'number' || !Number.isFinite(props.time)) {
      skipped.push({ id, reason: 'missing_time', detail: `time=${String(props.time)}` });
      continue;
    }

    // 4. Magnitude: NULL is a legitimate "located event, magnitude unknown" and is
    //    STORED (magnitude null). A FINITE but out-of-range value is a sentinel and
    //    skips the row (the location may be fine, but a mag of 99 is not a magnitude).
    let magnitude: number | null;
    if (props.mag === null || props.mag === undefined) {
      magnitude = null;
    } else if (typeof props.mag === 'number' && Number.isFinite(props.mag) && props.mag >= MAG_MIN && props.mag <= MAG_MAX) {
      magnitude = props.mag;
    } else {
      skipped.push({ id, reason: 'magnitude_out_of_range', detail: `mag=${String(props.mag)} outside [${MAG_MIN},${MAG_MAX}]` });
      continue;
    }

    const magScale = typeof props.magType === 'string' && props.magType.trim() !== '' ? props.magType.trim() : null;

    records.push({
      feed_key: opts.feedKey,
      external_id: id,
      // Record what USGS classified it as, verbatim. Most are 'earthquake'; the feed
      // also carries 'explosion'/'quarry blast'. We do not overwrite that with an
      // assumption — record the measurement, not a conclusion.
      event_type: typeof props.type === 'string' && props.type.trim() !== '' ? props.type.trim() : 'earthquake',
      occurred_at: new Date(props.time).toISOString(),
      lon,
      lat,
      depth_km: typeof depth === 'number' && Number.isFinite(depth) ? depth : null,
      magnitude,
      // A seismic magnitude is never summable at rollup; 'richter' is the only
      // CHECK-admitted bucket that says so. The true scale is preserved separately.
      magnitude_kind: magnitude === null ? null : 'richter',
      magnitude_scale: magScale,
      place: typeof props.place === 'string' ? props.place : null,
      source: 'USGS',
      release_version: opts.releaseVersion,
      retrieved_at: opts.retrievedAt,
      licence_key: opts.licenceKey,
    });
  }

  return { records, skipped };
}

// ===========================================================================
// THE R2-SHAPED SNAPSHOT — content-hashed, every number carrying its vintage.
// Mirrors worldbank.ts's snapshot discipline so the two feeds produce comparable
// artifacts: the hash addresses the DATA + VINTAGE, never the wall clock.
// ===========================================================================

/** One event in the snapshot, its full provenance travelling alongside it. */
export interface SnapshotEvent {
  external_id: string;
  event_type: string;
  occurred_at: string;
  lon: number;
  lat: number;
  depth_km: number | null;
  magnitude: number | null;
  magnitude_scale: string | null; // the true scale, preserved for the consumer
  place: string | null;
  // vintage — no number without it
  source: string;
  release_version: string;
  retrieved_at: string;
}

export interface Snapshot {
  schema_version: string;
  feed_key: string;
  source: string;
  license_key: string;
  generated_at: string;
  /** the source generation token(s) represented, for a fast staleness read. */
  release_versions: string[];
  event_count: number;
  events: SnapshotEvent[];
  /** sha256 of the canonical JSON of the DATA+VINTAGE (wall-clock fields excluded). */
  content_hash: string;
}

/** Deterministically stringify with sorted keys, so the hash is stable across runs. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** sha256 hex of a string, via Web Crypto (present in Deno, Node 18+, and the browser). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface SnapshotMeta {
  feedKey: string;
  licenceKey: string;
  generatedAt: string;
}

/**
 * Build the R2-shaped snapshot from event records.
 *
 * THE HASH ADDRESSES THE DATA, NOT THE CLOCK. content_hash is computed over the
 * canonical (sorted-key) JSON of the data-and-vintage fields only. The wall-clock
 * fields (generated_at and each event's retrieved_at) are EXCLUDED, so two runs over
 * the identical set of earthquakes at different times produce the SAME hash — the
 * property that makes the artifact genuinely content-addressed. release_version
 * (metadata.generated) is IN the hash because it is source vintage, not our clock.
 *
 * Events are sorted by (occurred_at, external_id) so row order never perturbs the
 * hash. Every emitted event carries source, release version and retrieval time;
 * there is deliberately no code path that emits a bare coordinate.
 */
export async function buildSnapshot(records: EventRecord[], meta: SnapshotMeta): Promise<Snapshot> {
  const events: SnapshotEvent[] = records
    .map((r) => ({
      external_id: r.external_id,
      event_type: r.event_type,
      occurred_at: r.occurred_at,
      lon: r.lon,
      lat: r.lat,
      depth_km: r.depth_km,
      magnitude: r.magnitude,
      magnitude_scale: r.magnitude_scale,
      place: r.place,
      source: r.source,
      release_version: r.release_version,
      retrieved_at: r.retrieved_at,
    }))
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.external_id.localeCompare(b.external_id));

  const releaseVersions = Array.from(new Set(events.map((e) => e.release_version))).sort();

  // The hashable CORE: data + vintage, but NOT wall-clock. retrieved_at is dropped
  // per event here (it stays in the emitted artifact below); generated_at is never
  // in the core at all.
  const hashCore = {
    schema_version: 'atlas.snapshot.v1',
    feed_key: meta.feedKey,
    source: 'USGS',
    license_key: meta.licenceKey,
    release_versions: releaseVersions,
    event_count: events.length,
    events: events.map(({ retrieved_at: _omit, ...rest }) => rest),
  };
  const content_hash = await sha256Hex(canonicalJson(hashCore));

  return {
    schema_version: 'atlas.snapshot.v1',
    feed_key: meta.feedKey,
    source: 'USGS',
    license_key: meta.licenceKey,
    generated_at: meta.generatedAt,
    release_versions: releaseVersions,
    event_count: events.length,
    events,
    content_hash,
  };
}
