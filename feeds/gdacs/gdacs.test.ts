/**
 * gdacs.test.ts — offline tests for the pure GDACS layer.
 *
 * Run with `deno test` from this directory. Deno is chosen deliberately: this is a
 * Supabase Edge Function, Deno IS its runtime, and `deno test` runs the TypeScript
 * with no build step and no dependency on apps/web's vitest (which this lane must not
 * touch). Every test is fixture-driven — no network, no database — because the whole
 * reason gdacs.ts is split from index.ts is that its logic is provable offline. The
 * fixtures mirror the shape VERIFIED LIVE 2026-08-17 against the GDACS SEARCH
 * endpoint (a FeatureCollection of Point features with EQ/FL/TC/WF/DR/VO types).
 */
import {
  assert,
  assertEquals,
  assertThrows,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  parseGdacsResponse,
  transformGdacsFeatures,
  buildGdacsSnapshot,
  coordsFromGeometry,
  normalizeGdacsTimestamp,
  type GdacsFeature,
} from './gdacs.ts';
import {
  buildEventInsert,
  buildLicenceSeed,
  buildFeedSeed,
  buildHeartbeatUpsert,
} from './sql.ts';

// A GDACS feature shaped exactly like the live response (fields trimmed to what we read).
function feature(
  eventtype: string,
  eventid: number,
  episodeid: number,
  coords: [number, number] | null,
  extra: Record<string, unknown> = {},
): GdacsFeature {
  return {
    type: 'Feature',
    geometry: coords === null ? null : { type: 'Point', coordinates: coords },
    properties: {
      eventtype,
      eventid,
      episodeid,
      name: `${eventtype} event ${eventid}`,
      alertlevel: 'Orange',
      alertscore: 2,
      fromdate: '2026-08-14T21:58:21',
      datemodified: '2026-08-17T09:28:28',
      iso3: 'PHL',
      affectedcountries: [{ iso2: 'PH', iso3: 'PHL', countryname: 'Philippines' }],
      severitydata: { severity: 18419, severitytext: 'Orange impact', severityunit: 'ha' },
      glide: 'XX-2026-000001-PHL',
      url: { report: 'https://www.gdacs.org/report.aspx?eventid=' + eventid },
      ...extra,
    },
  };
}

function collection(features: GdacsFeature[]): unknown {
  return { type: 'FeatureCollection', features, bbox: [0, 0, 0, 0] };
}

const OPTS = { retrievedAt: '2026-08-17T22:00:00.000Z', licenceKey: 'gdacs_cc_by_4' };

// ---------------------------------------------------------------------------
// 1. WELL-FORMED RESPONSE
// ---------------------------------------------------------------------------
Deno.test('well-formed response — floods/cyclones/droughts/wildfires/volcanoes map to readable types', () => {
  const feats = parseGdacsResponse(
    collection([
      feature('FL', 1104081, 9, [119.9017, 30.8308]),
      feature('TC', 1001297, 55, [120.6, 27.9]),
      feature('DR', 1027465, 3, [33.577, 1.115]),
      feature('WF', 1029987, 18, [23.2591, 38.122]),
      feature('VO', 1000144, 1, [123.685, 13.257]),
    ]),
  );
  const { events, skipped } = transformGdacsFeatures(feats, OPTS);
  assertEquals(skipped.length, 0);
  assertEquals(events.map((e) => e.event_type).sort(), ['cyclone', 'drought', 'flood', 'volcano', 'wildfire']);
  const flood = events.find((e) => e.event_type === 'flood')!;
  assertEquals(flood.external_id, 'FL-1104081-9'); // episode-keyed
  assertEquals(flood.lon, 119.9017);
  assertEquals(flood.lat, 30.8308);
  assertEquals(flood.source, 'GDACS');
  assertEquals(flood.release_version, '2026-08-17T09:28:28.000Z'); // datemodified vintage
  assertEquals(flood.occurred_at, '2026-08-14T21:58:21.000Z'); // fromdate, normalised to UTC
  assertEquals(flood.licence_key, 'gdacs_cc_by_4');
});

