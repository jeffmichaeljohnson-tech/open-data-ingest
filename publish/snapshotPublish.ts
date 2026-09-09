/**
 * snapshotPublish.ts — the PURE publish layer: take a built, content-hashed
 * snapshot and decide EXACTLY what lands in R2 — the keys, the caching headers,
 * and the licence labelling — with no network and no filesystem. `publish.ts` (the
 * Deno CLI the human runs) is the thin shell that does the actual I/O; everything
 * here is fixture-testable, which is why the key/licence/header rules live in one
 * place that `deno test` can prove offline.
 *
 * WHY THIS DIRECTORY IS `_atlas-publish` AND NOT A FUNCTION. The Supabase CLI
 * bundles and deploys every directory under supabase/functions/ EXCEPT those whose
 * name starts with `_` (that is exactly why the shared code lives in `_shared`).
 * The publish step is NOT an edge function — it is a step a human runs from a
 * shell script (see scripts/publish-atlas-snapshot.sh) — so it must live somewhere
 * the deployer ignores. A leading underscore is that somewhere. It also cannot live
 * in `_shared` (owned by another lane) or in atlas-ingest-worldbank/ (owns the
 * snapshot BUILD, not its publication), so a new `_`-prefixed sibling is the home.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO IDEAS THIS FILE EXISTS TO GET RIGHT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 1. CONTENT-HASHED KEY + MUTABLE POINTER. A snapshot is addressed by the hash of
 *    its DATA (buildSnapshot already computes that hash over data-and-vintage,
 *    excluding wall-clock, so identical data at two different times yields ONE
 *    hash — see worldbank.ts). We store the artifact at an immutable, hash-named
 *    key that can be cached for a year, and we store a tiny mutable `latest.json`
 *    pointer that merely names the current hash. The client reads the cheap pointer
 *    to learn which immutable artifact is current, then fetches that artifact once
 *    and caches it forever. Getting this pair wrong is a real failure either way:
 *    a mutable data key with a long cache serves STALE DATA FOREVER; an immutable
 *    data key with a short cache means NO CACHING AT ALL. The split is what lets
 *    the heavy artifact be immutable-cached while the pointer stays fresh.
 *
 * 2. TWO ARTIFACT CLASSES, TWO LICENCE OBLIGATIONS — NOT ONE BLANKET RULE. Per
 *    docs/DATA-LICENSE-REGISTER.md (the ODbL section, read it):
 *      • A snapshot of the OpenStreetMap worship points is the DATA in re-usable
 *        form — coordinates you can extract — so on the OSMF's own definition it is
 *        a DERIVATIVE DATABASE. ODbL lets us publish it, but the file MUST carry the
 *        ODbL licence, the "© OpenStreetMap contributors" attribution, and the
 *        §4.6 data-availability statement. This labelling is a licence CONDITION,
 *        not a courtesy.
 *      • A snapshot of aggregate statistics (World Bank population, electricity
 *        access) is a PICTURE OF NUMBERS, not a redistributable database. It carries
 *        attribution (CC BY 4.0 asks for it) but it must NOT claim to be a re-usable
 *        database and must NOT stamp a share-alike licence it does not carry.
 *    Applying one rule to both is the mistake this file structurally refuses:
 *    {@link validateLicence} throws if a derivative-database artifact is missing its
 *    ODbL obligations, AND throws if an aggregate artifact is handed a database /
 *    share-alike licence it has no business claiming.
 */

// ===========================================================================
// SNAPSHOT INPUT — the minimum this layer needs from a built snapshot.
// worldbank.ts's `Snapshot` structurally satisfies this (it has content_hash,
// feed_key, generated_at, release_versions and more), and so does a future OSM
// worship-points snapshot. We depend on the SHAPE, not on one producer, so the
// publish rules are provable against a fixture without importing a specific feed.
// ===========================================================================

