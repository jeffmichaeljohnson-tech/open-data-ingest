/**
 * unhcr.ts — the PURE core of the UNHCR forced-displacement feed.
 *
 * This is the "no I/O" half, split from index.ts (fetch + database write) for the
 * same reason worldbank.ts is split: everything here — parsing a UNHCR population
 * page, coercing its mixed string/number counts, joining a country-of-origin code
 * to iso_a3 THROUGH the crosswalk, emitting the vintage-carrying observation
 * records, and building the content-hashed R2 snapshot — is testable with NO
 * network and NO database. index.ts is the thin shell that calls it.
 *
 * WHY THIS FEED LOOKS LIKE WORLD BANK, NOT LIKE THE EVENT FEEDS. Displacement is a
 * STOCK — a count of people, by country and year — exactly like population, not a
 * point event like a quake. It carries no coordinate, no instant, no per-incident
 * identity. So it lands in atlas.observation (bitemporal, append-only, agg_method-
 * driven rollup), never atlas.event (which exists for coordinate/point events that
 * get point-in-polygon'd, or UCDP conflict events keyed on occurred_at). Putting a
 * country-year statistic into atlas.event would break every rollup by construction.
 *
 * EVERY MEASURE HERE IS EXTENSIVE. Refugees, asylum-seekers and internally
 * displaced people are COUNTS: a continent's total is the sum of its countries', so
 * agg_method='sum' for all of them and no denominator is needed. This feed stores
 * NO rate — deliberately. The intensive/extensive trap (summing a percentage into a
 * nonsense continent total) cannot occur here because nothing is a percentage. A
 * per-capita "displaced as a share of population" figure would be intensive and is
 * therefore left to a query-time recompute from two extensive indicators (displaced
 * ÷ population), never stored as a summable rate. (See the file tail for the exact
 * indicator list and what is deliberately excluded.)
 *
 * THE JOIN IS THROUGH THE CROSSWALK, VERIFIED — NOT ASSUMED. UNHCR keys its
 * country-of-origin rows on `coo_iso`. Measured live 2026-08-17 against the real
 * crosswalk: 204 of 207 distinct 2024 origin codes resolve to a crosswalk iso_a3,
 * and the 3 that do NOT — TIB (Tibetan), UNK (Unknown), XXA (Stateless) — are
 * non-country aggregates that MUST be dropped, exactly like World Bank's ARB/WLD.
 * So `coo_iso` IS ISO 3166-1 alpha-3 for real countries, and joining through the
 * crosswalk's iso_a3 drops the non-country codes by construction (0.287% of
 * displaced people, all genuinely unattributable). A row whose coo_iso does not
 * resolve is recorded in `skipped`, never silently discarded.
 *
 * ABSENCE IS NOT ZERO. A country present in the response with a real 0 (no refugees
 * originate from it) is DATA and is stored as 0. A country ABSENT from the response
 * is UNKNOWN and gets no row at all. The two are different facts and this module
 * keeps them different: it stores genuine zeros and never fabricates a row for a
 * country the source did not report.
 *
 * NO CAUSE, NO BLAME. Counts are reported as UNHCR publishes them — "people whose
 * country of origin is X", "people internally displaced within X". Nothing here
 * asserts who or what caused a displacement; the data does not carry that and
 * neither does this code.
 */

// ===========================================================================
// TYPES
// ===========================================================================

/**
 * One raw UNHCR population row (the shape inside the response's `items` array,
 * with `coo_all=true`, i.e. grouped by country of origin). Numeric fields arrive
 * as EITHER a number OR a numeric string ("0", "6403144") — verified across the
 * full 2024/2025 datasets — so every count is coerced, never read raw.
 */
export interface UnhcrPopulationRow {
  year: number;
  coo_id: number | string;
  coo_name: string;
  coo: string;
  /** country-of-origin ISO 3166-1 alpha-3 (verified to be iso_a3 for real countries). */
  coo_iso: string;
  coa_iso: string;
  /** forcibly displaced components — number | numeric-string. */
  refugees: number | string;
  asylum_seekers: number | string;
  idps: number | string;
  /** carried for completeness; NOT ingested (stateless people are not necessarily displaced). */
  stateless?: number | string;
  returned_refugees?: number | string;
  returned_idps?: number | string;
  ooc?: number | string;
  /** "other people in need of international protection" — usually "-" in this dataset. */
  oip?: number | string;
  hst?: number | string;
  [k: string]: unknown;
}

