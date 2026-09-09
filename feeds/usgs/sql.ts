/**
 * sql.ts — pure SQL emitters for the USGS event rows.
 *
 * Kept separate from usgs.ts (fetch/transform core) and index.ts (runtime shell)
 * because generating an INSERT is a distinct, deterministic, testable concern — and
 * because the ROLLED-BACK proof harness needs exactly this without pulling in the
 * Deno-serve entrypoint. No I/O here; every function returns a string.
 *
 * WHY ON CONFLICT DO NOTHING, NOT UPSERT. The design is append-only. atlas.event's
 * natural key is `event_dedup UNIQUE (feed_key, external_id)` (verified live
 * 2026-08-17). USGS gives each quake a stable id (e.g. 'us6000tlbz'), so a re-ingest
 * of the same overlapping window is a no-op (idempotent) and only genuinely new
 * quakes are inserted. An UPDATE-on-conflict would let a later poll rewrite a quake's
 * recorded values; DO NOTHING keeps the first landing authoritative, which is what
 * makes re-running the ingest safe.
 *
 * WHAT WE DO NOT INSERT. The attribution columns (attribution_level, pip_iso_a3,
 * disputed_name, continent_m49, public_country_iso_a3) are set by the atlas.event
 * BEFORE INSERT trigger from the geom — a hand-set value is overwritten. So this
 * emitter never names them. We supply geom via public.ST_SetSRID(public.ST_MakePoint(
 * lon, lat), 4326) — fully qualified so it resolves regardless of the session
 * search_path — and let the server attribute it (including the border-buffer rule).
 *
 * MAGNITUDE_SCALE is included. It is the additive column proposed in
 * PROPOSED_20260817300000_usgs_atlas_wiring.sql.txt; the INSERT names it so the true
 * scale (mb/mww/ml/…) is preserved in the DB and not flattened into 'richter'. That
 * migration is therefore a PREREQUISITE of --apply (see scripts/ingest-usgs.sh).
 */
import type { EventRecord } from './usgs.ts';

/** A single SQL literal for a nullable value (numbers unquoted, strings escaped). */
function lit(v: string | number | null): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + v.replace(/'/g, "''") + "'";
}

/** The atlas.event columns we populate, in a fixed order. Attribution columns are
 *  ABSENT on purpose — the trigger owns them. */
const EVENT_COLS = [
  'feed_key',
  'external_id',
  'event_type',
  'occurred_at',
  'geom',
  'magnitude',
  'magnitude_kind',
  'magnitude_scale',
  'source',
  'release_version',
  'retrieved_at',
  'licence_key',
] as const;

function rowValues(r: EventRecord): string {
  // occurred_at / retrieved_at are ISO strings cast to timestamptz. geom is built
  // server-side from lon/lat, fully qualified so search_path cannot matter.
  return (
    '(' +
    [
      lit(r.feed_key),
      lit(r.external_id),
      lit(r.event_type),
      lit(r.occurred_at) + '::timestamptz',
      `public.ST_SetSRID(public.ST_MakePoint(${lit(r.lon)}, ${lit(r.lat)}), 4326)`,
      lit(r.magnitude),
      lit(r.magnitude_kind),
      lit(r.magnitude_scale),
      lit(r.source),
      lit(r.release_version),
      lit(r.retrieved_at) + '::timestamptz',
      lit(r.licence_key),
    ].join(', ') +
    ')'
  );
}

/**
 * Build ONE multi-row INSERT ... ON CONFLICT DO NOTHING for the given events.
 * Optionally override external_id with a suffix, which the proof harness uses to
 * simulate genuinely NEW quakes (distinct natural keys) landing on a second run.
 */