/**
 * A snapshot that is ready to publish. `content_hash` is the DATA hash — stable
 * across identical runs, different only when the data differs — and it is the ONLY
 * thing the immutable key is derived from, so "same data → same key" is inherited
 * from the builder rather than re-asserted here.
 *
 * These are the only fields the publish layer READS; the whole object is spread into
 * the artifact body, so a feed's own payload (World Bank's `observations`, OSM's
 * `points`, …) rides through untouched at runtime. Deliberately NO index signature:
 * one would force every producer's type to declare `[key: string]: unknown` to be
 * assignable here, which worldbank.ts's `Snapshot` (correctly) does not.
 */
export interface PublishableSnapshot {
  schema_version: string;
  feed_key: string;
  content_hash: string;
  generated_at: string;
  /** the source release(s) represented — the reference clock's staleness input. */
  release_versions: string[];
}

// ===========================================================================
// LICENCE DESCRIPTORS — the register's obligations, encoded as data.
// ===========================================================================

/**
 * Which of the two obligation classes an artifact falls in. This is the single
 * distinction the register draws and the one this file will not let a caller blur.
 */
export type LicenceClass =
  /** a picture of numbers — attribution, but NOT a redistributable database. */
  | 'aggregate_statistics'
  /** the data itself in re-usable form — a Derivative Database that must carry its licence. */
  | 'derivative_database';

/** Everything needed to label an artifact correctly, per its class. */
export interface LicenceDescriptor {
  class: LicenceClass;
  /** SPDX id of the licence the artifact carries — 'CC-BY-4.0', 'ODbL-1.0', 'public-domain'. */
  spdx: string;
  /** the attribution string that MUST be shown/travel with the data. Never empty. */
  attribution: string;
  /** where the attribution links (OSM copyright page, provider terms). */
  attributionUrl?: string;
  /** the licence's own URL. Required for a derivative database. */
  licenceUrl?: string;
  /**
   * ODbL §4.6 obligation: when we hand someone the Produced Work built from a
   * Derivative Database, the data must be made available under ODbL. This is the
   * statement that records HOW. Required for `derivative_database`; forbidden as a
   * claim on `aggregate_statistics` (which is not a database to make available).
   */
  dataAvailabilityNotice?: string;
}

/**
 * SPDX ids that carry a share-alike / database-copyleft obligation. An aggregate
 * "picture of numbers" must never be stamped with one of these — doing so would
 * falsely assert the file is a re-usable database under copyleft. Kept as a small
 * explicit set rather than a substring test so a new licence is a deliberate add.
 */
const DATABASE_COPYLEFT_SPDX = new Set(['ODBL-1.0', 'CC-BY-SA-4.0', 'CC-BY-SA-3.0']);

/**
 * Normalise an SPDX id before any membership test.
 *
 * The set above was compared with `.has(desc.spdx)` on the raw string, which is
 * exact and case-sensitive, so one casing slip was wrong in BOTH directions at
 * once: `odbl-1.0` was rejected on a genuine ODbL database, and the same id was
 * accepted on an aggregate because it missed the copyleft set there too. The
 * `-or-later` and `+` suffixes are real SPDX syntax and failed the same way.
 *
 * Deliberately NOT a substring test: the set stays explicit so adding a licence
 * remains a reviewable act. Only the spelling is normalised, never the policy.
 */
function normaliseSpdx(spdx: string): string {
  return spdx.trim().toUpperCase().replace(/(-OR-LATER|\+)$/, '');
}

/** Is this a database/share-alike licence, whatever its spelling? */
function isDatabaseCopyleft(spdx: string): boolean {
  const id = normaliseSpdx(spdx);
  // ODC-ODbL-1.0 is the same licence under its Open Data Commons prefix.
  return DATABASE_COPYLEFT_SPDX.has(id) || DATABASE_COPYLEFT_SPDX.has(id.replace(/^ODC-/, ''));
}