/** A parsed UNHCR response: the population rows, already checked to be an array. */
export interface ParsedUnhcrResponse {
  page: number;
  maxPages: number;
  items: UnhcrPopulationRow[];
}

/** One crosswalk entry, the minimum this module needs to attribute a row. */
export interface CrosswalkEntry {
  iso_a3: string;
  m49_macro_region_code: number | null;
}

/**
 * A fully-formed atlas.observation row, every vintage column populated. The field
 * names match the table columns so index.ts / the CLI / the proof harness can
 * insert without a second mapping step.
 */
export interface ObservationRecord {
  indicator: string;
  area_type: 'country';
  area_code: string; // iso_a3
  ref_period: string; // '2024'
  value: number;
  unit: string; // 'people' — extensive
  agg_method: 'sum' | 'weighted_mean' | 'none';
  denominator_indicator: string | null;
  denominator_value: number | null;
  source: string; // 'UNHCR'
  source_dataset: string; // the UNHCR series this measure comes from
  release_version: string; // a content hash of the source dataset (UNHCR exposes no release token)
  reference_year: number;
  source_published_at: string | null;
  retrieved_at: string;
  licence_key: string;
  feed_key: string;
}

/** Why a UNHCR row (or one of its measures) did NOT become an observation. */
export interface SkipRecord {
  coo_iso: string;
  coo_name: string;
  year: number;
  indicator: string | null; // null when the WHOLE row was dropped (no country match)
  reason:
    | 'aggregate_or_unmapped' // coo_iso has no crosswalk iso_a3 — TIB/UNK/XXA and the like
    | 'null_value' // this measure is null/missing for this country-year (a known-unknown, not a zero)
    | 'incomplete_composite'; // a component of the forcibly-displaced total is missing, so the total is not computable
}

export interface TransformResult {
  records: ObservationRecord[];
  skipped: SkipRecord[];
}

// ===========================================================================
// INDICATORS — every one an EXTENSIVE count of people (agg_method='sum').
//
// `field` names the raw UNHCR measure the count is read from; `derived` marks the
// forcibly-displaced composite that is summed from three components rather than
// read from one field. `source_dataset` records the exact provenance so a number
// can always be traced back to the UNHCR series it came from.
// ===========================================================================

export interface UnhcrIndicatorConfig {
  /** our indicator name, e.g. 'refugees_origin'. Becomes observation.indicator. */
  observationIndicator: string;
  /** the raw UNHCR field this reads (null for the derived composite). */
  field: keyof UnhcrPopulationRow | null;
  /** observation.source_dataset — the traceable UNHCR series id. */
  sourceDataset: string;
}

/** Refugees whose country of origin is this country. */
export const REFUGEES_ORIGIN: UnhcrIndicatorConfig = {
  observationIndicator: 'refugees_origin',
  field: 'refugees',
  sourceDataset: 'population.refugees[coo]',
};

/** Asylum-seekers whose country of origin is this country. */
export const ASYLUM_SEEKERS_ORIGIN: UnhcrIndicatorConfig = {
  observationIndicator: 'asylum_seekers_origin',
  field: 'asylum_seekers',
  sourceDataset: 'population.asylum_seekers[coo]',
};

/** People internally displaced within this country (origin IS location for IDPs). */
export const IDPS: UnhcrIndicatorConfig = {
  observationIndicator: 'idps',
  field: 'idps',
  sourceDataset: 'population.idps[coo]',
};

/**
 * The headline "people who have been displaced" figure: refugees + asylum-seekers
 * + IDPs originating from / within this country. A UNHCR-standard composite,
 * computed transparently from the three components above (each also stored), so a
 * reader can always see the parts. Deliberately EXCLUDES stateless persons (not
 * necessarily displaced), returnees (no longer displaced), and OIP (not populated
 * in this dataset) — see the file tail.
 */
export const FORCIBLY_DISPLACED: UnhcrIndicatorConfig = {
  observationIndicator: 'forcibly_displaced_origin',
  field: null, // derived
  sourceDataset: 'population.refugees+asylum_seekers+idps[coo]',
};

/** The four indicators this feed ships, in emit order. */
export const UNHCR_INDICATORS: readonly UnhcrIndicatorConfig[] = [
  REFUGEES_ORIGIN,
  ASYLUM_SEEKERS_ORIGIN,
  IDPS,
  FORCIBLY_DISPLACED,
];

