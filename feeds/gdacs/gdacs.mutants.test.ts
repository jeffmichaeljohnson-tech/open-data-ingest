/**
 * gdacs.mutants.test.ts — mutation-hardening tests for the pure GDACS layer.
 *
 * These sit BESIDE gdacs.test.ts and never duplicate it: each test here pins a
 * specific behaviour a generated mutant proved was unobserved (a survived mutant).
 * The comment on each test names the DEFECT it prevents, in the vocabulary of this
 * project's SECURITY.md threat model: a malformed response reading as empty, an
 * absence collapsing into a fake zero, a bare (vintage-less) record, a content hash
 * that stops moving with the data or starts moving with the clock, and a coordinate
 * sentinel that gets stored instead of skipped.
 *
 * No network, no filesystem, no permissions beyond --allow-read. Every assertion can
 * fail (there are no tautologies), and the throwing/skipping tests are paired with a
 * positive control so a function that ALWAYS threw or ALWAYS skipped would be caught.
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { buildGdacsSnapshot, coordsFromGeometry, gdacsAttribution, type GdacsFeature, normalizeGdacsTimestamp, parseGdacsResponse, transformGdacsFeatures } from './gdacs.ts';

const OPTS = { retrievedAt: '2026-08-17T22:00:00.000Z', licenceKey: 'gdacs_cc_by_4' };

/** A minimal well-formed feature; `extra` overrides its properties. */
function feat(extra: Record<string, unknown> = {}, geometry: GdacsFeature['geometry'] = { type: 'Point', coordinates: [10, 20] }): GdacsFeature {
  return {
    type: 'Feature',
    geometry,
    properties: {
      eventtype: 'FL',
      eventid: 1104081,
      episodeid: 9,
      fromdate: '2026-08-14T21:58:21',
      datemodified: '2026-08-17T09:28:28',
      ...extra,
    },
  };
}

// ===========================================================================
// PARSE — a shape we do not understand must THROW, never read as empty. Each
// branch of the shape guard is pinned with a NAMED message so a mutant that
// collapses the branch (→false/→true) or swaps its equality surfaces.
// ===========================================================================

Deno.test('parse: a null body throws and names it "null" (not "object") — L218/L219 guard + ternary', () => {
  // Mutants: `body === null || …` → false (would proceed and later crash with a
  // different message); the `body === null` ternary → `body !== null` (would print
  // "object"). Asserting the message says "is null" refutes both.
  assertThrows(() => parseGdacsResponse(null), Error, 'is null');
});

Deno.test('parse: a numeric body throws and names it "number" — the non-object branch', () => {
  // A 200 that decoded to a bare number is not a FeatureCollection. If the L218
  // guard is disabled the message would name a different shape or crash elsewhere.
  assertThrows(() => parseGdacsResponse(42), Error, 'is number');
  assertThrows(() => parseGdacsResponse(true), Error, 'is boolean');
});

Deno.test('parse: wrong `type` WITH a features array still throws — L226 is not skippable', () => {
  // The dangerous mutant here is L226 `if (obj.type !== 'FeatureCollection')` → false:
  // a payload from a DIFFERENT endpoint that happens to carry a `features: []` would
  // then parse as zero events — a foreign shape read as "nothing happened". The empty
  // features array is the trap; the type check must still refuse it.
  assertThrows(() => parseGdacsResponse({ type: 'Topology', features: [] }), Error, 'expected "FeatureCollection"');
});

Deno.test('parse: FeatureCollection whose `features` is not an array throws — L231/L232', () => {
  // Mutant L231 `if (!Array.isArray(obj.features))` → false would let a non-array
  // `features` through to be spread as zero rows. It must throw instead.
  assertThrows(() => parseGdacsResponse({ type: 'FeatureCollection', features: 'nope' }), Error, 'no `features` array');
  // positive control: a real (empty) collection parses to zero features, no throw.
  assertEquals(parseGdacsResponse({ type: 'FeatureCollection', features: [] }).length, 0);
});

// ===========================================================================
// normalizeGdacsTimestamp — L255/L256 guard + trim.
// ===========================================================================