/**
 * Validate a licence descriptor against its class. This is where the two-class
 * distinction is enforced rather than hoped for.
 *
 * Throws — loudly, at build time, before anything is written — because a mislabelled
 * artifact is a licence breach the moment it is published, and a silent one is worse
 * than a failed publish.
 */
export function validateLicence(desc: LicenceDescriptor): void {
  // A class outside the union used to fall through to the aggregate branch,
  // so a typo silently stripped every database obligation. Named explicitly.
  if (desc.class !== 'aggregate_statistics' && desc.class !== 'derivative_database') {
    throw new Error(
      `licence class must be 'aggregate_statistics' or 'derivative_database'; got ${JSON.stringify(desc.class)}`,
    );
  }

  // `trim()` strips Zs and the BOM but NOT the format characters, so a
  // zero-width space passed as an attribution. Strip those too before deciding
  // a string is empty, and require it to carry at least one letter or digit:
  // an attribution nobody can see is not an attribution.
  if (!desc.attribution || !/[\p{L}\p{N}]/u.test(desc.attribution.replace(/\p{Cf}/gu, ''))) {
    throw new Error(`licence for class '${desc.class}' has no attribution — attribution is never optional`);
  }

  if (!desc.spdx || normaliseSpdx(desc.spdx) === '') {
    throw new Error(`licence for class '${desc.class}' has no SPDX id`);
  }

  if (desc.class === 'derivative_database') {
    // The OSM worship-points case. The labelling obligation is the whole point.
    if (!isDatabaseCopyleft(desc.spdx)) {
      throw new Error(
        `a derivative_database artifact must carry a database/share-alike licence (e.g. ODbL-1.0); got '${desc.spdx}'`,
      );
    }
    if (!desc.licenceUrl || desc.licenceUrl.trim() === '') {
      throw new Error('a derivative_database artifact must carry its licence URL (ODbL requires the licence travel with the data)');
    }
    if (!desc.dataAvailabilityNotice || desc.dataAvailabilityNotice.trim() === '') {
      throw new Error('a derivative_database artifact must carry the ODbL §4.6 data-availability notice');
    }
    return;
  }

  // aggregate_statistics — a picture of numbers, NOT a database.
  if (isDatabaseCopyleft(desc.spdx)) {
    throw new Error(
      `an aggregate_statistics artifact must not claim a database/share-alike licence ('${desc.spdx}') — it is a picture of numbers, not a re-usable database`,
    );
  }
  if (desc.dataAvailabilityNotice) {
    throw new Error(
      'an aggregate_statistics artifact must not carry a data-availability notice — it is not a database whose data we are making available',
    );
  }
}

// ===========================================================================
// THE LICENCE BLOCK — what actually gets embedded in the artifact.
// ===========================================================================

/** The licence block embedded in every published artifact, next to the data. */
export interface LicenceBlock {
  spdx: string;
  /**
   * The load-bearing flag. TRUE only for a Derivative Database (the OSM worship
   * points): it declares the file IS re-usable data under a copyleft licence. FALSE
   * for aggregate statistics: the file is a rendering of numbers, not a database to
   * be extracted and re-shared. A reader (or an automated licence check) can decide
   * its obligations from this one boolean.
   */
  is_reusable_database: boolean;
  attribution: string;
  attribution_url?: string;
  licence_url?: string;
  /** ODbL §4.6 statement — present ONLY on a derivative database. */
  data_availability?: string;
  /** a human sentence stating what this file is, licence-wise. */
  notice: string;
}

