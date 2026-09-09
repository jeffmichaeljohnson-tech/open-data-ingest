/**
 * worldbank.ts — the PURE core of the World Bank reference-indicator feed.
 *
 * This is the "no I/O" half, deliberately split from index.ts (which does the
 * fetch + database write) for the same reason feedRegistry.ts is pure: everything
 * here — parsing a World Bank page, mapping a country code to iso_a3 through the
 * crosswalk, deciding sum-vs-weighted-mean, emitting the vintage-carrying
 * observation record, and building the content-hashed R2 snapshot — is testable
 * with NO network and NO database. index.ts is the thin shell that calls it.
 *
 * WHY THIS FEED IS DIFFERENT FROM THE EVENT FEEDS. Quakes and fires arrive as
 * coordinates and get point-in-polygon'd into a country. World Bank arrives
 * already keyed by a COUNTRY CODE, so there is no PIP — attribution is a lookup
 * through atlas.country.wb_code. That join is the ONLY correct way to reach
 * iso_a3: matching on the country NAME would silently mis-map (World Bank's
 * "Congo, Dem. Rep." vs a crosswalk "Democratic Republic of the Congo", "Korea,
 * Rep." vs "South Korea", and dozens more), and matching on countryiso3code
 * DIRECTLY would attribute World Bank's AGGREGATE rows — "Arab World" (ARB),
 * "Africa Eastern and Southern" (AFE), "World" (WLD) — as if they were countries.
 * The crosswalk carries no wb_code for those aggregates, so joining through it
 * drops them by construction. Verified live 2026-08-17 that country/all returns
 * these aggregate rows interleaved with real countries.
 *
 * THE VINTAGE IS THE POINT. World Bank exposes a page-level `lastupdated` date
 * (verified live 2026-08-17: "2026-07-13" on both SP.POP.TOTL and EG.ELC.ACCS.ZS).
 * That is a real release/vintage token, not a guess — it is what distinguishes the
 * July 2026 vintage of "USA population 2024" from a later restatement of the same
 * year. It becomes release_version in the natural key, so a restated year lands as
 * a NEW ROW instead of overwriting history (a "Frankenstein trend" of two
 * vintages). If World Bank had exposed no such token we would have had to say so
 * and fall back to a content hash; it does, so we use it.
 *
 * THE INTENSIVE/EXTENSIVE DISTINCTION IS STRUCTURAL, NOT ADVISORY. Population is
 * EXTENSIVE — a continent's population is the sum of its countries', so
 * agg_method='sum'. Electricity-access-percent is INTENSIVE — you cannot add
 * Nigeria's 60% to Ghana's 86% and get a continent figure; you must recompute a
 * population-weighted mean. So it is agg_method='weighted_mean' and MUST carry its
 * denominator (that country's population) so the rollup view can recompute rather
 * than add. atlas.observation has a CHECK that rejects agg_method='sum' on an
 * intensive unit; this module sets the two correctly, and the proof harness shows
 * the CHECK catching a deliberately-wrong row.
 */

// ===========================================================================
// TYPES
// ===========================================================================

/** One raw World Bank observation row (the shape inside the response's 2nd element). */
export interface WorldBankRow {
  indicator: { id: string; value: string };
  country: { id: string; value: string };
  countryiso3code: string;
  date: string; // the reference period, e.g. "2024"
  value: number | null; // null is World Bank's "no observation for this cell"
  unit: string;
  obs_status: string;
  decimal: number;
}

/** The page-level metadata World Bank returns as the FIRST element of the array. */
export interface WorldBankPageMeta {
  page: number;
  pages: number;
  per_page: number | string;
  total: number;
  sourceid?: string;
  /** THE vintage token. The release date of this data. Drives release_version. */
  lastupdated?: string;
}

/** A parsed World Bank response: page metadata + the row array (or null = no data). */
export interface ParsedWorldBankResponse {
  meta: WorldBankPageMeta;
  rows: WorldBankRow[] | null;
}

/**
 * How one World Bank indicator maps into an atlas.observation. The unit and
 * agg_method are the load-bearing fields: they are what keeps a percentage from
 * being summed into a nonsense continent total.
 */