Deno.test('normalizeGdacsTimestamp: null/undefined return null WITHOUT throwing — L255 guard', () => {
  // Mutant L255 `if (!raw || …)` → false removes the guard, so `raw.trim()` runs on
  // null and throws. Passing null/undefined and expecting a clean null refutes it.
  assertEquals(normalizeGdacsTimestamp(null), null);
  assertEquals(normalizeGdacsTimestamp(undefined), null);
});

Deno.test('normalizeGdacsTimestamp: surrounding whitespace is trimmed before parsing — L256 .trim()', () => {
  // Mutant L256 `raw.trim()` → `raw` leaves the trailing spaces, so the tz regex
  // fails to match `$`, a `Z` is appended after the spaces, and Date.parse yields
  // NaN → null. The correct code trims first and parses to a real instant.
  assertEquals(normalizeGdacsTimestamp('  2026-08-14T21:58:21  '), '2026-08-14T21:58:21.000Z');
  // A timestamp that already carries an explicit offset must NOT get a second Z
  // (guards the L260 tz-detection regex against dropping its `$` anchor / classes).
  assertEquals(normalizeGdacsTimestamp('2026-08-14T21:58:21+02:00'), '2026-08-14T19:58:21.000Z');
});

// ===========================================================================
// coordsFromGeometry — every sentinel and range boundary. SECURITY.md item 5:
// Null Island, out-of-range and non-finite coordinates are SKIPPED, never stored.
// ===========================================================================

Deno.test('coords: an undefined geometry returns null without throwing — L275 guard', () => {
  // Mutant L275 `if (!geometry || …)` → false dereferences `geometry.coordinates`
  // on undefined and throws. A clean null is the correct answer.
  assertEquals(coordsFromGeometry(undefined), null);
});

Deno.test('coords: a NaN coordinate is rejected, never returned — L281 finiteness guard', () => {
  // Mutant L281 `if (!Number.isFinite(lon) || !Number.isFinite(lat))` → false would
  // let NaN slip past every downstream range test (NaN < -180 is false, etc.) and be
  // RETURNED as a stored point. NaN is a corruption, not a location. Infinity is
  // covered by the range test; NaN is only covered here, so it is the load-bearing case.
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [NaN, 10] }), null);
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [10, NaN] }), null);
});

Deno.test('coords: the range boundaries ±180/±90 are INCLUSIVE (valid), just-outside is not — L282 <>', () => {
  // Mutants L282 `lon < -180` → `lon <= -180` (and the three siblings) would reject a
  // legitimate antimeridian/pole point. The valid extremes must survive; only values
  // strictly beyond are rejected. This pins the comparison operator in both directions.
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [-180, 10] }), { lon: -180, lat: 10 });
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [180, 10] }), { lon: 180, lat: 10 });
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [10, -90] }), { lon: 10, lat: -90 });
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [10, 90] }), { lon: 10, lat: 90 });
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [180.0001, 10] }), null);
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [10, -90.0001] }), null);
});

Deno.test('coords: Null Island needs BOTH axes zero — a point ON the meridian/equator survives — L283 &&', () => {
  // Mutant L283 `lon === 0 && lat === 0` → `||` would discard every valid point that
  // merely sits on the prime meridian or the equator. (0,0) is the sentinel; (0,10)
  // and (10,0) are real places and must be kept. The `→ true` mutant (always null) is
  // refuted by the same surviving points.
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [0, 0] }), null);
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [0, 10] }), { lon: 0, lat: 10 });
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [10, 0] }), { lon: 10, lat: 0 });
});

// ===========================================================================
// TRANSFORM — schema-drift throws, code normalisation, missing-id skips, and the
// display-field mapping (every survived StringLiteral/MethodExpression on L305-L379).
// ===========================================================================