/** Build the embedded licence block for an artifact, after validating the descriptor. */
export function buildLicenceBlock(desc: LicenceDescriptor): LicenceBlock {
  validateLicence(desc);
  const isDb = desc.class === 'derivative_database';
  const block: LicenceBlock = {
    spdx: desc.spdx,
    is_reusable_database: isDb,
    attribution: desc.attribution,
    notice: isDb
      ? `This artifact is a Derivative Database under ${desc.spdx}. The data is provided in re-usable form and must be redistributed under the same licence, with attribution retained.`
      : `This artifact is a derived rendering of aggregate figures under ${desc.spdx}. It is not offered as a re-usable database; retain the attribution when displaying these numbers.`,
  };
  if (desc.attributionUrl) block.attribution_url = desc.attributionUrl;
  if (desc.licenceUrl) block.licence_url = desc.licenceUrl;
  if (isDb && desc.dataAvailabilityNotice) block.data_availability = desc.dataAvailabilityNotice;
  return block;
}

// ===========================================================================
// THE LICENCE REGISTER — one descriptor per feed we publish.
// Sourced verbatim from docs/DATA-LICENSE-REGISTER.md. Adding a feed here is a
// deliberate, reviewable act, so a new source cannot be published unlabelled.
// ===========================================================================

export const LICENCE_REGISTER: Record<string, LicenceDescriptor> = {
  // World Bank population + electricity access. CC BY 4.0, attribution string
  // verbatim from the register ("The World Bank: Dataset name: Data source"). This
  // is the aggregate-statistics class: a picture of numbers, NOT a database.
  worldbank_reference: {
    class: 'aggregate_statistics',
    spdx: 'CC-BY-4.0',
    attribution: 'The World Bank',
    attributionUrl: 'https://data.worldbank.org/summary-terms-of-use',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },

  // OpenStreetMap places of worship. ODbL 1.0. This is the ONE feed where the R2
  // snapshot is a Derivative Database and the labelling is a licence condition:
  // attribution + ODbL + the §4.6 availability statement all travel in the file.
  osm_worship_points: {
    class: 'derivative_database',
    spdx: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    dataAvailabilityNotice:
      'This file is a Derivative Database of OpenStreetMap data, made available under the ' +
      'Open Database License (ODbL) v1.0. You are free to copy, distribute and adapt it under ' +
      'the same licence, and must attribute "© OpenStreetMap contributors".',
  },
};

// ===========================================================================
// KEYS — the immutable content key and the mutable pointer key.
// ===========================================================================

/**
 * Which staleness clock this feed runs on — mirrors feedRegistry's FeedClock. It is
 * part of the KEY so reference and event artifacts never collide in the bucket, and
 * it rides on the pointer so the client can pick the right staleness rule.
 */
export type SnapshotClock = 'reference' | 'event' | 'geometry';

const KEY_ROOT = 'atlas';

/** JSON keys must not smuggle a path separator in via the feed_key or hash. */
function assertKeySafe(part: string, what: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(part)) {
    throw new Error(`unsafe ${what} for an R2 key: ${JSON.stringify(part)}`);
  }
}

/**
 * The IMMUTABLE key. Named by the data hash, so a given dataset always lands at the
 * same key and a changed dataset lands at a new one — nothing is ever overwritten.
 * This is what earns the year-long immutable cache.
 */
export function contentKey(clock: SnapshotClock, feedKey: string, contentHash: string): string {
  assertKeySafe(feedKey, 'feed_key');
  assertKeySafe(contentHash, 'content_hash');
  return `${KEY_ROOT}/${clock}/${feedKey}/${contentHash}.json`;
}

/**
 * The MUTABLE pointer key. Always the same name for a feed, so the client fetches a
 * stable URL to learn which immutable artifact is current. This is the ONE object
 * that gets overwritten, and the ONLY one served without a long cache.
 */
export function pointerKey(clock: SnapshotClock, feedKey: string): string {
  assertKeySafe(feedKey, 'feed_key');
  return `${KEY_ROOT}/${clock}/${feedKey}/latest.json`;
}

// ===========================================================================
// CACHING HEADERS — immutable artifact vs mutable pointer.
// ===========================================================================