export interface WbIndicatorConfig {
  /** World Bank indicator code, e.g. 'SP.POP.TOTL'. Becomes source_dataset. */
  wbIndicator: string;
  /** our indicator name, e.g. 'population_total'. Becomes observation.indicator. */
  observationIndicator: string;
  /** observation.unit — 'people' (extensive) or 'percent' (intensive). */
  unit: string;
  /**
   * How this indicator aggregates to a continent:
   *   'sum'           extensive (population). Summable.
   *   'weighted_mean' intensive but recomputable IF a denominator is stored.
   *   'none'          not aggregable (a median/index) — continent value omitted.
   */
  aggMethod: 'sum' | 'weighted_mean' | 'none';
  /** required when aggMethod='weighted_mean': the indicator that weights the mean. */
  denominatorIndicator?: string;
}

/** The two indicators this feed ships, confirmed live against the World Bank API. */
export const POPULATION_TOTAL: WbIndicatorConfig = {
  wbIndicator: 'SP.POP.TOTL',
  observationIndicator: 'population_total',
  unit: 'people', // extensive: a continent's people is the SUM of its countries'
  aggMethod: 'sum',
};

export const ELECTRICITY_ACCESS_PCT: WbIndicatorConfig = {
  wbIndicator: 'EG.ELC.ACCS.ZS',
  observationIndicator: 'electricity_access_pct',
  unit: 'percent', // intensive: NEVER summed. Recomputed as a population-weighted mean.
  aggMethod: 'weighted_mean',
  denominatorIndicator: 'population_total',
};

/** One crosswalk entry, the minimum this module needs to attribute a row. */
export interface CrosswalkEntry {
  iso_a3: string;
  m49_macro_region_code: number | null;
}

/**
 * A fully-formed atlas.observation row, every vintage column populated. The field
 * names match the table columns so index.ts / the proof harness can insert without
 * a second mapping step. `value` may be null only in the sense World Bank means it
 * (no data) — but we SKIP null-value rows rather than store them here, so in
 * practice value is always a number in an emitted record.
 */
export interface ObservationRecord {
  indicator: string;
  area_type: 'country';
  area_code: string; // iso_a3
  ref_period: string; // '2024'
  value: number;
  unit: string;
  agg_method: 'sum' | 'weighted_mean' | 'none';
  denominator_indicator: string | null;
  denominator_value: number | null;
  source: string;
  source_dataset: string; // the World Bank indicator code
  release_version: string; // World Bank `lastupdated`
  reference_year: number;
  source_published_at: string | null;
  retrieved_at: string;
  licence_key: string;
}

/** Why a World Bank row did NOT become an observation — kept for transparency. */
export interface SkipRecord {
  countryiso3code: string;
  country: string;
  date: string;
  reason:
    | 'aggregate_or_unmapped' // no crosswalk wb_code — a World Bank aggregate or a territory we do not map
    | 'null_value' // World Bank has no observation for this cell
    | 'missing_denominator'; // weighted_mean row with no population to weight it — cannot recompute, so not stored
}

export interface TransformResult {
  records: ObservationRecord[];
  skipped: SkipRecord[];
}

// ===========================================================================
// PARSING — separate a real World Bank page from the many ways it returns a 200
// that is not data. (The garbage guard in feedRegistry.ts does the row-level
// validation; this only gets the response into the shape that guard expects.)
// ===========================================================================

/**
 * Parse a World Bank JSON response body. A valid response is a 2-element array:
 * [ pageMeta, rowsArrayOrNull ]. World Bank signals "no data" by returning null
 * as the second element (NOT an empty array in every case), and signals an ERROR
 * by returning `[ { message: [ { id, key, value } ] } ]` — a 1-element array whose
 * only element carries a `message`. Both are the NORMAL failure here, so both are
 * detected rather than allowed to throw deep in the transform.
 *
 * Throws on a shape it cannot make sense of, with the offending shape named, so a
 * caller's catch can record a real reason instead of a stack trace.
 */
export function parseWorldBankResponse(body: unknown): ParsedWorldBankResponse {
  if (!Array.isArray(body)) {
    throw new Error(
      `World Bank response is not an array (got ${body === null ? 'null' : typeof body}) — likely an HTML error page or a WAF block`,
    );
  }
  // Error shape: [{ message: [...] }]
  const first = body[0] as Record<string, unknown> | undefined;
  if (first && Array.isArray((first as { message?: unknown }).message)) {
    const msg = (first as { message: Array<{ value?: string }> }).message
      .map((m) => m.value ?? '')
      .join('; ');
    throw new Error(`World Bank returned an API error: ${msg}`);
  }
  if (body.length < 2) {
    throw new Error(`World Bank response has ${body.length} element(s), expected 2 (meta, rows)`);
  }
  const meta = body[0] as WorldBankPageMeta;
  const rows = body[1] as WorldBankRow[] | null;
  if (rows !== null && !Array.isArray(rows)) {
    throw new Error(`World Bank response's second element is neither an array nor null (${typeof rows})`);
  }
  return { meta, rows };
}