Deno.test('transform: a null feature or null/primitive properties throws schema drift — L305', () => {
  // Mutant L305 collapses the four-way guard; a null feature or a feature whose
  // `properties` is null or a string must be refused as schema drift, never read as
  // an empty batch. Positive control: a normal feature yields one event.
  assertThrows(() => transformGdacsFeatures([null as unknown as GdacsFeature], OPTS), Error, 'schema drift');
  assertThrows(() => transformGdacsFeatures([{ type: 'Feature', properties: null } as unknown as GdacsFeature], OPTS), Error, 'schema drift');
  assertThrows(() => transformGdacsFeatures([{ type: 'Feature', properties: 'x' } as unknown as GdacsFeature], OPTS), Error, 'schema drift');
  assertEquals(transformGdacsFeatures([feat()], OPTS).events.length, 1);
});

Deno.test('transform: eventtype is trimmed AND upper-cased before the type lookup — L309', () => {
  // Mutant L309 dropping `.trim().toUpperCase()` leaves '  fl  ' unmapped, so a real
  // flood would be mislabelled the generic 'disaster' and keep a ragged code. The
  // normalisation is what lets the readable type resolve.
  const { events } = transformGdacsFeatures([feat({ eventtype: '  fl  ' })], OPTS);
  assertEquals(events[0].event_type, 'flood');
  assertEquals(events[0].event_type_code, 'FL');
});

Deno.test('transform: a missing eventtype yields code "XX", not a Stryker sentinel — L309/L367 ??/||', () => {
  // Mutant L309 `?? ''` → `?? 'Stryker was here!'` (or L367 `code || 'XX'` → `code && 'XX'`)
  // would poison the provenance code. With no eventtype the code must fall back to 'XX'.
  const { events } = transformGdacsFeatures([feat({ eventtype: undefined })], OPTS);
  assertEquals(events[0].event_type_code, 'XX');
  assertEquals(events[0].event_type, 'disaster');
  assertStringIncludes(events[0].external_id, 'XX-1104081-9');
});

Deno.test('transform: an empty-string id is treated as MISSING, not emitted — L314/L315 === "" ', () => {
  // SECURITY.md "absence is not a record": a blank eventid/episodeid cannot form a
  // stable dedup key. Mutants that drop the `=== ''` clause (or swap the literal for
  // "Stryker was here!") would emit a row keyed on an empty id. It must skip instead.
  const emptyEvent = transformGdacsFeatures([feat({ eventid: '' })], OPTS);
  assertEquals(emptyEvent.events.length, 0);
  assertEquals(emptyEvent.skipped[0].reason, 'missing_ids');
  const emptyEpisode = transformGdacsFeatures([feat({ episodeid: '' })], OPTS);
  assertEquals(emptyEpisode.events.length, 0);
  assertEquals(emptyEpisode.skipped[0].reason, 'missing_ids');
  // positive control: real ids are NOT skipped.
  assertEquals(transformGdacsFeatures([feat()], OPTS).skipped.length, 0);
});

Deno.test('transform: a missing-id skip records the real eventtype, or "unknown" when absent — L317 ||', () => {
  // Mutant L317 `code || 'unknown'` → `code && 'unknown'` (or the '' literal) would
  // mislabel the skip. A present code must survive into the skip row; an absent one
  // must read 'unknown'.
  const withCode = transformGdacsFeatures([feat({ eventtype: 'tc', eventid: undefined })], OPTS);
  assertEquals(withCode.skipped[0].eventtype, 'TC');
  const noCode = transformGdacsFeatures([feat({ eventtype: undefined, eventid: undefined })], OPTS);
  assertEquals(noCode.skipped[0].eventtype, 'unknown');
});

Deno.test('transform: affected_iso3 is trimmed, empties dropped, null members survive — L349', () => {
  // One rich case pins the whole L349 chain: the map, the `c?.iso3` optional chain
  // (a null member would throw without it), the `?? ''` default, the `.trim()`, and
  // the `.filter(s => s !== '')`. The result must be exactly the two real codes.
  const { events } = transformGdacsFeatures([
    feat({ affectedcountries: [{ iso3: 'PHL' }, { iso3: '  IDN  ' }, { iso3: '' }, {}, null] }),
  ], OPTS);
  assertEquals(events[0].affected_iso3, ['PHL', 'IDN']);
  // and when the field is absent the result is [], never ['Stryker was here'] (L349 ArrayDeclaration)
  const { events: none } = transformGdacsFeatures([feat({ affectedcountries: undefined })], OPTS);
  assertEquals(none[0].affected_iso3, []);
});

