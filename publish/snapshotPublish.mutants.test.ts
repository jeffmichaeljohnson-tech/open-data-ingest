/**
 * snapshotPublish.mutants.test.ts — targeted proof for the mutants that survived
 * the generated-mutant run on the publish layer's weakest file.
 *
 * Each test closes a specific surviving mutant and is paired with a negative
 * control, so it cannot pass against a function that simply refuses (or accepts)
 * everything. Comments name the DEFECT a test prevents, in the classes SECURITY.md
 * calls in scope: an artifact published without its licence obligations, and an
 * immutable-key / pointer scheme that misreports what it points at or when.
 *
 * Offline like its sibling: no network, no filesystem, `--allow-read` alone. The
 * sibling file publish/snapshotPublish.test.ts is complementary; it is neither
 * modified nor duplicated here.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import {
  buildLicenceBlock,
  formatPlan,
  LICENCE_REGISTER,
  type LicenceDescriptor,
  planPublish,
  type PointerDoc,
  type PublishableSnapshot,
  validateLicence,
} from './snapshotPublish.ts';

// --- fixtures ---------------------------------------------------------------

/** A publishable snapshot whose clock inputs the caller controls. Returned via a
 * local so the extra payload widens away rather than tripping the excess-property
 * check (the same shape a real feed spreads through the artifact body). */
function makeSnapshot(
  opts: { feedKey: string; releaseVersions: string[]; contentHash?: string; generatedAt?: string },
): PublishableSnapshot {
  const s = {
    schema_version: 'atlas.snapshot.v1',
    feed_key: opts.feedKey,
    content_hash: opts.contentHash ?? 'a1b2c3',
    generated_at: opts.generatedAt ?? '2026-08-17T12:00:00.000Z',
    release_versions: opts.releaseVersions,
    payload: { note: 'fixture' },
  };
  return s;
}

const dbDesc = (over: Partial<LicenceDescriptor> = {}): LicenceDescriptor => ({
  class: 'derivative_database',
  spdx: 'ODbL-1.0',
  attribution: '© OpenStreetMap contributors',
  licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  dataAvailabilityNotice: 'The full database is available under the ODbL.',
  ...over,
});

const aggDesc = (over: Partial<LicenceDescriptor> = {}): LicenceDescriptor => ({
  class: 'aggregate_statistics',
  spdx: 'CC-BY-4.0',
  attribution: 'The World Bank',
  ...over,
});

// ===========================================================================
// SPDX NORMALISATION IS ANCHORED — spelling still is not policy.
// ===========================================================================
Deno.test('the -or-later / + suffix is stripped only as a suffix, never mid-string', () => {
  // DEFECT (L137): dropping the `$` anchor lets normalisation rewrite an id that
  // merely CONTAINS `-OR-LATER` or `+`. `CC-BY-SA-OR-LATER-4.0` is NOT the
  // share-alike id `CC-BY-SA-4.0`; an unanchored strip would collapse it into one
  // and refuse an aggregate that is entitled to carry it.
  validateLicence(aggDesc({ spdx: 'CC-BY-SA-OR-LATER-4.0' })); // must NOT throw
  // control: the genuine trailing-suffix and bare forms ARE share-alike, refused.
  assertThrows(() => validateLicence(aggDesc({ spdx: 'CC-BY-SA-4.0' })), Error, 'must not claim');
  assertThrows(() => validateLicence(aggDesc({ spdx: 'CC-BY-SA-4.0-or-later' })), Error, 'must not claim');
});

Deno.test('the ODC- alias prefix is stripped only at the start, never mid-string', () => {
  // DEFECT (L144): dropping the `^` anchor lets an id that merely CONTAINS `ODC-`
  // be rewritten into a set member. `CC-ODC-BY-SA-4.0` is not `CC-BY-SA-4.0`; an
  // unanchored strip would silently reclassify it as share-alike.
  validateLicence(aggDesc({ spdx: 'CC-ODC-BY-SA-4.0' })); // must NOT throw
  // control: the genuine ODC- prefixed database licence IS share-alike, refused.
  assertThrows(() => validateLicence(aggDesc({ spdx: 'ODC-ODbL-1.0' })), Error, 'must not claim');
});

// ===========================================================================
// THE §4.6 NOTICE MUST BE REAL — a whitespace-only notice is no notice.
// ===========================================================================
Deno.test('a whitespace-only §4.6 notice does not satisfy a derivative database', () => {
  // DEFECT (L186 x3): condition→false, dropping .trim(), and swapping the empty
  // string literal each let a notice made only of spaces pass as present, so a
  // derivative database would ship with an unreadable availability statement. The
  // sibling suite covers a MISSING notice; the whitespace-only case is the gap.
  assertThrows(
    () => validateLicence(dbDesc({ dataAvailabilityNotice: '   ' })),
    Error,
    'data-availability notice',
  );
  // control: a real notice is accepted — this is not a blanket refusal.
  validateLicence(dbDesc({ dataAvailabilityNotice: 'The full database is available under the ODbL.' }));
});