/** The three components summed into the forcibly-displaced composite. */
const COMPOSITE_FIELDS: readonly (keyof UnhcrPopulationRow)[] = ['refugees', 'asylum_seekers', 'idps'];

// ===========================================================================
// PARSING — separate a real UNHCR page from the many ways it returns a 200 that
// is not data. (Row-level count validation is below; this only gets the response
// into the shape the transform expects, throwing on a shape it does not recognise.)
// ===========================================================================

/**
 * Parse a UNHCR population response body. A valid response is an OBJECT carrying an
 * `items` array; the API returns a bare object with a `message` (and no `items`)
 * for the welcome root and for parameter errors, and a WAF/HTML block is not an
 * object at all. Both are the NORMAL failure here, so both are detected and THROWN
 * with the offending shape named — never allowed to fall through and return zero
 * rows, which would read as "no displacement anywhere", the worst possible lie.
 */
export function parseUnhcrResponse(body: unknown): ParsedUnhcrResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(
      `UNHCR response is not an object (got ${body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body}) — likely an HTML/WAF error page`,
    );
  }
  const obj = body as Record<string, unknown>;
  if (!('items' in obj)) {
    const message = typeof obj.message === 'string' ? `: ${obj.message}` : '';
    throw new Error(`UNHCR response has no 'items' array — likely the API root or a parameter error${message}`);
  }
  if (!Array.isArray(obj.items)) {
    throw new Error(`UNHCR response 'items' is not an array (${typeof obj.items}) — schema drift`);
  }
  return {
    page: typeof obj.page === 'number' ? obj.page : 1,
    maxPages: typeof obj.maxPages === 'number' ? obj.maxPages : 1,
    items: obj.items as UnhcrPopulationRow[],
  };
}

/**
 * Build an iso_a3 -> crosswalk lookup. UNHCR joins on iso_a3 DIRECTLY (its coo_iso
 * IS ISO 3166-1 alpha-3 for real countries — verified live), so the index is keyed
 * by iso_a3 and a coo_iso that is not a real country (TIB/UNK/XXA) simply never
 * finds a match and is dropped by construction.
 */
export function buildCrosswalkIndex(
  rows: Array<{ iso_a3: string; m49_macro_region_code: number | null }>,
): Map<string, CrosswalkEntry> {
  const idx = new Map<string, CrosswalkEntry>();
  for (const r of rows) {
    if (r.iso_a3 && r.iso_a3.trim() !== '') {
      idx.set(r.iso_a3.trim(), { iso_a3: r.iso_a3.trim(), m49_macro_region_code: r.m49_macro_region_code });
    }
  }
  return idx;
}

// ===========================================================================
// COUNT COERCION — mixed string/number, and the deliberate throw-vs-skip line.
// ===========================================================================

/**
 * The outcome of reading one UNHCR count field:
 *   • { kind: 'number' }  a real, finite count (INCLUDING a genuine 0 — that is data).
 *   • { kind: 'missing' } the field is null/undefined — a known-unknown for this cell.
 *                         The measure is SKIPPED (reason 'null_value'), never stored as
 *                         a fake zero, so absence never reads as "no displacement".
 * A value that is neither a number nor a null nor a parseable numeric string (e.g.
 * a "-" sentinel where a count is expected, or a word) is SCHEMA DRIFT and THROWS —
 * a shape we do not understand must halt, not silently coerce to zero.
 */
type CountRead = { kind: 'number'; value: number } | { kind: 'missing' };

function readCount(v: unknown, field: string, ctx: string): CountRead {
  if (v === null || v === undefined) return { kind: 'missing' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`UNHCR ${ctx}: field '${field}' is a non-finite number — schema drift`);
    return { kind: 'number', value: v };
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return { kind: 'missing' };
    if (/^-?\d+$/.test(t)) return { kind: 'number', value: Number.parseInt(t, 10) };
    // A "-" or any other non-numeric string is a shape we do not understand.
    throw new Error(`UNHCR ${ctx}: field '${field}' is a non-numeric string ${JSON.stringify(v)} — schema drift, refusing to fabricate a count`);
  }
  throw new Error(`UNHCR ${ctx}: field '${field}' is a ${typeof v}, expected a count — schema drift`);
}

// ===========================================================================
// TRANSFORM — UNHCR rows -> vintage-carrying observation records.
// ===========================================================================

