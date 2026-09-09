/**
 * gdacs.ts — the PURE core of the GDACS disaster feed.
 *
 * This is the "no I/O" half, deliberately split from index.ts (which does the
 * fetch + the database write) for the same reason worldbank.ts is: everything here
 * — parsing a GDACS FeatureCollection, mapping an event type, forming the append-
 * only episode key, emitting the vintage-carrying event record, and building the
 * content-hashed R2 snapshot — is testable with NO network and NO database. Nothing
 * in this file imports Deno, touches the clock, or fetches. index.ts is the thin
 * shell that calls it.
 *
 * WHAT GDACS IS. The Global Disaster Alert and Coordination System (EC/UN) publishes
 * a public GeoJSON FeatureCollection of current events. VERIFIED LIVE 2026-08-17
 * against https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH — a 200
 * FeatureCollection of 100 Point features spanning eventtypes EQ, FL, TC, WF, DR, VO
 * with alertlevels Orange/Red. The field names below are taken from that live
 * response, not from memory.
 *
 * ATTRIBUTION IS THE DATABASE'S JOB, NOT THIS MODULE'S. GDACS features carry their
 * own country fields (`iso3`, `country`, `affectedcountries`). This module NEVER
 * uses any of them to attribute an event to a country. It emits the coordinate; the
 * atlas.event BEFORE-INSERT trigger runs point-in-polygon + the ~10km border buffer
 * and decides country / border_region / disputed / unlocated from the geometry
 * alone. A disaster does not respect a border and neither does our labelling of it,
 * so a point within the border buffer stays unattributed even though GDACS names a
 * country. The GDACS country fields are carried into the SNAPSHOT for display only,
 * explicitly labelled as the source's own claim, and are load-bearing in no join.
 *
 * WHY magnitude / magnitude_kind ARE NULL HERE. atlas.event.magnitude_kind is a
 * closed enum: 'fatalities' | 'displaced' | 'richter' | NULL. GDACS `severitydata`
 * is a per-type PHYSICAL EXTENT — km² for drought, hectares for wildfire, km/h for a
 * cyclone's wind, magnitude for a quake — none of which is a summable fatality or
 * displaced count, and only the earthquake case is richter (earthquakes are excluded
 * here — see below). Forcing any of these into `magnitude` would invite the rollup
 * to sum hectares across a continent. So the event row carries NO magnitude, and the
 * severity value/text/unit travel in the SNAPSHOT instead, verbatim and attributed
 * ("per GDACS"), never as our own conclusion.
 *
 * WHY EARTHQUAKES ARE EXCLUDED BY DEFAULT. The atlas already has a dedicated
 * `usgs_quakes` feed, and USGS is the authoritative source for earthquake location
 * and magnitude. Ingesting GDACS's EQ events too would plot two earthquake sources
 * on one globe and double-count them. So EQ is skipped by default (recorded, not
 * silently dropped) — its absence from THIS feed is not the absence of earthquakes,
 * which arrive via usgs_quakes. `includeEarthquakes: true` overrides this for a
 * caller that wants them.
 *
 * THE UNDER-COVERED-REGION RULE. A region with no GDACS alert is not a region
 * without suffering — GDACS monitors specific hazard types and thresholds. This
 * module therefore never emits a "0 events here" datum and never drops a real event
 * to make a tally look clean: an event we cannot geolocate is emitted UNLOCATED (not
 * discarded), an event of a type we do not recognise is emitted as a generic
 * 'disaster' (not discarded), and every skip is recorded with its reason.
 */

// ===========================================================================
// TYPES — taken from the live SEARCH response (verified 2026-08-17).
// ===========================================================================

/** GDACS `severitydata` — a per-type physical extent, NOT a casualty count. */
export interface GdacsSeverity {
  severity?: number | null;
  severitytext?: string;
  severityunit?: string;
}

/** One country in GDACS's `affectedcountries` list. Display only — never a join key. */
export interface GdacsAffectedCountry {
  iso2?: string;
  iso3?: string;
  countryname?: string;
}

/** The `properties` object of one GDACS feature. Only the fields we read are typed. */
export interface GdacsProperties {
  eventtype?: string; // 'EQ' | 'FL' | 'TC' | 'WF' | 'DR' | 'VO' | (future codes)
  eventid?: number | string;
  episodeid?: number | string;
  eventname?: string;
  name?: string;
  description?: string;
  alertlevel?: string; // 'Green' | 'Orange' | 'Red' — GDACS's OWN editorial label
  alertscore?: number | null;
  fromdate?: string; // event start, e.g. '2026-07-31T01:00:00' (UTC, no offset)
  todate?: string;
  datemodified?: string; // the episode's own vintage — becomes release_version
  iso3?: string; // GDACS's country claim — display only, NEVER used to attribute
  country?: string; // ditto
  affectedcountries?: GdacsAffectedCountry[]; // ditto
  severitydata?: GdacsSeverity;
  glide?: string;
  source?: string;
  url?: { report?: string; details?: string; geometry?: string };
}