Deno.test('transform: display fields are carried, trimmed and verbatim — L354/L370-L379', () => {
  // Pins the string-valued snapshot fields against their StringLiteral/MethodExpression
  // (`.trim()` removal) and OptionalChaining mutants. Each must equal the trimmed source.
  const { events } = transformGdacsFeatures([feat({
    name: '  Cyclone DOLPHIN  ',
    alertlevel: '  Orange  ',
    severitydata: { severity: 5, severitytext: '  strong  ', severityunit: '  kmh  ' },
    iso3: '  PHL  ',
    glide: '  GX-1  ',
    url: { report: '  http://r  ' },
  })], OPTS);
  const e = events[0];
  assertEquals(e.feed_key, 'gdacs_events');
  assertEquals(e.name, 'Cyclone DOLPHIN');
  assertEquals(e.alert_level, 'Orange');
  assertEquals(e.severity_text, 'strong');
  assertEquals(e.severity_unit, 'kmh');
  assertEquals(e.source_country_claim, 'PHL');
  assertEquals(e.glide, 'GX-1');
  assertEquals(e.report_url, 'http://r');
});

Deno.test('transform: report_url tolerates an absent `url` object via optional chaining — L379', () => {
  // Mutant L379 `p.url?.report` → `p.url.report` throws when a feature carries no url.
  // A missing url must yield an empty string, not a crash.
  const { events } = transformGdacsFeatures([feat({ url: undefined })], OPTS);
  assertEquals(events[0].report_url, '');
});

Deno.test('transform: alert_score / severity_value keep a real number but null a non-number — L372/L373', () => {
  // Mutants force the ternary to a constant or invert its `typeof … === 'number'`.
  // A numeric score is carried; a non-number becomes null (never the raw value, never
  // a fabricated 0).
  const numeric = transformGdacsFeatures([feat({ alertscore: 3, severitydata: { severity: 7 } })], OPTS).events[0];
  assertEquals(numeric.alert_score, 3);
  assertEquals(numeric.severity_value, 7);
  const nonNumeric = transformGdacsFeatures([feat({ alertscore: 'high', severitydata: { severity: 'big' } })], OPTS).events[0];
  assertEquals(nonNumeric.alert_score, null);
  assertEquals(nonNumeric.severity_value, null);
});

// ===========================================================================
// SNAPSHOT — content hash, sort order, alert tally, attribution, canonicalJson.
// ===========================================================================

Deno.test('snapshot: the top-level identity strings are exact — L539/L541', async () => {
  // Mutants blanking `schema_version: 'atlas.snapshot.v1'` / `source: 'GDACS'` on the
  // RETURNED object are caught here; the same literals inside the hash core are caught
  // by the golden-hash test below.
  const { events } = transformGdacsFeatures([feat()], OPTS);
  const snap = await buildGdacsSnapshot(events, { feedKey: 'gdacs_events', licenceKey: 'gdacs_cc_by_4', generatedAt: '2026-08-17T22:00:00.000Z' });
  assertEquals(snap.schema_version, 'atlas.snapshot.v1');
  assertEquals(snap.source, 'GDACS');
  assertEquals(snap.feed_key, 'gdacs_events');
});

Deno.test('snapshot: events are sorted by external_id, so row order never perturbs the hash — L513', async () => {
  // Mutant L513 `.sort((a,b) => …)` → `() => undefined` leaves the input order intact.
  // Feeding events deliberately out of order and asserting the sorted output refutes it.
  const feats = [
    feat({ eventtype: 'FL', eventid: 900, episodeid: 1 }), // external_id FL-900-1
    feat({ eventtype: 'FL', eventid: 100, episodeid: 1 }), // external_id FL-100-1
  ];
  const { events } = transformGdacsFeatures(feats, OPTS);
  const snap = await buildGdacsSnapshot(events, { feedKey: 'gdacs_events', licenceKey: 'gdacs_cc_by_4', generatedAt: 'now' });
  assertEquals(snap.events.map((e) => e.external_id), ['FL-100-1', 'FL-900-1']);
});