export function buildEventInsert(records: EventRecord[], overrides?: { idSuffix?: string }): string {
  if (records.length === 0) return '-- (no event records to insert)\n';
  const effective = overrides?.idSuffix ? records.map((r) => ({ ...r, external_id: r.external_id + overrides.idSuffix })) : records;
  const values = effective.map(rowValues).join(',\n  ');
  return (
    `insert into atlas.event (${EVENT_COLS.join(', ')})\nvalues\n  ` +
    values +
    `\non conflict on constraint event_dedup do nothing;\n`
  );
}

/**
 * Idempotent seed of the USGS public-domain licence row. atlas.event.licence_key is
 * an FK into atlas.source_licence, so this must exist before any event lands. Terms
 * verified live 2026-08-17 against the USGS copyrights page (HTTP 200): USGS content
 * is in the U.S. Public Domain; attribution is a courtesy, not a legal requirement.
 */
export function buildLicenceSeed(): string {
  return (
    'insert into atlas.source_licence ' +
    '(licence_key, label, spdx, url, attribution_required, attribution_text, share_alike, non_commercial, verified, verified_at, notes)\n' +
    "values ('usgs_pd', 'U.S. Government Public Domain (USGS)', null, " +
    "'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits', " +
    "false, 'U.S. Geological Survey', false, false, true, '2026-08-17', " +
    "'USGS earthquake data are U.S. Government works in the U.S. Public Domain. Courtesy credit to USGS is requested but not legally required. Verified live 2026-08-17 (HTTP 200).')\n" +
    'on conflict (licence_key) do nothing;\n'
  );
}

/**
 * Idempotent seed of the atlas.feed registry row for usgs_quakes. Both
 * atlas.event.feed_key and atlas.feed_heartbeat.feed_key are FKs into atlas.feed, so
 * this row must exist before any event or heartbeat lands. The values mirror the
 * FeedRegistryEntry in supabase/functions/_shared/feedRegistry.ts.
 */
export function buildFeedSeed(): string {
  return (
    'insert into atlas.feed ' +
    '(feed_key, display_name, clock, source_url, licence_key, cadence_hours, max_staleness_hours, change_detection, requires_browser_ua, requires_token, active, notes)\n' +
    "values ('usgs_quakes', 'USGS Earthquakes (M4.5+, past day)', 'event', " +
    "'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson', " +
    "'usgs_pd', 1, 3, 'row_high_water', true, false, true, " +
    "'metadata.generated is the row_high_water change token. M4.5+ past-day window: globally-felt quakes, self-healing 24h window. Attribution is server-side PIP via the atlas.event trigger; the feed supplies only geom.')\n" +
    'on conflict (feed_key) do nothing;\n'
  );
}

/**
 * Upsert the two-clock heartbeat after a landed ingest. On an accepted load this
 * advances BOTH clocks (last_success_at = our pipeline ran; last_change_at = the
 * source published), records the release token and the row count, and sets
 * last_status='ok'. Written from ACTUAL data landing, never from a scheduler row —
 * the false-green cron this repo hit for six months.
 */
export function buildHeartbeatUpsert(opts: {
  feedKey: string;
  releaseToken: string;
  rowCount: number;
  now: string;
}): string {
  return (
    'insert into atlas.feed_heartbeat ' +
    '(feed_key, last_success_at, last_change_at, last_release_token, last_row_count, last_status, last_error, updated_at)\n' +
    `values (${lit(opts.feedKey)}, ${lit(opts.now)}::timestamptz, ${lit(opts.now)}::timestamptz, ` +
    `${lit(opts.releaseToken)}, ${lit(opts.rowCount)}, 'ok', null, ${lit(opts.now)}::timestamptz)\n` +
    'on conflict (feed_key) do update set\n' +
    '  last_success_at = excluded.last_success_at,\n' +
    '  last_change_at = excluded.last_change_at,\n' +
    '  last_release_token = excluded.last_release_token,\n' +
    '  last_row_count = excluded.last_row_count,\n' +
    '  last_status = excluded.last_status,\n' +
    '  last_error = null,\n' +
    '  updated_at = excluded.updated_at;\n'
  );
}