/** One GDACS GeoJSON feature. */
export interface GdacsFeature {
  type?: string;
  geometry?: { type?: string; coordinates?: [number, number] | number[] } | null;
  properties?: GdacsProperties;
}

/** The GDACS response: a GeoJSON FeatureCollection. */
export interface GdacsFeatureCollection {
  type?: string;
  features?: GdacsFeature[];
}

/**
 * A fully-formed GDACS event. The snake_case fields at the top are exactly the
 * atlas.event columns this feed populates (so sql.ts can emit an INSERT without a
 * second mapping step); the display fields below them travel ONLY into the snapshot
 * and are never columns in atlas.event.
 *
 * The ATTRIBUTION columns (attribution_level, pip_iso_a3, disputed_name,
 * continent_m49, public_country_iso_a3) are deliberately ABSENT: the database
 * trigger owns them and derives them from `geom`. Supplying them here would be the
 * exact border-rule violation this feed must not commit.
 */
export interface GdacsEvent {
  // ---- atlas.event columns (the DB-insert shape) ----
  feed_key: 'gdacs_events';
  /** append-only episode key: `${code}-${eventid}-${episodeid}`. See file header. */
  external_id: string;
  /** mapped, readable event type ('flood', …) or 'disaster' for an unknown code. */
  event_type: string;
  /** ISO-8601 timestamptz — GDACS `fromdate` normalised to UTC. NOT NULL in schema. */
  occurred_at: string;
  /** GeoJSON longitude, or null when the event has no usable coordinate. */
  lon: number | null;
  /** GeoJSON latitude, or null when the event has no usable coordinate. */
  lat: number | null;
  /** always null: GDACS severity has no home in the fatalities/displaced/richter enum. */
  magnitude: null;
  /** always null: see `magnitude`. */
  magnitude_kind: null;
  source: 'GDACS';
  /** GDACS `datemodified` — the episode vintage. Drives release_version + clock 2. */
  release_version: string;
  retrieved_at: string;
  licence_key: string;

  // ---- snapshot-only display fields (NOT atlas.event columns) ----
  /** raw GDACS eventtype code ('FL', 'TC', …), kept for provenance. */
  event_type_code: string;
  event_id: string;
  episode_id: string;
  /** GDACS event name, e.g. 'Tropical Cyclone DOLPHIN-26'. */
  name: string;
  /** GDACS's OWN alert colour ('Green'|'Orange'|'Red') — carried as the source's label. */
  alert_level: string;
  alert_score: number | null;
  /** GDACS severity magnitude (heterogeneous unit) — display only, carried verbatim. */
  severity_value: number | null;
  severity_text: string;
  severity_unit: string;
  /** GDACS's affected-country iso3 list — the SOURCE'S claim, shown attributed, never joined. */
  affected_iso3: string[];
  /** GDACS's primary `iso3` — the SOURCE'S claim; NEVER used to attribute the event. */
  source_country_claim: string;
  glide: string;
  report_url: string;
}

/** Why a GDACS feature did NOT become an event — recorded, never silent. */
export interface GdacsSkip {
  eventtype: string;
  eventid: string;
  reason:
    | 'earthquake_excluded' // EQ: covered authoritatively by the usgs_quakes feed
    | 'no_occurred_at' // no parseable fromdate/datemodified — cannot satisfy NOT NULL occurred_at
    | 'missing_ids'; // no eventid/episodeid — cannot form a stable dedup key
}

export interface GdacsTransformResult {
  events: GdacsEvent[];
  skipped: GdacsSkip[];
}

// ===========================================================================
// EVENT-TYPE MAP — GDACS codes to the readable types stored on atlas.event.
// EQ is present in the map but excluded by default (see includeEarthquakes).
// ===========================================================================

export const GDACS_EVENT_TYPE: Readonly<Record<string, string>> = {
  EQ: 'earthquake',
  FL: 'flood',
  TC: 'cyclone',
  DR: 'drought',
  WF: 'wildfire',
  VO: 'volcano',
};

/** A GDACS code we do not recognise still describes a real disaster — never drop it. */
const UNKNOWN_EVENT_TYPE = 'disaster';

