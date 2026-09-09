/**
 * sql.ts — pure SQL emitters for the GDACS event rows and the seed rows the FK chain
 * requires. Kept separate from gdacs.ts (fetch/transform core) and index.ts (runtime
 * shell) because generating an INSERT is a distinct, deterministic, testable concern
 * — and because the ROLLED-BACK proof harness needs exactly this without pulling in
 * the Deno-serve entrypoint. No I/O here; every function returns a string.
 *
 * APPEND-ONLY, EPISODE-VINTAGED. atlas.event dedups on (feed_key, external_id)
 * [constraint event_dedup]. GDACS re-issues an event as EPISODES as it evolves — a
 * cyclone strengthening is a new episodeid (DOLPHIN-26 was on episode 55 when this
 * was written). So external_id is keyed on the EPISODE (`${code}-${eventid}-
 * ${episodeid}`), which makes each episode land as its OWN append-only row carrying
 * its own datemodified vintage (release_version), and makes re-ingesting the SAME
 * episode a no-op. History is preserved, never overwritten:
 *
 *   - ON CONFLICT DO NOTHING, never UPSERT — an upsert would silently overwrite the
 *     very episode history the key exists to keep.
 *   - keying on the episode rather than the bare eventid is the deliberate choice for
 *     item 4 of the task: a cyclone strengthening is a NEW VINTAGE ROW, not an
 *     ignored update and not an overwrite. A consumer wanting "current state" selects
 *     the max-episode row per eventid (a read concern, not built here).
 *
 * THE ATTRIBUTION COLUMNS ARE NEVER WRITTEN. The INSERT names only geom + the vintage
 * columns; attribution_level / pip_iso_a3 / disputed_name / continent_m49 /
 * public_country_iso_a3 are set by the atlas.event BEFORE-INSERT trigger from geom.
 * geom is built fully-qualified (public.st_setsrid(public.st_makepoint(...))) so the
 * statement is search-path independent, exactly as the spine's own DDL is.
 */
import type { GdacsEvent } from './gdacs.ts';

/** A single SQL literal for a nullable scalar (numbers unquoted, strings escaped). */
function lit(v: string | number | null): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + v.replace(/'/g, "''") + "'";
}

/** The atlas.event columns we populate, in a fixed order. */
export const EVENT_COLS = [
  'feed_key',
  'external_id',
  'event_type',
  'occurred_at',
  'geom',
  'magnitude',
  'magnitude_kind',
  'source',
  'release_version',
  'retrieved_at',
  'licence_key',
] as const;

/** Build the geom cell: NULL for an unlocated event, else a fully-qualified point. */
function geomCell(lon: number | null, lat: number | null): string {
  if (lon === null || lat === null) return 'NULL';
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 'NULL';
  return `public.st_setsrid(public.st_makepoint(${lon}, ${lat}), 4326)`;
}

function rowValues(e: GdacsEvent, overrides?: EventInsertOverrides): string {
  const externalId = overrides?.externalIdSuffix ? `${e.external_id}${overrides.externalIdSuffix}` : e.external_id;
  const releaseVersion = overrides?.releaseVersion ?? e.release_version;
  return (
    '(' +
    [
      lit(e.feed_key),
      lit(externalId),
      lit(e.event_type),
      lit(e.occurred_at) + '::timestamptz',
      geomCell(e.lon, e.lat),
      lit(e.magnitude), // always NULL — GDACS severity has no summable home here
      lit(e.magnitude_kind), // always NULL
      lit(e.source),
      lit(releaseVersion),
      lit(e.retrieved_at) + '::timestamptz',
      lit(e.licence_key),
    ].join(', ') +
    ')'
  );
}

export interface EventInsertOverrides {
  /** appended to every external_id — the proof harness uses it to simulate a new episode. */
  externalIdSuffix?: string;
  /** replaces release_version — the proof harness uses it to simulate a later vintage. */
  releaseVersion?: string;
}

/**
 * Build ONE multi-row INSERT ... ON CONFLICT DO NOTHING for the given events.
 * Optionally override the external_id suffix / release_version, which the proof
 * harness uses to simulate a LATER episode of the same events — the case that must
 * create NEW rows, not overwrite.
 */