Deno.test('well-formed response — magnitude stays NULL (GDACS severity has no summable home)', () => {
  const feats = parseGdacsResponse(collection([feature('WF', 1029987, 18, [23.2591, 38.122])]));
  const { events } = transformGdacsFeatures(feats, OPTS);
  assertEquals(events[0].magnitude, null);
  assertEquals(events[0].magnitude_kind, null);
  // …but the severity IS carried, for the snapshot, verbatim and attributed.
  assertEquals(events[0].severity_value, 18419);
  assertEquals(events[0].severity_unit, 'ha');
});

Deno.test('border rule — the transform NEVER sets any attribution field; only the geom is supplied', () => {
  const feats = parseGdacsResponse(collection([feature('FL', 1, 1, [119.9, 30.8], { iso3: 'CHN' })]));
  const { events } = transformGdacsFeatures(feats, OPTS);
  const e = events[0] as unknown as Record<string, unknown>;
  // GDACS claims a country (iso3=CHN); it is carried for DISPLAY only, never as attribution.
  assertEquals(e.source_country_claim, 'CHN');
  // None of the attribution columns exist on the emitted record — the DB trigger owns them.
  assertEquals('attribution_level' in e, false);
  assertEquals('pip_iso_a3' in e, false);
  assertEquals('public_country_iso_a3' in e, false);
});

// ---------------------------------------------------------------------------
// 2. AN EVENT WITH NO COORDINATES — emitted UNLOCATED, never dropped.
// ---------------------------------------------------------------------------
Deno.test('no coordinates — the event is emitted with a null geom, not discarded', () => {
  const feats = parseGdacsResponse(collection([feature('FL', 7, 2, null)]));
  const { events, skipped } = transformGdacsFeatures(feats, OPTS);
  assertEquals(skipped.length, 0);
  assertEquals(events.length, 1); // NOT dropped — absence must never read as peace
  assertEquals(events[0].lon, null);
  assertEquals(events[0].lat, null);
});

Deno.test('coordsFromGeometry — Null Island and out-of-range coordinates become null (unlocated)', () => {
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [0, 0] }), null); // Null Island sentinel
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [200, 10] }), null); // lon out of range
  assertEquals(coordsFromGeometry(null), null);
  assertEquals(coordsFromGeometry({ type: 'Point', coordinates: [12.5, -7.25] }), { lon: 12.5, lat: -7.25 });
});

// ---------------------------------------------------------------------------
// 3. AN UNKNOWN EVENT TYPE — mapped to the generic 'disaster', never dropped.
// ---------------------------------------------------------------------------
Deno.test('unknown event type — a code we do not recognise becomes generic disaster, not a drop', () => {
  const feats = parseGdacsResponse(collection([feature('XX', 999, 1, [10, 10])]));
  const { events, skipped } = transformGdacsFeatures(feats, OPTS);
  assertEquals(skipped.length, 0);
  assertEquals(events.length, 1);
  assertEquals(events[0].event_type, 'disaster'); // graceful, not thrown
  assertEquals(events[0].event_type_code, 'XX'); // raw code kept for provenance
});

// ---------------------------------------------------------------------------
// 4. AN EMPTY LIST — a genuinely quiet window is DATA, not an error, not a throw.
// ---------------------------------------------------------------------------
Deno.test('empty list — zero features parses cleanly and yields zero events (no throw)', () => {
  const feats = parseGdacsResponse(collection([]));
  assertEquals(feats.length, 0);
  const { events, skipped } = transformGdacsFeatures(feats, OPTS);
  assertEquals(events.length, 0);
  assertEquals(skipped.length, 0);
});

// ---------------------------------------------------------------------------
// 5. A RESPONSE SHAPE YOU DO NOT UNDERSTAND — MUST THROW, never return zero rows.
// ---------------------------------------------------------------------------
Deno.test('unknown shape — a non-FeatureCollection object THROWS rather than reading as empty', () => {
  assertThrows(() => parseGdacsResponse({ hello: 'world' }), Error, 'not understood');
});

Deno.test('unknown shape — GDACS error object THROWS and surfaces its message', () => {
  // The live endpoint returns exactly this when a required param is missing.
  assertThrows(() => parseGdacsResponse({ message: 'Eventtype is required.' }), Error, 'Eventtype is required');
});

Deno.test('unknown shape — an HTML/WAF string body THROWS', () => {
  assertThrows(() => parseGdacsResponse('<!doctype html><html>...'), Error, 'bare string');
});