export interface TransformOptions {
  crosswalk: Map<string, CrosswalkEntry>;
  /** the content-hash vintage token for this dataset. Required — no number without it. */
  releaseVersion: string;
  /** when the source considers this published. UNHCR does not say, so usually null. */
  sourcePublishedAt: string | null;
  /** ISO-8601 instant WE fetched the data. */
  retrievedAt: string;
  /** licence_key registered in atlas.source_licence. */
  licenceKey: string;
  /** feed_key registered in atlas.feed. */
  feedKey: string;
}

/**
 * Map UNHCR origin rows into observation records — one record per (indicator,
 * country, year) for each of the four extensive indicators, attributing each to
 * iso_a3 THROUGH the crosswalk (never by name, never by trusting a raw code that
 * might be an aggregate). A row whose coo_iso does not resolve is dropped whole;
 * a single missing measure drops only that indicator; the composite is emitted
 * only when all three of its components are present. Every drop is recorded in
 * `skipped` with its reason.
 */
export function transformUnhcrRows(
  rows: UnhcrPopulationRow[],
  opts: TransformOptions,
): TransformResult {
  const records: ObservationRecord[] = [];
  const skipped: SkipRecord[] = [];

  const emit = (cfg: UnhcrIndicatorConfig, entry: CrosswalkEntry, row: UnhcrPopulationRow, value: number) => {
    const refYear = typeof row.year === 'number' ? row.year : Number.parseInt(String(row.year), 10);
    records.push({
      indicator: cfg.observationIndicator,
      area_type: 'country',
      area_code: entry.iso_a3,
      ref_period: String(row.year),
      value,
      unit: 'people', // every UNHCR displacement measure is an extensive count
      agg_method: 'sum',
      denominator_indicator: null,
      denominator_value: null,
      source: 'UNHCR',
      source_dataset: cfg.sourceDataset,
      release_version: opts.releaseVersion,
      reference_year: Number.isFinite(refYear) ? refYear : 0,
      source_published_at: opts.sourcePublishedAt,
      retrieved_at: opts.retrievedAt,
      licence_key: opts.licenceKey,
      feed_key: opts.feedKey,
    });
  };

  for (const row of rows) {
    const ctx = `${row.coo_iso}/${row.year}`;
    const entry = opts.crosswalk.get(row.coo_iso);
    if (!entry) {
      // No crosswalk iso_a3: a UNHCR non-country code (TIB/UNK/XXA) or a unit we do
      // not map. Dropping it is correct; recording it makes "why ~204 countries not
      // 207" answerable and keeps the aggregate out of every per-country total.
      skipped.push({ coo_iso: row.coo_iso, coo_name: row.coo_name, year: row.year, indicator: null, reason: 'aggregate_or_unmapped' });
      continue;
    }

    // Read the three component fields once; a non-numeric non-null value THROWS here.
    const components: Partial<Record<string, number>> = {};
    let compositeComplete = true;
    for (const f of COMPOSITE_FIELDS) {
      const read = readCount(row[f], String(f), ctx);
      if (read.kind === 'missing') compositeComplete = false;
      else components[String(f)] = read.value;
    }

    // Per-component indicators: store a real value (including a genuine 0); skip a
    // missing measure honestly as a known-unknown rather than as a fabricated zero.
    for (const cfg of [REFUGEES_ORIGIN, ASYLUM_SEEKERS_ORIGIN, IDPS]) {
      const field = String(cfg.field);
      if (field in components) {
        emit(cfg, entry, row, components[field] as number);
      } else {
        skipped.push({ coo_iso: row.coo_iso, coo_name: row.coo_name, year: row.year, indicator: cfg.observationIndicator, reason: 'null_value' });
      }
    }

    // The composite is only computable when every component is present.
    if (compositeComplete) {
      const total = COMPOSITE_FIELDS.reduce<number>((sum, f) => sum + (components[String(f)] as number), 0);
      emit(FORCIBLY_DISPLACED, entry, row, total);
    } else {
      skipped.push({ coo_iso: row.coo_iso, coo_name: row.coo_name, year: row.year, indicator: FORCIBLY_DISPLACED.observationIndicator, reason: 'incomplete_composite' });
    }
  }

  return { records, skipped };
}

// ===========================================================================
// THE VINTAGE TOKEN — UNHCR exposes no release date, so the vintage IS a content
// hash of the source numbers. This is honest and provable:
//   • re-fetching identical data -> identical hash -> ON CONFLICT DO NOTHING no-op
//   • a restatement of any number -> a new hash -> a NEW row (history preserved)
// The hash is over the SOURCE fields (coo_iso, year, and the three components),
// sorted, so row order and our own wall-clock never perturb it.
// ===========================================================================

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

