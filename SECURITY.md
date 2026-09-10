# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository —
**Security → Advisories → Report a vulnerability**, or go straight to
[`../../security/advisories/new`](../../security/advisories/new). That channel is
private between you and the maintainer, and it is the only one that stays private.

**Please do not open a public issue for a suspected vulnerability.** If private
reporting is not available to you, open an issue saying only that you have a
security report and asking for a private channel. No details in the issue.

This project is maintained by one person, not a team with an on-call rotation. A
realistic expectation: acknowledgement within a week, an assessment within two.
If a report is valid, the fix and the advisory are published together, and you
are credited unless you ask not to be.

There is no bounty. Saying so plainly is more useful than leaving you to guess.

## Supported versions

The default branch is the only supported version. This project has not cut a
release series, so there is nothing to backport to.

## Threat model — read this before deciding whether you have a finding

This project fetches public data from third-party feeds, transforms it, emits
SQL, and publishes immutable artifacts to object storage. Every input is
**remote and untrusted**, including the ones from reputable institutions: a WAF
page, an HTML error, a schema change and a compromised response all arrive
through the same door.

**In scope.**

- **Injection into generated SQL.** A feed value that escapes its literal and
  changes the statement is the most serious class here.
- **A path-unsafe value reaching an object key.** A feed key or content hash
  containing `/`, `..`, or a control character must be refused, never smuggled
  into a storage path. There is already a test for this; a way around it is a
  finding.
- **An artifact published without its licence obligations.** Several feeds carry
  share-alike or attribution terms, and a derivative database that ships without
  its ODbL block, attribution, licence URL and availability notice is a
  compliance failure the code is specifically built to prevent.
- **A content hash that does not move when the data moves**, or that moves when
  only the clock moves. The immutable-key scheme depends on both directions, and
  a stable key over changed content means a stale artifact is served forever
  under a cache-immutable header.
- **A malformed upstream response that reads as empty rather than as an error.**
  Zero rows silently replacing real data is how a feed outage becomes a published
  claim that nothing happened. The code throws instead; a path where it does not
  is in scope.
- Anything that widens the runtime permission set beyond what a command declares.

**Out of scope.**

- Upstream data being factually wrong. This project republishes what a feed
  says, with its vintage attached, and the vintage is the answer to that.
- A feed being unavailable.
- The absence of a feed you would like to see.

**Standing properties.** Deno's permission model is the boundary and it is
narrow on purpose: **the test suite runs with no permissions at all** — plain
`deno test`, not even `--allow-read`. That is what makes the no-I/O claim
checkable rather than merely stated, and you can check it in one command.

It is tight enough that a mutation-testing harness could not read its own
selector variable: the run failed with `NotCapable: Requires env access to
"__STRYKER_ACTIVE_MUTANT__"`. The scheduled mutation job therefore grants that
one named variable and nothing else. Any command that needs a permission wider
than its documented set is a finding.
