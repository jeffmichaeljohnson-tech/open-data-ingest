/**
 * snapshotPublish.test.ts — offline proof of the publish layer.
 *
 * Run with `deno test` from this directory (Deno is the runtime the atlas ingest /
 * publish side already uses; this test must not pull in apps/web's vitest). Every
 * test is fixture-driven — no network, no R2, no filesystem.
 *
 * The key-stability tests import the REAL builder from atlas-ingest-worldbank so the
 * "same data → same key" property is proven end to end, not re-asserted against a
 * hand-made hash: two snapshots built from identical World Bank data at DIFFERENT
 * wall-clock times must land at the SAME immutable key, and a changed value must move
 * it. (We only read that module — we never modify it.)
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
  assertStringIncludes,
} from '@std/assert';
import {
  planPublish,
  contentKey,
  pointerKey,
  immutableObjectHeaders,
  pointerHeaders,
  buildLicenceBlock,
  validateLicence,
  formatPlan,
  humanBytes,
  LICENCE_REGISTER,
  type PublishableSnapshot,
  type LicenceDescriptor,
  type PointerDoc,
} from './snapshotPublish.ts';
import {
  buildSnapshot,
  transformWorldBankRows,
  buildCrosswalkIndex,
  POPULATION_TOTAL,
  type WorldBankRow,
} from '../feeds/worldbank/worldbank.ts';

// --- fixtures ---------------------------------------------------------------

const CROSSWALK = buildCrosswalkIndex([
  { iso_a3: 'NGA', wb_code: 'NGA', m49_macro_region_code: 2 },
  { iso_a3: 'GHA', wb_code: 'GHA', m49_macro_region_code: 2 },
]);

function wbRow(iso: string, name: string, date: string, value: number | null): WorldBankRow {
  return {
    indicator: { id: 'SP.POP.TOTL', value: 'Population' },
    country: { id: iso.slice(0, 2), value: name },
    countryiso3code: iso,
    date,
    value,
    unit: '',
    obs_status: '',
    decimal: 0,
  };
}

/** Build a real World Bank population snapshot, letting the caller vary the clock. */
async function wbSnapshot(
  values: { nga: number; gha: number },
  generatedAt: string,
  retrievedAt: string,
) {
  const { records } = transformWorldBankRows(
    POPULATION_TOTAL,
    [wbRow('NGA', 'Nigeria', '2024', values.nga), wbRow('GHA', 'Ghana', '2024', values.gha)],
    {
      crosswalk: CROSSWALK,
      releaseVersion: '2026-07-13',
      sourcePublishedAt: '2026-07-13',
      retrievedAt,
      licenceKey: 'cc_by_4',
    },
  );
  return await buildSnapshot(records, {
    feedKey: 'worldbank_reference',
    licenceKey: 'cc_by_4',
    generatedAt,
  });
}

/** A minimal OSM worship-points snapshot — the derivative-database case. */
function osmSnapshot(hash: string): PublishableSnapshot {
  // Built as a local then returned so the extra `points` payload widens away at the
  // return boundary (a direct `PublishableSnapshot` literal would excess-check it).
  const snap = {
    schema_version: 'atlas.snapshot.v1',
    feed_key: 'osm_worship_points',
    content_hash: hash,
    generated_at: '2026-08-17T12:00:00.000Z',
    release_versions: ['2026-08-01'],
    points: [{ lat: 6.5, lon: 3.4, kind: 'place_of_worship' }],
  };
  return snap;
}