Deno.test('unknown shape — a feature missing its properties object THROWS (schema drift, not empty)', () => {
  const feats = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }] as GdacsFeature[];
  assertThrows(() => transformGdacsFeatures(feats, OPTS), Error, 'schema drift');
});

// ---------------------------------------------------------------------------
// EARTHQUAKE EXCLUSION — recorded, not silent; overridable.
// ---------------------------------------------------------------------------
Deno.test('earthquakes are excluded by default (usgs_quakes covers them) and RECORDED not silent', () => {
  const feats = parseGdacsResponse(
    collection([feature('EQ', 1558059, 1725109, [121.3517, -8.3101]), feature('FL', 1, 1, [10, 10])]),
  );
  const { events, skipped } = transformGdacsFeatures(feats, OPTS);
  assertEquals(events.map((e) => e.event_type), ['flood']); // EQ absent from the output
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0].reason, 'earthquake_excluded'); // absence is explained, not silent
});

Deno.test('earthquakes CAN be included with includeEarthquakes', () => {
  const feats = parseGdacsResponse(collection([feature('EQ', 1558059, 1725109, [121.3517, -8.3101])]));
  const { events } = transformGdacsFeatures(feats, { ...OPTS, includeEarthquakes: true });
  assertEquals(events.length, 1);
  assertEquals(events[0].event_type, 'earthquake');
});

// ---------------------------------------------------------------------------
// MISSING IDS / DATES — recorded skips (cannot form a key / satisfy NOT NULL).
// ---------------------------------------------------------------------------
Deno.test('a feature with no eventid is skipped with a recorded reason (cannot dedup)', () => {
  const f = feature('FL', 1, 1, [10, 10]);
  delete (f.properties as Record<string, unknown>).eventid;
  const { events, skipped } = transformGdacsFeatures([f], OPTS);
  assertEquals(events.length, 0);
  assertEquals(skipped[0].reason, 'missing_ids');
});

Deno.test('a feature with no parseable date is skipped (occurred_at is NOT NULL)', () => {
  const f = feature('FL', 1, 1, [10, 10]);
  (f.properties as Record<string, unknown>).fromdate = '';
  (f.properties as Record<string, unknown>).datemodified = 'not-a-date';
  const { events, skipped } = transformGdacsFeatures([f], OPTS);
  assertEquals(events.length, 0);
  assertEquals(skipped[0].reason, 'no_occurred_at');
});

Deno.test('normalizeGdacsTimestamp — appends Z to a tz-less GDACS instant, rejects garbage', () => {
  assertEquals(normalizeGdacsTimestamp('2026-08-14T21:58:21'), '2026-08-14T21:58:21.000Z');
  assertEquals(normalizeGdacsTimestamp('2026-08-14T21:58:21Z'), '2026-08-14T21:58:21.000Z');
  assertEquals(normalizeGdacsTimestamp(''), null);
  assertEquals(normalizeGdacsTimestamp('not-a-date'), null);
});

// ---------------------------------------------------------------------------
// SNAPSHOT — content hash stable across clocks, changes on data; vintage on every event.
// ---------------------------------------------------------------------------
Deno.test('snapshot — content hash is STABLE across clocks, CHANGES on a data change', async () => {
  const feats = parseGdacsResponse(collection([feature('FL', 1104081, 9, [119.9, 30.8])]));
  const { events } = transformGdacsFeatures(feats, OPTS);
  const a = await buildGdacsSnapshot(events, { feedKey: 'gdacs_events', licenceKey: 'gdacs_cc_by_4', generatedAt: '2026-08-17T22:00:00.000Z' });

  // Same data, different wall-clock (generated_at AND each retrieved_at): identical hash.
  const laterClock = events.map((e) => ({ ...e, retrieved_at: '2027-01-01T00:00:00.000Z' }));
  const b = await buildGdacsSnapshot(laterClock, { feedKey: 'gdacs_events', licenceKey: 'gdacs_cc_by_4', generatedAt: '2027-01-01T00:00:00.000Z' });
  assertEquals(a.content_hash, b.content_hash); // clock-independent
  assertEquals(a.content_hash.length, 64); // sha256 hex
  assert(a.generated_at !== b.generated_at); // artifacts DO differ in metadata

  // A new episode (a cyclone strengthening) IS a data change -> hash changes.
  const strengthened = events.map((e) => ({ ...e, external_id: e.external_id.replace('-9', '-10'), episode_id: '10' }));
  const c = await buildGdacsSnapshot(strengthened, { feedKey: 'gdacs_events', licenceKey: 'gdacs_cc_by_4', generatedAt: '2026-08-17T22:00:00.000Z' });
  assert(c.content_hash !== a.content_hash);
});

