# open-data-ingest

Pure transform cores for five public-data feeds, and the publish layer that
decides what a snapshot is allowed to claim about its own licence.

No I/O. Every file here is a function from bytes to records, or from a snapshot
to a publish plan. Fetching, database writes and object storage live in the
callers, which is why the whole thing tests in a fifth of a second with no
network and no fixtures on disk.

## The part worth reading

`publish/snapshotPublish.ts` refuses to ship a snapshot that misrepresents its
own licence, and the distinction it enforces is the one people get wrong.

An **aggregate statistic** is a picture of numbers. It needs attribution, and it
is not a redistributable database, so it must *not* claim a share-alike licence.

A **derivative database** built from OpenStreetMap is a database. ODbL permits
publishing it, and requires the artifact carry the ODbL licence itself, the
"© OpenStreetMap contributors" attribution, the licence URL, and the §4.6
data-availability notice.

Handing the wrong descriptor to the wrong artifact throws, in both directions:

```
a derivative_database artifact must carry a database/share-alike licence (e.g. ODbL-1.0); got 'CC-BY-4.0'
an aggregate_statistics artifact must not claim a database/share-alike licence — it is a picture of numbers, not a re-usable database
```

A snapshot with no registered licence descriptor is refused rather than shipped
unlabelled. That is the whole design: the failure mode of a data pipeline is not
a crash, it is quietly publishing something under the wrong terms.

## The feeds

| feed | source | shape |
|---|---|---|
| `worldbank` | World Bank indicators | country-year reference series |
| `usgs` | USGS earthquakes | event stream |
| `gdacs` | GDACS disaster alerts | event stream |
| `unhcr` | UNHCR displacement | a **stock**, not events — argued from first principles in the file |
| `worship` | OpenStreetMap places of worship | derivative database, ODbL |

All of it is aggregate and public. Nothing here is individual-level.

## Storage keys

Artifacts are keyed by **content hash**, never by path or date, and served
`immutable` with a one-year cache: identical data re-ingested produces the same
key, so a republish that changed nothing costs nothing. A tiny mutable
`latest.json` pointer names the current hash and is cached 60 seconds with
`must-revalidate` — not `no-store`, which would forbid even that and put every
client read on the origin.

Both header choices are pinned by tests. Swapping them fails, which matters
because caching a mutable pointer for a year is the kind of mistake that is
invisible until it is a year long.

## Test

```
deno task test
```

93 tests, all passing, in about 165 ms:
worldbank 13 · usgs 18 · gdacs 22 · unhcr 14 · worship 11 · publish 15.

## Mutation

A pass count says a suite runs. It does not say the suite would notice if the
code were wrong. So the mutations are committed rather than described:

```
deno task mutation
```

`mutations.json` lists eight changes to real logic. The runner applies each one,
runs the suite, restores the file and verifies the restore by hash. It reports
four verdicts, and the third is why it exists:

| verdict | meaning |
|---|---|
| `KILLED` | the suite ran and failed — the mutation is caught |
| `SURVIVED` | the suite ran and passed — nothing pins this behaviour |
| `INCONCLUSIVE` | non-zero exit, but no evidence any test ran |
| `NOT-APPLIED` | the pattern was absent, or matched more than once |

A mutation that stops the code compiling also exits non-zero. A runner reading
only the exit code scores that as a kill it never earned, so a spec declares a
marker the test runner prints only when tests actually execute, and a non-zero
exit without it is `INCONCLUSIVE` — never counted as caught.

The runner has its own suite (`deno task test:mutation-runner`), because a tool that measures test suites
is itself a check, and a check nobody has watched fail is a claim.

The eight are every leg of the licence gate disabled in turn, and the two cache
policies swapped for each other.

MIT licensed. The *data* each feed describes carries its own licence, which is
the entire subject of the publish layer.