/** Build a wb_code -> crosswalk lookup from the crosswalk rows. */
export function buildCrosswalkIndex(
  rows: Array<{ iso_a3: string; wb_code: string | null; m49_macro_region_code: number | null }>,
): Map<string, CrosswalkEntry> {
  const idx = new Map<string, CrosswalkEntry>();
  for (const r of rows) {
    // Only rows that actually carry a wb_code participate in the join. A crosswalk
    // row with an empty wb_code (a territory World Bank does not report separately)
    // is intentionally absent from the index, so World Bank never resolves to it.
    if (r.wb_code && r.wb_code.trim() !== '') {
      idx.set(r.wb_code.trim(), { iso_a3: r.iso_a3, m49_macro_region_code: r.m49_macro_region_code });
    }
  }
  return idx;
}

// ===========================================================================
// TRANSFORM — World Bank rows -> vintage-carrying observation records.
// ===========================================================================

export interface TransformOptions {
  crosswalk: Map<string, CrosswalkEntry>;
  /** World Bank `lastupdated`. The vintage. Required — no number without it. */
  releaseVersion: string;
  /** the instant we consider this release published (usually `lastupdated`). */
  sourcePublishedAt: string | null;
  /** ISO-8601 instant WE fetched the data. */
  retrievedAt: string;
  /** licence_key registered in atlas.source_licence, e.g. 'cc_by_4'. */
  licenceKey: string;
  /**
   * iso_a3 -> value of the denominator indicator. REQUIRED when the config is a
   * weighted_mean (electricity): a percentage with no population to weight it
   * cannot be recomputed at the continent, so such a row is SKIPPED, not stored
   * with a null denominator (the CHECK would reject it anyway — we skip it
   * honestly rather than let it error).
   */
  denominatorByIso?: Map<string, number>;
}

/**
 * Map one indicator's World Bank rows into observation records, attributing each
 * to iso_a3 THROUGH the crosswalk's wb_code (never by name, never by trusting the
 * raw code — see the file header for why). Rows that do not map to a country, or
 * carry no value, or (for a weighted mean) have no denominator, are collected in
 * `skipped` with their reason rather than silently dropped.
 */
export function transformWorldBankRows(
  cfg: WbIndicatorConfig,
  rows: WorldBankRow[],
  opts: TransformOptions,
): TransformResult {
  const records: ObservationRecord[] = [];
  const skipped: SkipRecord[] = [];

  for (const row of rows) {
    const entry = opts.crosswalk.get(row.countryiso3code);
    if (!entry) {
      // No wb_code match: a World Bank aggregate (ARB, AFE, WLD, income groups) or
      // a territory we do not map. Dropping it is the correct behaviour; recording
      // it makes "why is my country count ~200 not 265" answerable.
      skipped.push({
        countryiso3code: row.countryiso3code,
        country: row.country.value,
        date: row.date,
        reason: 'aggregate_or_unmapped',
      });
      continue;
    }

    if (row.value === null || row.value === undefined) {
      skipped.push({
        countryiso3code: row.countryiso3code,
        country: row.country.value,
        date: row.date,
        reason: 'null_value',
      });
      continue;
    }

    let denominatorValue: number | null = null;
    if (cfg.aggMethod === 'weighted_mean') {
      const denom = opts.denominatorByIso?.get(entry.iso_a3);
      if (denom === undefined || denom === null) {
        // A weighted mean with no weight cannot be recomputed at the continent.
        // The observation CHECK would reject a null denominator; we skip honestly.
        skipped.push({
          countryiso3code: row.countryiso3code,
          country: row.country.value,
          date: row.date,
          reason: 'missing_denominator',
        });
        continue;
      }
      denominatorValue = denom;
    }

    const referenceYear = Number.parseInt(row.date, 10);
    records.push({
      indicator: cfg.observationIndicator,
      area_type: 'country',
      area_code: entry.iso_a3,
      ref_period: row.date,
      value: row.value,
      unit: cfg.unit,
      agg_method: cfg.aggMethod,
      denominator_indicator: cfg.aggMethod === 'weighted_mean' ? (cfg.denominatorIndicator ?? null) : null,
      denominator_value: denominatorValue,
      source: 'World Bank',
      source_dataset: cfg.wbIndicator,
      release_version: opts.releaseVersion,
      reference_year: Number.isFinite(referenceYear) ? referenceYear : 0,
      source_published_at: opts.sourcePublishedAt,
      retrieved_at: opts.retrievedAt,
      licence_key: opts.licenceKey,
    });
  }

  return { records, skipped };
}