// ===========================================================================
// THE LICENCE BLOCK — the sentence and the conditional fields.
// ===========================================================================
Deno.test('the derivative-database licence block states it IS a re-usable database under its SPDX', () => {
  // DEFECT (L238): emptying the derivative notice ships a block whose human sentence
  // no longer declares the share-alike obligation.
  const block = buildLicenceBlock(dbDesc());
  assertStringIncludes(block.notice, 'Derivative Database');
  assertStringIncludes(block.notice, 'ODbL-1.0'); // the SPDX is interpolated in
  assertStringIncludes(block.notice, 'redistributed under the same licence');
});

Deno.test('the aggregate licence block states it is NOT a re-usable database', () => {
  // DEFECT (L239): emptying the aggregate notice drops the sentence that keeps a
  // picture of numbers from reading as a redistributable database.
  const block = buildLicenceBlock(aggDesc({ spdx: 'CC-BY-4.0' }));
  assertStringIncludes(block.notice, 'aggregate figures');
  assertStringIncludes(block.notice, 'not offered as a re-usable database');
  assertStringIncludes(block.notice, 'CC-BY-4.0');
});

Deno.test('optional licence-block fields appear only when the descriptor carries them', () => {
  // DEFECT: turning a guarded assignment unconditional (L241 → true, L242 → true,
  // L243 → true) stamps an `undefined`-valued key onto an artifact that should omit
  // it; dropping the guard (L241 → false) strips a URL the descriptor DID carry.
  const bare = buildLicenceBlock(aggDesc()); // no attributionUrl, licenceUrl or notice
  assert(!Object.hasOwn(bare, 'attribution_url'), 'attribution_url must be absent when unset'); // L241 → true
  assert(!Object.hasOwn(bare, 'licence_url'), 'licence_url must be absent when unset'); // L242 → true
  assert(!Object.hasOwn(bare, 'data_availability'), 'aggregate carries no availability notice'); // L243 → true
  // control: the same fields ARE present when supplied.
  const full = buildLicenceBlock(aggDesc({ attributionUrl: 'https://example.org/attr', licenceUrl: 'https://example.org/lic' }));
  assertEquals(full.attribution_url, 'https://example.org/attr'); // L241 → false
  assertEquals(full.licence_url, 'https://example.org/lic');
});