export function buildEventInsert(events: GdacsEvent[], overrides?: EventInsertOverrides): string {
  if (events.length === 0) return '-- (no GDACS event records to insert)\n';
  const values = events.map((e) => rowValues(e, overrides)).join(',\n  ');
  return (
    `insert into atlas.event (${EVENT_COLS.join(', ')})\nvalues\n  ` +
    values +
    `\non conflict on constraint event_dedup do nothing;\n`
  );
}

/**
 * The GDACS licence row. atlas.event.licence_key is an FK into atlas.source_licence,
 * which ships empty, so this must be seeded before any event insert. Idempotent.
 * Terms: CC BY 4.0 via the European Commission reuse policy — attribution
 * required, no share-alike, no registration.
 */
export function buildLicenceSeed(): string {
  return (
    'insert into atlas.source_licence ' +
    '(licence_key, label, spdx, url, attribution_required, attribution_text, share_alike, non_commercial, verified, verified_at, notes)\n' +
    "values ('gdacs_cc_by_4', 'CC BY 4.0 (via EC reuse policy)', 'CC-BY-4.0', " +
    "'https://commission.europa.eu/legal-notice_en', true, " +
    "'Source: GDACS (Global Disaster Alert and Coordination System), © European Union, licensed under CC BY 4.0.', " +
    "false, false, true, '2026-08-17', " +
    "'CC BY 4.0 inherited from Commission Decision 2011/833/EU; GDACS'' own terms page carries only as-is/liability text and does not restate the licence. Attribution mandatory on every republished R2 file.')\n" +
    'on conflict (licence_key) do nothing;\n'
  );
}

/**
 * The GDACS feed row. atlas.event.feed_key is an FK into atlas.feed, and
 * atlas.feed_heartbeat references it too, so this must be seeded before any event
 * insert. Values mirror the feedRegistry gdacs_events entry. Idempotent.
 */
export function buildFeedSeed(): string {
  return (
    'insert into atlas.feed ' +
    '(feed_key, display_name, clock, source_url, licence_key, cadence_hours, max_staleness_hours, ' +
    'change_detection, requires_browser_ua, requires_token, active, notes)\n' +
    "values ('gdacs_events', 'GDACS global disaster alerts', 'event', " +
    "'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH', 'gdacs_cc_by_4', 3, 12, " +
    "'content_hash', true, false, true, " +
    "'GeoJSON FeatureCollection verified live 2026-08-17. Earthquakes excluded by default (usgs_quakes covers them). Attribution from geometry only, never GDACS'' country field.')\n" +
    'on conflict (feed_key) do nothing;\n'
  );
}

/**
 * The success-path heartbeat upsert. Implements the two-clock discipline in SQL:
 *   - CLOCK 1 (last_success_at) ALWAYS advances — our pipeline ran and landed data.
 *   - CLOCK 2 (last_change_at) advances ONLY when the content hash actually changed;
 *     a re-run over identical GDACS state leaves it where it was (the 'unchanged'
 *     case). This is the reconcileHeartbeat 'accepted' vs 'unchanged' rule, in SQL.
 * A validation-rejected load must NOT call this — it keeps last-known-good instead.
 */
export function buildHeartbeatUpsert(contentHash: string, rowCount: number): string {
  const hashLit = lit(contentHash);
  return (
    'insert into atlas.feed_heartbeat ' +
    '(feed_key, last_success_at, last_change_at, last_release_token, last_row_count, last_status, updated_at)\n' +
    `values ('gdacs_events', now(),\n` +
    `  case when (select last_release_token from atlas.feed_heartbeat where feed_key = 'gdacs_events') is distinct from ${hashLit}\n` +
    `       then now()\n` +
    `       else coalesce((select last_change_at from atlas.feed_heartbeat where feed_key = 'gdacs_events'), now()) end,\n` +
    `  ${hashLit}, ${rowCount}, 'ok', now())\n` +
    'on conflict (feed_key) do update set\n' +
    '  last_success_at   = excluded.last_success_at,\n' +
    '  last_change_at    = case when atlas.feed_heartbeat.last_release_token is distinct from excluded.last_release_token\n' +
    '                           then now() else atlas.feed_heartbeat.last_change_at end,\n' +
    '  last_release_token = excluded.last_release_token,\n' +
    '  last_row_count    = excluded.last_row_count,\n' +
    "  last_status       = 'ok',\n" +
    '  last_error        = null,\n' +
    '  updated_at        = now();\n'
  );
}