Deno.test('snapshot — carries the GDACS attribution and GDACS alert-level counts AS the source label', async () => {
  const feats = parseGdacsResponse(
    collection([
      feature('FL', 1, 1, [10, 10], { alertlevel: 'Red' }),
      feature('DR', 2, 1, [11, 11], { alertlevel: 'Orange' }),
    ]),
  );
  const { events } = transformGdacsFeatures(feats, OPTS);
  const snap = await buildGdacsSnapshot(events, { feedKey: 'gdacs_events', licenceKey: 'gdacs_cc_by_4', generatedAt: '2026-08-17T22:00:00.000Z' });
  assertStringIncludes(snap.attribution, 'GDACS');
  assertStringIncludes(snap.attribution, 'CC BY 4.0');
  assertEquals(snap.alert_level_counts, { Red: 1, Orange: 1 }); // GDACS's own labels, tallied
  // every event carries its full vintage — none is bare
  for (const e of snap.events) {
    assert(e.source.length > 0);
    assert(e.release_version.length > 0);
    assert(e.retrieved_at.length > 0);
    assert(e.occurred_at.length > 0);
  }
});

// ---------------------------------------------------------------------------
// SQL — append-only insert + the FK-chain seeds.
// ---------------------------------------------------------------------------
Deno.test('sql — event insert is ON CONFLICT DO NOTHING, episode-keyed, geom fully-qualified', () => {
  const feats = parseGdacsResponse(collection([feature('TC', 1001297, 55, [120.6, 27.9])]));
  const { events } = transformGdacsFeatures(feats, OPTS);
  const sql = buildEventInsert(events);
  assertStringIncludes(sql, 'insert into atlas.event');
  assertStringIncludes(sql, 'on conflict on constraint event_dedup do nothing');
  assertStringIncludes(sql, "'TC-1001297-55'"); // episode-keyed external_id
  assertStringIncludes(sql, 'public.st_setsrid(public.st_makepoint(120.6, 27.9), 4326)');
  // A later episode simulated via override lands as a NEW row, never an overwrite.
  const next = buildEventInsert(events, { externalIdSuffix: '-next', releaseVersion: '2026-09-01T00:00:00Z' });
  assertStringIncludes(next, "'TC-1001297-55-next'");
});

Deno.test('sql — an unlocated event inserts a NULL geom, not a fabricated point', () => {
  const feats = parseGdacsResponse(collection([feature('FL', 7, 2, null)]));
  const { events } = transformGdacsFeatures(feats, OPTS);
  const sql = buildEventInsert(events);
  assertStringIncludes(sql, 'NULL'); // geom is NULL for the unlocated event
  assert(!sql.includes('st_makepoint'));
});

Deno.test('sql — licence + feed seeds are idempotent and chain correctly', () => {
  const lic = buildLicenceSeed();
  assertStringIncludes(lic, 'atlas.source_licence');
  assertStringIncludes(lic, "'gdacs_cc_by_4'");
  assertStringIncludes(lic, 'on conflict (licence_key) do nothing');
  const feed = buildFeedSeed();
  assertStringIncludes(feed, 'atlas.feed');
  assertStringIncludes(feed, "'gdacs_cc_by_4'"); // feed.licence_key FK -> the seeded licence
  assertStringIncludes(feed, 'on conflict (feed_key) do nothing');
});

Deno.test('sql — heartbeat upsert advances clock 1 always, clock 2 only on a hash change', () => {
  const hb = buildHeartbeatUpsert('abc123', 70);
  assertStringIncludes(hb, 'atlas.feed_heartbeat');
  assertStringIncludes(hb, 'last_success_at   = excluded.last_success_at'); // clock 1 always
  assertStringIncludes(hb, 'is distinct from excluded.last_release_token'); // clock 2 gated on change
  assertStringIncludes(hb, "last_status       = 'ok'");
  // no bare 'commit;' may hide in generated SQL (the shell guard also checks this)
  assertEquals(/(^|\s);*\bcommit\s*;/i.test(hb.replace(/--.*$/gm, '')), false);
});