// ===========================================================================
// THE LICENCE REGISTER — the verified strings, asserted against literals.
// ===========================================================================
Deno.test("the licence register carries each feed's verified attribution and licence URLs", () => {
  // DEFECT (L262, L263, L273): emptying any register URL ships an artifact missing
  // the attribution or licence link its terms require.
  const wb = LICENCE_REGISTER.worldbank_reference;
  assertEquals(wb.attributionUrl, 'https://data.worldbank.org/summary-terms-of-use');
  assertEquals(wb.licenceUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assertEquals(LICENCE_REGISTER.osm_worship_points.attributionUrl, 'https://www.openstreetmap.org/copyright');
});

Deno.test('the OSM §4.6 availability notice states the licence, the freedoms and the attribution', () => {
  // DEFECT (L275/276/277): emptying any of the three concatenated fragments drops a
  // required part of the ODbL §4.6 statement while leaving the rest intact. Each
  // substring below is unique to one fragment.
  const notice = LICENCE_REGISTER.osm_worship_points.dataAvailabilityNotice ?? '';
  assertStringIncludes(notice, 'This file is a Derivative Database of OpenStreetMap'); // L275
  assertStringIncludes(notice, 'Open Database License (ODbL) v1.0'); // L276
  assertStringIncludes(notice, 'the same licence, and must attribute'); // L277
});

// ===========================================================================
// THE POINTER — the two clocks, and the array it echoes.
// ===========================================================================
Deno.test('the source clock defaults to the newest release token, and the input array is never reordered', () => {
  // DEFECT: forcing the clock-2 default (L456 ConditionalExpression → true, and
  // EqualityOperator !== → ===) would drop the computed max in favour of the unset
  // option; dropping the [...spread] copy (L456 MethodExpression) sorts the
  // snapshot's own release_versions IN PLACE, so the pointer echoes a reordered
  // list and the caller's array is silently mutated.
  const snap = makeSnapshot({ feedKey: 'osm_worship_points', releaseVersions: ['2026-12-31', '2026-01-01', '2026-06-15'] });
  const pointer: PointerDoc = JSON.parse(planPublish(snap, { clock: 'geometry' }).objects.find((o) => o.kind === 'pointer')!.body);
  assertEquals(pointer.source_changed_at, '2026-12-31'); // clock 2 = the max token
  assertEquals(pointer.release_versions, ['2026-12-31', '2026-01-01', '2026-06-15']); // ORDER GIVEN, not sorted
  assertEquals(snap.release_versions, ['2026-12-31', '2026-01-01', '2026-06-15']); // caller's array untouched
});

Deno.test('an explicit sourceChangedAt is used verbatim; explicit null is preserved', () => {
  // DEFECT (L456 EqualityOperator): inverting `!== undefined` to `=== undefined`
  // ignores a provided clock-2 value and substitutes the release max, and turns an
  // explicit null ("source clock unknown") into a computed date.
  const snap = makeSnapshot({ feedKey: 'osm_worship_points', releaseVersions: ['2026-01-01'] });
  const provided: PointerDoc = JSON.parse(
    planPublish(snap, { clock: 'geometry', sourceChangedAt: '2099-12-31T00:00:00.000Z' }).objects.find((o) => o.kind === 'pointer')!.body,
  );
  assertEquals(provided.source_changed_at, '2099-12-31T00:00:00.000Z'); // NOT the release token
  const nulled: PointerDoc = JSON.parse(
    planPublish(snap, { clock: 'geometry', sourceChangedAt: null }).objects.find((o) => o.kind === 'pointer')!.body,
  );
  assertEquals(nulled.source_changed_at, null); // an explicit null, NOT '2026-01-01'
});

Deno.test('the pointer declares its schema version', () => {
  // DEFECT (L459): emptying the schema tag ships a pointer a client cannot
  // recognise or version-gate.
  const snap = makeSnapshot({ feedKey: 'worldbank_reference', releaseVersions: ['2026-07-13'] });
  const pointer: PointerDoc = JSON.parse(planPublish(snap, { clock: 'reference' }).objects.find((o) => o.kind === 'pointer')!.body);
  assertEquals(pointer.schema_version, 'atlas.pointer.v1');
});

// ===========================================================================
// THE PLAN TOTAL — the number a human signs off on.
// ===========================================================================
Deno.test("the plan total equals the sum of its objects' bytes and is a positive count", () => {
  // DEFECT (L482): a reduce that returns undefined (ArrowFunction → () => undefined)
  // or subtracts (ArithmeticOperator n - o.bytes) under-reports the upload size.
  const snap = makeSnapshot({ feedKey: 'worldbank_reference', releaseVersions: ['2026-07-13'] });
  const plan = planPublish(snap, { clock: 'reference' });
  assertEquals(plan.objects.length, 2); // exactly the artifact and the pointer
  assertEquals(plan.totalBytes, plan.objects[0].bytes + plan.objects[1].bytes); // sum of the parts
  assert(plan.totalBytes > 0, 'total upload size must be a positive byte count');
});

// ===========================================================================
// THE DRY-RUN REPORT — the human reads exactly this.
// ===========================================================================
Deno.test('the dry-run report prints each header field, the size line, and no stray marker text', () => {
  // DEFECT: L500 (array pre-filled with marker text), L501/L502/L503 (emptied
  // header labels), L504/L509/L512 (blank separators replaced by marker text),
  // L508 (emptied size line) and L516 (return '' instead of the joined report).
  const snap = makeSnapshot({ feedKey: 'worldbank_reference', releaseVersions: ['2026-07-13'], contentHash: 'feed00c0ffee' });
  const plan = planPublish(snap, { clock: 'reference' });
  const report = formatPlan(plan, { willUpload: false });
  const lines = report.split('\n');
  assertEquals(lines[0], 'feed:   worldbank_reference'); // L500 prefill, L501 empty
  assertEquals(lines[1], 'clock:  reference'); // L502 empty
  assertEquals(lines[2], 'hash:   feed00c0ffee'); // L503 empty
  assertEquals(lines[3], ''); // L504 separator (a mutant makes it marker text)
  const artifactBytes = plan.objects.find((o) => o.kind === 'artifact')!.bytes;
  assertStringIncludes(report, 'size:'); // L508 label present
  assertStringIncludes(report, `(${artifactBytes} bytes)`); // L508 real byte count present
  assert(!report.includes('Stryker'), 'no mutant marker text may leak into the report'); // L500, L504, L509, L512
  assert(report.length > 0, 'the report is the joined lines, not an empty string'); // L516
  assertStringIncludes(report, 'total upload size:');
});