// ===========================================================================
// PARSING — get the response into the FeatureCollection shape, or THROW.
//
// "Could not parse" must NEVER become "nothing was happening." A shape we cannot
// make sense of is thrown with the offending shape named, so the caller records a
// real error (and keeps last-known-good) instead of quietly reading zero events.
// This is distinct from an event of an unknown TYPE, which is handled gracefully in
// the transform — a new hazard code is data, a broken response is an error.
// ===========================================================================

/**
 * Parse a GDACS response body into its feature array. Throws — with the offending
 * shape named — on anything that is not a GeoJSON FeatureCollection carrying a
 * `features` array. GDACS's own error object ({ "message": "Eventtype is required." })
 * is one such non-collection and is surfaced with its message.
 */
export function parseGdacsResponse(body: unknown): GdacsFeature[] {
  if (typeof body === 'string') {
    throw new Error(
      'GDACS response is a bare string (likely an HTML error page or a WAF block), not a FeatureCollection',
    );
  }
  if (body === null || typeof body !== 'object') {
    throw new Error(`GDACS response is ${body === null ? 'null' : typeof body}, not a FeatureCollection`);
  }
  const obj = body as Record<string, unknown>;
  // GDACS's error shape: { message: '...' } — surface it rather than treat as empty.
  if (typeof obj.message === 'string' && !Array.isArray(obj.features)) {
    throw new Error(`GDACS returned an API error: ${obj.message}`);
  }
  if (obj.type !== 'FeatureCollection') {
    throw new Error(
      `GDACS response type is ${JSON.stringify(obj.type)}, expected "FeatureCollection" — shape not understood`,
    );
  }
  if (!Array.isArray(obj.features)) {
    throw new Error('GDACS FeatureCollection has no `features` array — shape not understood');
  }
  return obj.features as GdacsFeature[];
}

// ===========================================================================
// TRANSFORM — GDACS features -> vintage-carrying event records.
// ===========================================================================

export interface GdacsTransformOptions {
  /** ISO-8601 instant WE fetched the data. Required — no number without its vintage. */
  retrievedAt: string;
  /** licence_key registered in atlas.source_licence, e.g. 'gdacs_cc_by_4'. */
  licenceKey: string;
  /**
   * Include GDACS earthquakes. Default FALSE: usgs_quakes covers earthquakes
   * authoritatively, and two quake sources on one globe would double-count.
   */
  includeEarthquakes?: boolean;
}

/** Normalise a GDACS timestamp to ISO-8601 UTC, or return null if unparseable. */
export function normalizeGdacsTimestamp(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // GDACS emits '2026-07-31T01:00:00' with no offset; those instants are UTC. Only
  // append 'Z' when there is no timezone designator already present.
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const candidate = hasTz ? trimmed : `${trimmed}Z`;
  const ms = Date.parse(candidate);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Extract a usable [lon, lat] from a GDACS feature's geometry, or null when the
 * event has no usable coordinate. (0,0) — the classic "missing coordinate" sentinel
 * — is treated as no-coordinate here; the DB attribute_point() also guards Null
 * Island, so this is belt-and-braces, and either way the event is emitted UNLOCATED
 * rather than dropped.
 */
export function coordsFromGeometry(geometry: GdacsFeature['geometry']): { lon: number; lat: number } | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const coords = geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lon = coords[0];
  const lat = coords[1];
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  if (lon === 0 && lat === 0) return null; // Null Island sentinel -> unlocated
  return { lon, lat };
}

/**
 * Map GDACS features into event records. Coordinates are emitted for the DB to
 * attribute (never attributed here); the raw GDACS country claim is carried into the
 * display fields only. Earthquakes are excluded by default; an unknown event-type
 * code becomes the generic 'disaster' rather than being dropped; an event with no
 * coordinate is emitted unlocated rather than dropped. Every drop is recorded.
 */