/** Build an iso_a3 -> value map from population records, to weight the electricity mean. */
export function denominatorMapFromRecords(records: ObservationRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of records) m.set(r.area_code, r.value);
  return m;
}

// ===========================================================================
// THE R2-SHAPED SNAPSHOT — content-hashed, every number carrying its vintage.
// ===========================================================================

/** One number in the snapshot, with its full provenance travelling alongside it. */
export interface SnapshotObservation {
  indicator: string;
  area_code: string;
  ref_period: string;
  reference_year: number;
  value: number;
  unit: string;
  agg_method: string;
  // vintage — no number without it
  source: string;
  source_dataset: string;
  release_version: string;
  source_published_at: string | null;
  retrieved_at: string;
}

export interface Snapshot {
  schema_version: string;
  feed_key: string;
  source: string;
  license_key: string;
  /** when this snapshot artifact was built. */
  generated_at: string;
  /** the release(s) of source data represented, for a fast staleness read. */
  release_versions: string[];
  observation_count: number;
  observations: SnapshotObservation[];
  /** sha256 of the canonical JSON of everything above (this field excluded). */
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
 * Build the R2-shaped snapshot from observation records.
 *
 * THE HASH ADDRESSES THE DATA, NOT THE CLOCK. content_hash is computed over the
 * canonical (sorted-key) JSON of the DATA-AND-VINTAGE fields only — indicator,
 * area, period, value, unit, agg_method, source, dataset, release_version,
 * source_published_at. The two WALL-CLOCK fields (generated_at and each
 * observation's retrieved_at) are deliberately EXCLUDED from the hash, so two runs
 * over identical World Bank data at different times produce the SAME hash. That is
 * the property that makes the artifact genuinely content-addressed and lets it feed
 * the feedRegistry `content_hash` change strategy: a hash change means the DATA
 * changed, never merely that the clock advanced. retrieved_at still travels on
 * every observation (the task requires retrieval time on every number) — it just
 * does not perturb the identity of the content.
 *
 * Observations are sorted by (indicator, area_code, reference_year,
 * release_version) so row order never perturbs the hash. Every emitted number
 * carries source, reference year, release version and retrieval time; there is
 * deliberately no code path that emits a bare value.
 */
export async function buildSnapshot(
  records: ObservationRecord[],
  meta: SnapshotMeta,
): Promise<Snapshot> {
  const observations: SnapshotObservation[] = records
    .map((r) => ({
      indicator: r.indicator,
      area_code: r.area_code,
      ref_period: r.ref_period,
      reference_year: r.reference_year,
      value: r.value,
      unit: r.unit,
      agg_method: r.agg_method,
      source: r.source,
      source_dataset: r.source_dataset,
      release_version: r.release_version,
      source_published_at: r.source_published_at,
      retrieved_at: r.retrieved_at,
    }))
    .sort(
      (a, b) =>
        a.indicator.localeCompare(b.indicator) ||
        a.area_code.localeCompare(b.area_code) ||
        a.reference_year - b.reference_year ||
        a.release_version.localeCompare(b.release_version),
    );

  const releaseVersions = Array.from(new Set(observations.map((o) => o.release_version))).sort();

  // The hashable CORE: data + vintage, but NOT wall-clock. retrieved_at is dropped
  // per observation here (it stays in the emitted artifact below); generated_at is
  // never in the core at all.
  const hashCore = {
    schema_version: 'atlas.snapshot.v1',
    feed_key: meta.feedKey,
    source: 'World Bank',
    license_key: meta.licenceKey,
    release_versions: releaseVersions,
    observation_count: observations.length,
    observations: observations.map(({ retrieved_at: _omit, ...rest }) => rest),
  };
  const content_hash = await sha256Hex(canonicalJson(hashCore));

  return {
    schema_version: 'atlas.snapshot.v1',
    feed_key: meta.feedKey,
    source: 'World Bank',
    license_key: meta.licenceKey,
    generated_at: meta.generatedAt,
    release_versions: releaseVersions,
    observation_count: observations.length,
    observations,
    content_hash,
  };
}