/** Content-Type for every object: JSON, explicit charset. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Headers for an IMMUTABLE, content-hashed artifact. A year, marked immutable, so
 * browsers never even revalidate within the year — safe precisely because the key
 * is content-addressed: new data is a new key, never a mutation of this one.
 * (Matches docs/WAVE0-INFRA.md §4.)
 */
export function immutableObjectHeaders(): Record<string, string> {
  return {
    'Content-Type': JSON_CONTENT_TYPE,
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
}

/**
 * Headers for the MUTABLE pointer. Short max-age + must-revalidate rather than a
 * bare `no-cache`: the pointer changes rarely (a reference feed republishes on a
 * source release, often ~yearly), so a 60-second window collapses request volume
 * enormously while still picking up a new build within a minute. `no-store` was
 * rejected — it would forbid even that 60s of caching and put every client read
 * straight on the origin. The immutable artifacts behind the pointer are what carry
 * the real bytes and the real cache; the pointer just needs to turn over promptly.
 */
export function pointerHeaders(): Record<string, string> {
  return {
    'Content-Type': JSON_CONTENT_TYPE,
    'Cache-Control': 'public, max-age=60, must-revalidate',
  };
}

// ===========================================================================
// THE POINTER DOCUMENT — tiny, and carries BOTH clocks' inputs.
// ===========================================================================

/**
 * The body of `latest.json`. Deliberately small (it is fetched often and cached
 * briefly) and it carries the two clocks separately, never merged: `generated_at`
 * is clock 1 (when OUR pipeline last built), `source_changed_at` is clock 2 (when
 * the SOURCE last published new data). The client reads these to render staleness
 * per clock — a single combined "updated today" badge over both would be a lie by
 * construction, so the pointer never offers one.
 */
export interface PointerDoc {
  schema_version: 'atlas.pointer.v1';
  feed_key: string;
  clock: SnapshotClock;
  /** the immutable key the current data lives at — what the client fetches next. */
  content_key: string;
  /** the data hash, echoed so the client can verify the artifact it fetched. */
  content_hash: string;
  /** CLOCK 1 — when our pipeline built this snapshot. */
  generated_at: string;
  /** CLOCK 2 — when the source last published new data (the newest release token). */
  source_changed_at: string | null;
  /** the source release token(s) represented, for display and debugging. */
  release_versions: string[];
  /** licence class, echoed so a consumer of the pointer knows how the data is licensed. */
  licence_class: LicenceClass;
  licence_spdx: string;
}

// ===========================================================================
// THE PLAN — everything that would be written, computed with no I/O.
// ===========================================================================

/** One object the publish would write: its key, headers, serialised body and size. */
export interface PlannedObject {
  key: string;
  headers: Record<string, string>;
  /** the exact JSON bytes that would be uploaded (pretty-printed, UTF-8). */
  body: string;
  bytes: number;
  /** immutable artifact or the mutable pointer — drives which cache posture applies. */
  kind: 'artifact' | 'pointer';
}

export interface PublishPlan {
  feedKey: string;
  clock: SnapshotClock;
  contentHash: string;
  objects: PlannedObject[];
  totalBytes: number;
}

/** UTF-8 byte length of a string (Deno, Node and browser all have TextEncoder). */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface PlanOptions {
  clock: SnapshotClock;
  /** the licence descriptor for this feed; defaults to LICENCE_REGISTER[feed_key]. */
  licence?: LicenceDescriptor;
  /**
   * CLOCK 2 — when the source last published. Defaults to the max of the snapshot's
   * release_versions (which for World Bank ARE dates). Passed explicitly for feeds
   * whose release token is not a date.
   */
  sourceChangedAt?: string | null;
}

/**
 * Plan a publish with NO I/O: build the licence-labelled artifact, its immutable
 * content key, the mutable pointer, and the caching headers for each. This is the
 * function the tests prove and the CLI prints; the CLI's only extra job is to send
 * the bytes.
 *
 * The artifact body embeds the licence block under `licence` (distinct from the
 * snapshot's own scalar `license_key`, which names a registry row; this block is the
 * full, self-contained obligation that must travel with the file). For a derivative
 * database that block is the ODbL condition being satisfied; for aggregate stats it
 * is the attribution-only courtesy — and {@link validateLicence} has already refused
 * to let those two be confused.
 */
export function planPublish(snapshot: PublishableSnapshot, opts: PlanOptions): PublishPlan {
  const licence = opts.licence ?? LICENCE_REGISTER[snapshot.feed_key];
  if (!licence) {
    throw new Error(
      `no licence descriptor for feed '${snapshot.feed_key}' — register it in LICENCE_REGISTER before publishing (a snapshot must never ship unlabelled)`,
    );
  }
  const licenceBlock = buildLicenceBlock(licence); // validates, throws on a mislabel

  const artifactBody = JSON.stringify({ ...snapshot, licence: licenceBlock }, null, 2);
  const key = contentKey(opts.clock, snapshot.feed_key, snapshot.content_hash);

  // Clock 2 default: the newest release token. World Bank release_versions are the
  // `lastupdated` dates, so the max is the source's last publish. A feed whose token
  // is not a date passes sourceChangedAt explicitly.
  const sourceChangedAt =
    opts.sourceChangedAt !== undefined
      ? opts.sourceChangedAt
      : snapshot.release_versions.length > 0
        ? [...snapshot.release_versions].sort().at(-1)!
        : null;

  const pointer: PointerDoc = {
    schema_version: 'atlas.pointer.v1',
    feed_key: snapshot.feed_key,
    clock: opts.clock,
    content_key: key,
    content_hash: snapshot.content_hash,
    generated_at: snapshot.generated_at,
    source_changed_at: sourceChangedAt,
    release_versions: snapshot.release_versions,
    licence_class: licence.class,
    licence_spdx: licence.spdx,
  };
  const pointerBody = JSON.stringify(pointer, null, 2);

  const objects: PlannedObject[] = [
    { key, headers: immutableObjectHeaders(), body: artifactBody, bytes: utf8Bytes(artifactBody), kind: 'artifact' },
    { key: pointerKey(opts.clock, snapshot.feed_key), headers: pointerHeaders(), body: pointerBody, bytes: utf8Bytes(pointerBody), kind: 'pointer' },
  ];

  return {
    feedKey: snapshot.feed_key,
    clock: opts.clock,
    contentHash: snapshot.content_hash,
    objects,
    totalBytes: objects.reduce((n, o) => n + o.bytes, 0),
  };
}

// ===========================================================================
// DRY-RUN FORMATTING — the exact text the CLI prints. Kept here (pure) so a test
// can assert it says what it does, and the human sees the same string the tests do.
// ===========================================================================

/** Human-readable byte size, e.g. '1.2 KB'. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Render a plan as the dry-run report: every key, its headers, and the total size. */
export function formatPlan(plan: PublishPlan, opts: { willUpload: boolean }): string {
  const lines: string[] = [];
  lines.push(`feed:   ${plan.feedKey}`);
  lines.push(`clock:  ${plan.clock}`);
  lines.push(`hash:   ${plan.contentHash}`);
  lines.push('');
  for (const o of plan.objects) {
    lines.push(`  [${o.kind}] ${o.key}`);
    for (const [h, v] of Object.entries(o.headers)) lines.push(`      ${h}: ${v}`);
    lines.push(`      size: ${humanBytes(o.bytes)} (${o.bytes} bytes)`);
    lines.push('');
  }
  lines.push(`total upload size: ${humanBytes(plan.totalBytes)} (${plan.totalBytes} bytes) across ${plan.objects.length} objects`);
  lines.push('');
  lines.push(
    opts.willUpload
      ? '*** --upload SET: the objects above WOULD be written to R2. ***'
      : 'DRY RUN — nothing was uploaded. Re-run with --upload to write these objects.',
  );
  return lines.join('\n');
}