export function transformGdacsFeatures(
  features: GdacsFeature[],
  opts: GdacsTransformOptions,
): GdacsTransformResult {
  const events: GdacsEvent[] = [];
  const skipped: GdacsSkip[] = [];

  for (const feature of features) {
    // A feature must carry a `properties` object; if it does not, the provider's
    // schema drifted — throw rather than silently skip (a vanished field must not
    // read as "no event"). This is schema drift, not an unknown hazard type.
    if (!feature || typeof feature !== 'object' || !feature.properties || typeof feature.properties !== 'object') {
      throw new Error('GDACS feature has no `properties` object — schema drift, refusing to read it as empty');
    }
    const p = feature.properties;
    const code = String(p.eventtype ?? '').trim().toUpperCase();

    const eventIdRaw = p.eventid;
    const episodeIdRaw = p.episodeid;
    if (
      eventIdRaw === undefined || eventIdRaw === null || eventIdRaw === '' ||
      episodeIdRaw === undefined || episodeIdRaw === null || episodeIdRaw === ''
    ) {
      skipped.push({ eventtype: code || 'unknown', eventid: String(eventIdRaw ?? ''), reason: 'missing_ids' });
      continue;
    }
    const eventId = String(eventIdRaw);
    const episodeId = String(episodeIdRaw);

    // Earthquakes: covered by usgs_quakes. Excluded by default, RECORDED not silent.
    if (code === 'EQ' && !opts.includeEarthquakes) {
      skipped.push({ eventtype: code, eventid: eventId, reason: 'earthquake_excluded' });
      continue;
    }

    // occurred_at is NOT NULL. Prefer the event start; fall back to the modification
    // instant; only if neither parses do we skip (recording why) — we cannot store a
    // null occurred_at, so an undateable event has no valid row here.
    const occurredAt = normalizeGdacsTimestamp(p.fromdate) ?? normalizeGdacsTimestamp(p.datemodified);
    if (occurredAt === null) {
      skipped.push({ eventtype: code, eventid: eventId, reason: 'no_occurred_at' });
      continue;
    }

    // release_version = the episode's own vintage (datemodified), falling back to the
    // start date, then to the id — always SOMETHING, because a vintage is mandatory.
    const releaseVersion = normalizeGdacsTimestamp(p.datemodified) ?? occurredAt ?? `${eventId}-${episodeId}`;

    // An unknown GDACS code still describes a real disaster: map to a generic type,
    // never drop it. (This is the graceful path; a broken RESPONSE shape throws in
    // parseGdacsResponse — the two cases are deliberately handled differently.)
    const eventType = GDACS_EVENT_TYPE[code] ?? UNKNOWN_EVENT_TYPE;

    const coord = coordsFromGeometry(feature.geometry);

    const affectedIso3 = Array.isArray(p.affectedcountries) ? p.affectedcountries.map((c) => String(c?.iso3 ?? '').trim()).filter((s) => s !== '') : [];

    const sev = p.severitydata ?? {};

    events.push({
      feed_key: 'gdacs_events',
      external_id: `${code || 'XX'}-${eventId}-${episodeId}`,
      event_type: eventType,
      occurred_at: occurredAt,
      lon: coord ? coord.lon : null,
      lat: coord ? coord.lat : null,
      magnitude: null,
      magnitude_kind: null,
      source: 'GDACS',
      release_version: releaseVersion,
      retrieved_at: opts.retrievedAt,
      licence_key: opts.licenceKey,

      event_type_code: code || 'XX',
      event_id: eventId,
      episode_id: episodeId,
      name: String(p.name ?? p.eventname ?? '').trim(),
      alert_level: String(p.alertlevel ?? '').trim(),
      alert_score: typeof p.alertscore === 'number' ? p.alertscore : null,
      severity_value: typeof sev.severity === 'number' ? sev.severity : null,
      severity_text: String(sev.severitytext ?? '').trim(),
      severity_unit: String(sev.severityunit ?? '').trim(),
      affected_iso3: affectedIso3,
      source_country_claim: String(p.iso3 ?? '').trim(),
      glide: String(p.glide ?? '').trim(),
      report_url: String(p.url?.report ?? '').trim(),
    });
  }

  return { events, skipped };
}

// ===========================================================================
// THE R2-SHAPED SNAPSHOT — content-hashed, every event carrying its vintage and
// GDACS's editorial labels carried AS the source's, attributed, never as ours.
// ===========================================================================

/** One event in the snapshot, with its provenance and GDACS's own labels alongside. */
export interface SnapshotEvent {
  external_id: string;
  event_type: string;
  event_type_code: string;
  event_id: string;
  episode_id: string;
  occurred_at: string;
  lon: number | null;
  lat: number | null;
  name: string;
  /** GDACS's OWN alert colour — carried as the source's editorial judgement, attributed. */
  alert_level: string;
  alert_score: number | null;
  severity_value: number | null;
  severity_text: string;
  severity_unit: string;
  /** GDACS's affected-country claim — the SOURCE'S, shown attributed, used in no join. */
  affected_iso3: string[];
  source_country_claim: string;
  glide: string;
  report_url: string;
  // vintage — no event without it
  source: string;
  release_version: string;
  retrieved_at: string;
}