Deno.test('snapshot: an empty alert level tallies under "Unspecified", not "" — L517 ||', async () => {
  // Mutant L517 `e.alert_level || 'Unspecified'` → `… || ''` would bucket unlabelled
  // events under an empty key. GDACS's own labels are the source's; an absent one is
  // explicitly "Unspecified", never a blank.
  const { events } = transformGdacsFeatures([feat({ alertlevel: '' })], OPTS);
  const snap = await buildGdacsSnapshot(events, { feedKey: 'gdacs_events', licenceKey: 'gdacs_cc_by_4', generatedAt: 'now' });
  assertEquals(snap.alert_level_counts, { Unspecified: 1 });
});

Deno.test('snapshot: an explicit attributionYear is honoured over the generatedAt year — L521 ??', async () => {
  // Mutant L521 `meta.attributionYear ?? new Date(generatedAt)…` → `&&` would discard
  // the caller's explicit year and always compute it from the wall clock.
  const { events } = transformGdacsFeatures([feat()], OPTS);
  const snap = await buildGdacsSnapshot(events, {
    feedKey: 'gdacs_events',
    licenceKey: 'gdacs_cc_by_4',
    generatedAt: '2030-01-01T00:00:00.000Z',
    attributionYear: 2019,
  });
  assertStringIncludes(snap.attribution, '2019');
  assert(!snap.attribution.includes('2030'));
});

Deno.test('gdacsAttribution: carries GDACS, the EU, the year and CC BY 4.0 verbatim', () => {
  // The exact wording is a licence CONDITION (SECURITY.md: an artifact must carry its
  // obligations). Pins the L457 template's fixed segments against StringLiteral blanks.
  const line = gdacsAttribution(2026);
  assertStringIncludes(line, 'GDACS');
  assertStringIncludes(line, 'European Union');
  assertStringIncludes(line, '2026');
  assertStringIncludes(line, 'CC BY 4.0');
});

Deno.test('snapshot: content hash is a stable golden over fixed data — pins canonicalJson (L438-L442) + hash core (L528/L530)', async () => {
  // The golden below was produced by the unmutated builder over this exact fixture.
  // ANY change to the canonical serialisation — a dropped `Object.keys().sort()`, a
  // blanked '{'/':'/'}' or '['/','/']' delimiter, a flipped null/array branch — or to
  // a hash-core identity string moves this digest, so every such survived mutant fails
  // here. The nested affected_iso3 array and the unsorted event-object keys are chosen
  // deliberately so the array and object code paths of canonicalJson are exercised.
  const coll = {
    type: 'FeatureCollection',
    features: [feat({
      eventtype: 'FL',
      name: 'Flood X',
      alertlevel: 'Red',
      alertscore: 3,
      affectedcountries: [{ iso3: 'PHL' }, { iso3: 'IDN' }],
      severitydata: { severity: 42, severitytext: 'big', severityunit: 'ha' },
      glide: 'G1',
      url: { report: 'http://x' },
    })],
  };
  const { events } = transformGdacsFeatures(parseGdacsResponse(coll), OPTS);
  const snap = await buildGdacsSnapshot(events, {
    feedKey: 'gdacs_events',
    licenceKey: 'gdacs_cc_by_4',
    generatedAt: '2026-08-17T22:00:00.000Z',
    attributionYear: 2026,
  });
  assertEquals(snap.content_hash, '9d242d1cd518af91213ba0afa96c48563f014dbd24c440ffe86358f77177a528');
  assertEquals(snap.content_hash.length, 64);

  // And the hash MOVES when the data moves (a real severity change), so the golden is
  // pinning content, not merely a constant. Clock-independence is proven in gdacs.test.ts.
  const moved = events.map((e) => ({ ...e, severity_value: 43 }));
  const movedSnap = await buildGdacsSnapshot(moved, { feedKey: 'gdacs_events', licenceKey: 'gdacs_cc_by_4', generatedAt: '2026-08-17T22:00:00.000Z', attributionYear: 2026 });
  assertNotEquals(movedSnap.content_hash, snap.content_hash);
});
