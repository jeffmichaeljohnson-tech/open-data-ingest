/**
 * sql.ts — pure SQL emitters for the UNHCR observation rows.
 *
 * Kept separate from unhcr.ts (fetch/transform core) and index.ts (runtime shell)
 * because generating an INSERT is a distinct, deterministic, testable concern — and
 * because the ROLLED-BACK proof harness needs exactly this without pulling in the
 * Deno-serve entrypoint. No I/O here; every function returns a string.
 *
 * WHY ON CONFLICT DO NOTHING, NOT UPSERT. The design is append-only: the vintage
 * natural key (indicator, area_type, area_code, ref_period, source, release_version)
 * makes a re-ingest of the SAME release a no-op (idempotent) and a NEW
 * release_version an INSERT of a new row (history preserved). Because UNHCR's
 * release_version is a content hash of the source numbers, a re-fetch of identical
 * data reuses the same hash and does nothing, while any restated number produces a
 * new hash and a new row — so history is never overwritten.
 */
import type { ObservationRecord } from './unhcr.ts';

/** A single SQL literal for a nullable value (numbers unquoted, strings escaped). */
function lit(v: string | number | null): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + v.replace(/'/g, "''") + "'";
}

/** The atlas.observation columns we populate, in a fixed order. */
const OBSERVATION_COLS = [
  'indicator',
  'area_type',
  'area_code',
  'ref_period',
  'value',
  'unit',
  'agg_method',
  'denominator_indicator',
  'denominator_value',
  'source',
  'source_dataset',
  'release_version',
  'reference_year',
  'source_published_at',
  'retrieved_at',
  'licence_key',
  'feed_key',
] as const;

function rowValues(r: ObservationRecord): string {
  return (
    '(' +
    [
      lit(r.indicator),
      lit(r.area_type),
      lit(r.area_code),
      lit(r.ref_period),
      lit(r.value),
      lit(r.unit),
      lit(r.agg_method),
      lit(r.denominator_indicator),
      lit(r.denominator_value),
      lit(r.source),
      lit(r.source_dataset),
      lit(r.release_version),
      lit(r.reference_year),
      r.source_published_at === null ? 'NULL' : lit(r.source_published_at) + '::timestamptz',
      lit(r.retrieved_at) + '::timestamptz',
      lit(r.licence_key),
      lit(r.feed_key),
    ].join(', ') +
    ')'
  );
}

/**
 * Build ONE multi-row INSERT ... ON CONFLICT DO NOTHING for the given records.
 * Optionally override release_version and source_published_at, which the proof
 * harness uses to simulate a LATER UNHCR restatement of the same years — the case
 * that must create new rows, not overwrite.
 */
export function buildObservationInsert(
  records: ObservationRecord[],
  overrides?: { releaseVersion?: string; sourcePublishedAt?: string | null },
): string {
  if (records.length === 0) return '-- (no observation records to insert)\n';
  const effective = records.map((r) => ({
    ...r,
    release_version: overrides?.releaseVersion ?? r.release_version,
    source_published_at: overrides?.sourcePublishedAt !== undefined ? overrides.sourcePublishedAt : r.source_published_at,
  }));
  const values = effective.map(rowValues).join(',\n  ');
  return (
    `insert into atlas.observation (${OBSERVATION_COLS.join(', ')})\nvalues\n  ` +
    values +
    `\non conflict on constraint observation_vintage_natural_key do nothing;\n`
  );
}