export interface GdacsSnapshot {
  schema_version: string;
  feed_key: string;
  source: string;
  license_key: string;
  /** the exact credit line GDACS's licence requires on every republished file. */
  attribution: string;
  /** when this snapshot artifact was built (wall clock — excluded from the hash). */
  generated_at: string;
  event_count: number;
  /** GDACS's alert-level tallies, as the SOURCE'S labels — never our safety conclusion. */
  alert_level_counts: Record<string, number>;
  events: SnapshotEvent[];
  /** sha256 of the canonical JSON of the data+vintage core (wall clock excluded). */
  content_hash: string;
}

/** Deterministic stringify with sorted keys, so the hash is stable across runs. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** sha256 hex via Web Crypto (present in Deno, Node 18+, and the browser). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The GDACS attribution line the licence requires (see docs/DATA-LICENSE-REGISTER.md §6). */
export function gdacsAttribution(year: number): string {
  return `Source: GDACS (Global Disaster Alert and Coordination System), © European Union, ${year}, licensed under CC BY 4.0.`;
}

export interface GdacsSnapshotMeta {
  feedKey: string;
  licenceKey: string;
  generatedAt: string;
  /** attribution year; defaults to the year of generatedAt. */
  attributionYear?: number;
}

/**
 * Build the R2-shaped snapshot from event records.
 *
 * THE HASH ADDRESSES THE DATA, NOT THE CLOCK. content_hash is computed over the
 * canonical (sorted-key) JSON of the DATA-AND-VINTAGE fields only — external id,
 * type, coordinates, GDACS's labels, severity, occurred_at, release_version. The
 * wall-clock fields (generated_at and each event's retrieved_at) are EXCLUDED, so
 * two runs over the identical GDACS state at different times produce the SAME hash.
 * That is what lets the hash feed the feedRegistry 'content_hash' change strategy: a
 * hash change means the DATA changed, never merely that the clock advanced.
 *
 * ALERT LEVELS ARE THE SOURCE'S, NOT OURS. alert_level_counts tallies GDACS's own
 * Green/Orange/Red judgement so a consumer can show it attributed. It is never a
 * statement that anywhere is safe: a place with no GDACS alert may simply be
 * unmonitored (the under-covered-region rule), so the snapshot carries no zero that
 * could be read as peace.
 */
export async function buildGdacsSnapshot(
  events: GdacsEvent[],
  meta: GdacsSnapshotMeta,
): Promise<GdacsSnapshot> {
  const snapshotEvents: SnapshotEvent[] = events
    .map((e) => ({
      external_id: e.external_id,
      event_type: e.event_type,
      event_type_code: e.event_type_code,
      event_id: e.event_id,
      episode_id: e.episode_id,
      occurred_at: e.occurred_at,
      lon: e.lon,
      lat: e.lat,
      name: e.name,
      alert_level: e.alert_level,
      alert_score: e.alert_score,
      severity_value: e.severity_value,
      severity_text: e.severity_text,
      severity_unit: e.severity_unit,
      affected_iso3: e.affected_iso3,
      source_country_claim: e.source_country_claim,
      glide: e.glide,
      report_url: e.report_url,
      source: e.source,
      release_version: e.release_version,
      retrieved_at: e.retrieved_at,
    }))
    .sort((a, b) => a.external_id.localeCompare(b.external_id));

  const alertLevelCounts: Record<string, number> = {};
  for (const e of snapshotEvents) {
    const key = e.alert_level || 'Unspecified';
    alertLevelCounts[key] = (alertLevelCounts[key] ?? 0) + 1;
  }

  const attributionYear = meta.attributionYear ?? new Date(meta.generatedAt).getUTCFullYear();
  const attribution = gdacsAttribution(Number.isFinite(attributionYear) ? attributionYear : new Date().getUTCFullYear());

  // The hashable CORE: data + vintage, but NOT wall-clock. retrieved_at is dropped
  // per event here (it stays in the emitted artifact below); generated_at is never
  // in the core at all.
  const hashCore = {
    schema_version: 'atlas.snapshot.v1',
    feed_key: meta.feedKey,
    source: 'GDACS',
    license_key: meta.licenceKey,
    event_count: snapshotEvents.length,
    alert_level_counts: alertLevelCounts,
    events: snapshotEvents.map(({ retrieved_at: _omit, ...rest }) => rest),
  };
  const content_hash = await sha256Hex(canonicalJson(hashCore));

  return {
    schema_version: 'atlas.snapshot.v1',
    feed_key: meta.feedKey,
    source: 'GDACS',
    license_key: meta.licenceKey,
    attribution,
    generated_at: meta.generatedAt,
    event_count: snapshotEvents.length,
    alert_level_counts: alertLevelCounts,
    events: snapshotEvents,
    content_hash,
  };
}