/**
 * Compute the content-hash vintage token for a UNHCR dataset. Reads each row's
 * source components with the SAME coercion the transform uses, so a value that
 * would throw in the transform throws here too (a bad shape cannot slip past the
 * vintage). Missing counts are recorded as null in the hashed tuple so a data
 * change from "missing" to "0" (or vice versa) is a real vintage change.
 */
export async function computeReleaseToken(rows: UnhcrPopulationRow[]): Promise<string> {
  const tuples = rows
    .map((row) => {
      const ctx = `${row.coo_iso}/${row.year}`;
      const read = (f: keyof UnhcrPopulationRow) => {
        const r = readCount(row[f], String(f), ctx);
        return r.kind === 'number' ? r.value : null;
      };
      return {
        coo_iso: row.coo_iso,
        year: row.year,
        refugees: read('refugees'),
        asylum_seekers: read('asylum_seekers'),
        idps: read('idps'),
      };
    })
    .sort((a, b) => a.coo_iso.localeCompare(b.coo_iso) || a.year - b.year);
  return 'sha256:' + (await sha256Hex(canonicalJson(tuples)));
}

// ===========================================================================
// THE R2-SHAPED SNAPSHOT — content-hashed, every number carrying its vintage.
// (Same shape and hashing discipline as the World Bank snapshot, so a downstream
// publish planner treats both feeds identically.)
// ===========================================================================

export interface SnapshotObservation {
  indicator: string;
  area_code: string;
  ref_period: string;
  reference_year: number;
  value: number;
  unit: string;
  agg_method: string;
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
  generated_at: string;
  release_versions: string[];
  observation_count: number;
  observations: SnapshotObservation[];
  content_hash: string;
}

export interface SnapshotMeta {
  feedKey: string;
  licenceKey: string;
  generatedAt: string;
}

/**
 * Build the R2-shaped snapshot from observation records. content_hash is computed
 * over the DATA-AND-VINTAGE fields only (indicator, area, period, value, unit,
 * agg_method, source, dataset, release_version, source_published_at); the two
 * wall-clock fields (generated_at, each retrieved_at) are EXCLUDED, so two runs
 * over identical data at different times produce the SAME hash — the property that
 * makes the artifact content-addressed. retrieved_at still travels on every
 * observation; it just does not perturb the content's identity.
 */
export async function buildSnapshot(records: ObservationRecord[], meta: SnapshotMeta): Promise<Snapshot> {
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

  const hashCore = {
    schema_version: 'atlas.snapshot.v1',
    feed_key: meta.feedKey,
    source: 'UNHCR',
    license_key: meta.licenceKey,
    release_versions: releaseVersions,
    observation_count: observations.length,
    observations: observations.map(({ retrieved_at: _omit, ...rest }) => rest),
  };
  const content_hash = await sha256Hex(canonicalJson(hashCore));

  return {
    schema_version: 'atlas.snapshot.v1',
    feed_key: meta.feedKey,
    source: 'UNHCR',
    license_key: meta.licenceKey,
    generated_at: meta.generatedAt,
    release_versions: releaseVersions,
    observation_count: observations.length,
    observations,
    content_hash,
  };
}

// ===========================================================================
// WHAT THIS FEED STORES, AND WHAT IT DELIBERATELY DOES NOT (the honest tail).
//
// STORED — four extensive, agg_method='sum', unit='people' indicators, by country
// of ORIGIN (coo_all=true), one per (country, reference year):
//   refugees_origin           refugees whose country of origin is this country
//   asylum_seekers_origin     asylum-seekers whose country of origin is this country
//   idps                      internally displaced within this country (origin=location)
//   forcibly_displaced_origin refugees + asylum_seekers + idps (the "people in need" headline)
//
// NOT STORED, on purpose:
//   • country-of-ASYLUM (hosting) figures — a defensible alternative framing, left
//     to a future indicator; V1 uses one clean key (origin) to keep the join and
//     the rollup unambiguous.
//   • stateless persons — statelessness is not by itself displacement.
//   • returnees (returned_refugees / returned_idps) — people who went home are no
//     longer displaced; counting them under "displaced" would be wrong.
//   • OIP / OOC / HST — "-" or unpopulated in this dataset; storing them would be
//     noise, not signal.
//   • any RATE (e.g. displaced-per-capita) — that is intensive and must be
//     recomputed from two extensive indicators at query time, never stored summable.
// ===========================================================================