// ===========================================================================
// (1) KEYS — same data ⇒ same key; changed data ⇒ different key.
// ===========================================================================
Deno.test('same data at different wall-clock times produces the SAME immutable key', async () => {
  const a = await wbSnapshot({ nga: 227882945, gha: 33787914 }, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  const b = await wbSnapshot({ nga: 227882945, gha: 33787914 }, '2026-08-18T09:30:00.000Z', '2026-08-18T09:30:00.000Z');

  // The builder guarantees identical DATA → identical content_hash across clocks...
  assertEquals(a.content_hash, b.content_hash);
  // ...and the publish key is derived from that hash, so the keys match too.
  const ka = planPublish(a, { clock: 'reference' }).objects.find((o) => o.kind === 'artifact')!.key;
  const kb = planPublish(b, { clock: 'reference' }).objects.find((o) => o.kind === 'artifact')!.key;
  assertEquals(ka, kb);
  assertStringIncludes(ka, `atlas/reference/worldbank_reference/${a.content_hash}.json`);
});

Deno.test('a changed value produces a DIFFERENT immutable key', async () => {
  const a = await wbSnapshot({ nga: 227882945, gha: 33787914 }, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  const b = await wbSnapshot({ nga: 227882946, gha: 33787914 }, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'); // +1 person

  assertNotEquals(a.content_hash, b.content_hash);
  const ka = planPublish(a, { clock: 'reference' }).objects.find((o) => o.kind === 'artifact')!.key;
  const kb = planPublish(b, { clock: 'reference' }).objects.find((o) => o.kind === 'artifact')!.key;
  assertNotEquals(ka, kb);
});

Deno.test('the pointer key is stable while the content key moves with the data', async () => {
  const a = await wbSnapshot({ nga: 1, gha: 2 }, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  const b = await wbSnapshot({ nga: 9, gha: 9 }, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  const pa = planPublish(a, { clock: 'reference' }).objects.find((o) => o.kind === 'pointer')!.key;
  const pb = planPublish(b, { clock: 'reference' }).objects.find((o) => o.kind === 'pointer')!.key;
  assertEquals(pa, pb); // the pointer name never changes...
  assertEquals(pa, 'atlas/reference/worldbank_reference/latest.json');
  const ca = planPublish(a, { clock: 'reference' }).contentHash;
  const cb = planPublish(b, { clock: 'reference' }).contentHash;
  assertNotEquals(ca, cb); // ...even though what it points at does
});

Deno.test('a path-unsafe feed_key or hash is refused, never smuggled into a key', () => {
  assertThrows(() => contentKey('reference', 'evil/../key', 'abc'), Error, 'unsafe feed_key');
  assertThrows(() => contentKey('reference', 'ok', '../etc/passwd'), Error, 'unsafe content_hash');
  assertThrows(() => pointerKey('reference', 'a/b'), Error, 'unsafe feed_key');
});

// ===========================================================================
// (2) CACHING HEADERS — immutable artifact vs mutable pointer.
// ===========================================================================
Deno.test('the artifact is immutable-cached for a year; the pointer is short and revalidated', () => {
  assertEquals(immutableObjectHeaders()['Cache-Control'], 'public, max-age=31536000, immutable');
  assertEquals(pointerHeaders()['Cache-Control'], 'public, max-age=60, must-revalidate');
  assertEquals(immutableObjectHeaders()['Content-Type'], 'application/json; charset=utf-8');
  assertEquals(pointerHeaders()['Content-Type'], 'application/json; charset=utf-8');
});

Deno.test('the plan applies the immutable header to the artifact and the pointer header to latest.json', async () => {
  const snap = await wbSnapshot({ nga: 1, gha: 2 }, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  const plan = planPublish(snap, { clock: 'reference' });
  const artifact = plan.objects.find((o) => o.kind === 'artifact')!;
  const pointer = plan.objects.find((o) => o.kind === 'pointer')!;
  assertStringIncludes(artifact.headers['Cache-Control'], 'immutable');
  assertStringIncludes(pointer.headers['Cache-Control'], 'max-age=60');
  assert(pointer.key.endsWith('latest.json'));
});

// ===========================================================================
// (3) THE TWO LICENCE CLASSES — the worship points carry ODbL; the aggregates
//     do NOT claim to be a database. One blanket rule would be wrong.
// ===========================================================================
Deno.test('the OSM worship-points artifact carries ODbL, attribution and the §4.6 availability notice', () => {
  const plan = planPublish(osmSnapshot('deadbeef'), { clock: 'geometry' });
  const artifact = JSON.parse(plan.objects.find((o) => o.kind === 'artifact')!.body);
  assertEquals(artifact.licence.spdx, 'ODbL-1.0');
  assertEquals(artifact.licence.is_reusable_database, true); // it IS the data, re-usable
  assertStringIncludes(artifact.licence.attribution, 'OpenStreetMap contributors');
  assert(typeof artifact.licence.data_availability === 'string' && artifact.licence.data_availability.length > 0);
  assertStringIncludes(artifact.licence.licence_url, 'odbl');
});

Deno.test('the World Bank aggregate artifact carries attribution but does NOT claim to be a database', async () => {
  const snap = await wbSnapshot({ nga: 1, gha: 2 }, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  const artifact = JSON.parse(planPublish(snap, { clock: 'reference' }).objects.find((o) => o.kind === 'artifact')!.body);
  assertEquals(artifact.licence.spdx, 'CC-BY-4.0');
  assertEquals(artifact.licence.is_reusable_database, false); // a picture of numbers, not a DB
  assertStringIncludes(artifact.licence.attribution, 'World Bank');
  assertEquals(artifact.licence.data_availability, undefined); // NOT a database whose data we make available
});

Deno.test('validateLicence throws if a derivative database is missing its ODbL obligations', () => {
  // no attribution
  assertThrows(
    () => validateLicence({ class: 'derivative_database', spdx: 'ODbL-1.0', attribution: '', licenceUrl: 'u', dataAvailabilityNotice: 'n' }),
    Error,
    'attribution',
  );
  // a derivative database stamped with a NON-database licence
  assertThrows(
    () => validateLicence({ class: 'derivative_database', spdx: 'CC-BY-4.0', attribution: '© OSM', licenceUrl: 'u', dataAvailabilityNotice: 'n' }),
    Error,
    'database/share-alike licence',
  );
  // missing the §4.6 availability notice
  assertThrows(
    () => validateLicence({ class: 'derivative_database', spdx: 'ODbL-1.0', attribution: '© OSM', licenceUrl: 'u' }),
    Error,
    'data-availability notice',
  );
});

Deno.test('validateLicence throws if an aggregate is handed a database/share-alike licence', () => {
  assertThrows(
    () => validateLicence({ class: 'aggregate_statistics', spdx: 'ODbL-1.0', attribution: 'The World Bank' }),
    Error,
    'must not claim a database/share-alike licence',
  );
  // and an aggregate must not pretend to be a database by carrying an availability notice
  assertThrows(
    () =>
      validateLicence({ class: 'aggregate_statistics', spdx: 'CC-BY-4.0', attribution: 'The World Bank', dataAvailabilityNotice: 'nope' }),
    Error,
    'must not carry a data-availability notice',
  );
});

Deno.test('a snapshot with no registered licence descriptor is refused (never ships unlabelled)', () => {
  const orphan: PublishableSnapshot = {
    schema_version: 'atlas.snapshot.v1',
    feed_key: 'not_registered',
    content_hash: 'abc',
    generated_at: '2026-08-17T12:00:00.000Z',
    release_versions: [],
  };
  assertThrows(() => planPublish(orphan, { clock: 'reference' }), Error, 'no licence descriptor');
});

Deno.test('the built-in register labels each feed with its verified class', () => {
  assertEquals(LICENCE_REGISTER.worldbank_reference.class, 'aggregate_statistics');
  assertEquals(LICENCE_REGISTER.osm_worship_points.class, 'derivative_database');
  // and every registered descriptor is internally consistent (would build a block)
  for (const desc of Object.values(LICENCE_REGISTER)) buildLicenceBlock(desc as LicenceDescriptor);
});

// ===========================================================================
// (4) THE POINTER — carries both clocks separately.
// ===========================================================================
Deno.test('the pointer names the content key and carries clock 1 and clock 2 separately', async () => {
  const snap = await wbSnapshot({ nga: 1, gha: 2 }, '2026-08-17T08:00:00.000Z', '2026-08-17T08:00:00.000Z');
  const pointer: PointerDoc = JSON.parse(planPublish(snap, { clock: 'reference' }).objects.find((o) => o.kind === 'pointer')!.body);
  assertEquals(pointer.content_key, `atlas/reference/worldbank_reference/${snap.content_hash}.json`);
  assertEquals(pointer.content_hash, snap.content_hash);
  assertEquals(pointer.generated_at, '2026-08-17T08:00:00.000Z'); // clock 1 — when WE built
  assertEquals(pointer.source_changed_at, '2026-07-13'); // clock 2 — the source release, NOT our build time
  assertEquals(pointer.clock, 'reference');
  assertEquals(pointer.licence_spdx, 'CC-BY-4.0');
});

Deno.test('sourceChangedAt can be overridden for a feed whose release token is not a date', () => {
  const snap = osmSnapshot('cafe');
  const pointer: PointerDoc = JSON.parse(
    planPublish(snap, { clock: 'geometry', sourceChangedAt: '2026-08-10T00:00:00.000Z' }).objects.find((o) => o.kind === 'pointer')!.body,
  );
  assertEquals(pointer.source_changed_at, '2026-08-10T00:00:00.000Z');
});

// ===========================================================================
// (5) DRY-RUN FORMAT — the human sees the keys, headers and total size, and a
//     clear statement of whether anything would be uploaded.
// ===========================================================================
Deno.test('the dry-run report lists both keys, their headers and the total size', async () => {
  const snap = await wbSnapshot({ nga: 1, gha: 2 }, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  const report = formatPlan(planPublish(snap, { clock: 'reference' }), { willUpload: false });
  assertStringIncludes(report, 'atlas/reference/worldbank_reference/');
  assertStringIncludes(report, 'latest.json');
  assertStringIncludes(report, 'immutable');
  assertStringIncludes(report, 'total upload size:');
  assertStringIncludes(report, 'DRY RUN');
  // and when upload is armed, it says so instead
  assertStringIncludes(formatPlan(planPublish(snap, { clock: 'reference' }), { willUpload: true }), '--upload SET');
});

Deno.test('humanBytes picks the right unit at each boundary and rounds as documented', () => {
  // The dry-run report a human reads is built from this; it is exported and had no
  // direct test, so the unit thresholds (1024, 1 MB) and the decimal places went
  // unpinned. Assert both sides of each boundary.
  assertEquals(humanBytes(0), '0 B');
  assertEquals(humanBytes(1023), '1023 B'); // last byte-unit value
  assertEquals(humanBytes(1024), '1.0 KB'); // first KB value, one decimal
  assertEquals(humanBytes(1536), '1.5 KB');
  assertEquals(humanBytes(1024 * 1024 - 1), '1024.0 KB'); // last KB value
  assertEquals(humanBytes(1024 * 1024), '1.00 MB'); // first MB value, two decimals
  assertEquals(humanBytes(5 * 1024 * 1024 + 512 * 1024), '5.50 MB');
});

// ===========================================================================
// SPELLING IS NOT POLICY
//
// Found by a red-team pass. `DATABASE_COPYLEFT_SPDX.has(desc.spdx)` was an
// exact, case-sensitive lookup, and the same Set runs both legs of the gate —
// so one casing slip was wrong in BOTH directions at once: it rejected a genuine
// ODbL database, and accepted a share-alike claim on a picture of numbers.
//
// Every id below is a real SPDX spelling, not a contrivance. CC-BY-SA 2.0 and
// 2.5 are the versions most legacy datasets actually carry.
// ===========================================================================
const dbDesc = (spdx: string): LicenceDescriptor => ({
  class: 'derivative_database',
  spdx,
  attribution: '© OpenStreetMap contributors',
  licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  dataAvailabilityNotice: 'The full database is available under the ODbL.',
});
const aggDesc = (spdx: string): LicenceDescriptor => ({
  class: 'aggregate_statistics',
  spdx,
  attribution: 'The World Bank',
});

Deno.test('a database licence is recognised however it is spelled', () => {
  for (const spdx of ['ODbL-1.0', 'odbl-1.0', 'ODBL-1.0', 'OdbL-1.0', ' ODbL-1.0 ',
                      'ODbL-1.0+', 'ODC-ODbL-1.0', 'CC-BY-SA-4.0', 'cc-by-sa-3.0',
                      'CC-BY-SA-4.0-or-later']) {
    validateLicence(dbDesc(spdx));
  }
});

Deno.test('an aggregate may not claim a share-alike licence, however it is spelled', () => {
  for (const spdx of ['ODbL-1.0', 'odbl-1.0', 'ODBL-1.0', 'ODbL-1.0+', 'ODC-ODbL-1.0',
                      'CC-BY-SA-4.0', 'cc-by-sa-4.0', 'CC-BY-SA-3.0', ' CC-BY-SA-4.0',
                      'CC-BY-SA-4.0-or-later']) {
    assertThrows(() => validateLicence(aggDesc(spdx)), Error, 'must not claim',
      `an aggregate claiming ${spdx} was accepted`);
  }
});

Deno.test('every CC-BY-SA version is share-alike, including the 2.x legacy datasets carry', () => {
  // The header above names CC-BY-SA 2.0 and 2.5 as "the versions most legacy
  // datasets actually carry", but the copyleft set only listed 3.0 and 4.0 — so a
  // 2.x id was wrong in BOTH directions at once, exactly like the original casing
  // slip: an aggregate could falsely claim CC-BY-SA-2.0, and a genuine CC-BY-SA-2.0
  // database was refused publication. CC-BY-SA is share-alike at every version.
  for (const spdx of ['CC-BY-SA-2.0', 'CC-BY-SA-2.5', 'cc-by-sa-2.0', ' CC-BY-SA-2.5 ',
                      'CC-BY-SA-2.0-or-later']) {
    // an aggregate must NOT be allowed to claim it
    assertThrows(() => validateLicence(aggDesc(spdx)), Error, 'must not claim',
      `an aggregate claiming ${spdx} was accepted`);
    // and a real derivative database carrying it must be ACCEPTED, not refused
    validateLicence(dbDesc(spdx));
  }
});

Deno.test('normalisation does not over-match — a genuinely permissive licence is not flagged copyleft', () => {
  // The control for the test above: the copyleft check must reject share-alike ids
  // WITHOUT sweeping up permissive ones. An aggregate carrying any of these is
  // correct and must pass; a `CC-BY-SA` substring test (rather than the explicit
  // set) would wrongly flag none of them, but a too-eager prefix match could.
  for (const spdx of ['CC-BY-4.0', 'MIT', 'public-domain', 'CC0-1.0', 'CC-BY-3.0', 'ODC-By-1.0']) {
    validateLicence(aggDesc(spdx)); // must NOT throw
  }
});

Deno.test('a licence class outside the union is refused, not treated as an aggregate', () => {
  // These used to fall through to the aggregate branch, silently stripping every
  // database obligation from an artifact that meant to carry them.
  for (const cls of ['derivative_databases', 'DERIVATIVE_DATABASE', 'derivative_database ',
                     '', undefined, null, 42]) {
    assertThrows(
      () => validateLicence({ ...dbDesc('ODbL-1.0'), class: cls } as unknown as LicenceDescriptor),
      Error, 'licence class must be',
      `class ${JSON.stringify(cls)} was accepted`,
    );
  }
});

Deno.test('an attribution nobody can see is not an attribution', () => {
  // String.trim() strips Zs and the BOM but NOT format characters, so each of
  // these satisfied a check whose whole subject is that attribution is required.
  for (const attribution of ['​', '⁠', '‌', '­', '᠎',
                             '  ​  ', '', '   ']) {
    assertThrows(() => validateLicence({ ...aggDesc('CC-BY-4.0'), attribution }),
      Error, 'has no attribution', `attribution ${JSON.stringify(attribution)} was accepted`);
  }
  // The control: a real attribution still passes, so this is not a blanket refusal.
  validateLicence({ ...aggDesc('CC-BY-4.0'), attribution: 'The World Bank' });
});

Deno.test('an empty SPDX id is refused on both classes', () => {
  assertThrows(() => validateLicence(aggDesc('')), Error, 'no SPDX id');
  assertThrows(() => validateLicence(aggDesc('   ')), Error, 'no SPDX id');
});

Deno.test('a whitespace-only licence URL does not satisfy ODbL', () => {
  // '' was refused and '   ' was not: a bare falsy check beside a trimmed one.
  assertThrows(() => validateLicence({ ...dbDesc('ODbL-1.0'), licenceUrl: '   ' }),
    Error, 'licence URL');
  assertThrows(() => validateLicence({ ...dbDesc('ODbL-1.0'), licenceUrl: '' }),
    Error, 'licence URL');
});
