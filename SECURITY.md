# Security Policy

## The token model

Headstate does not implement its own authentication or credential storage.
It delegates entirely to the [GitHub CLI](https://cli.github.com/):

- At startup, Headstate runs `gh auth token` and reads the token from its
  output.
- That token is held **in memory only**, for the lifetime of the running
  app. It is never written to Headstate's local SQLite database, never
  logged, and never included in an error message or a command's return
  value.
- Headstate stores no credentials of its own. If you revoke or rotate your
  `gh` session, Headstate has nothing left over to clean up — quitting the
  app is enough.
- The token is used only to talk to `api.github.com`. Headstate makes no
  other outbound network calls.

## Read-only by design

**v1 is strictly read-only.** Headstate cannot merge a pull request,
post a comment, approve or request changes on a review, close a PR, or
modify the merge queue. Every GitHub API call it makes is a read. The
"nudge" feature composes a text block from data already in memory and
copies it to your local clipboard — it never posts anything anywhere on
your behalf.

## Local storage

Headstate caches a snapshot of your open pull requests in a local SQLite
database (for fast startup and offline viewing between polls) and a small
merge-history table. This cache contains only pull request metadata
(titles, URLs, CI/review/merge state, labels) that Headstate already fetched
from `api.github.com` on your behalf — never your GitHub token or any other
credential.

## Reporting a vulnerability

If you find a security issue in Headstate, please report it privately
rather than opening a public issue, using GitHub's Security Advisory flow
for this repository:

**https://github.com/pktstorm/headstate/security/advisories/new**

Please include enough detail to reproduce the issue (steps, affected
version, and impact). We'll acknowledge reports and follow up as we
investigate.
