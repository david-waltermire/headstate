#!/usr/bin/env bash
# Headstate is a public repo. At runtime it queries every org the user can
# see -- that is the product. But committed files must never name a private
# or employer repository, because a leak here is permanent and public.
#
# This is an ALLOW-list, deliberately. A deny-list would have to spell out
# the very names it exists to keep out, putting them in the repo in plain
# text and defeating itself. An allow-list also catches owners nobody
# thought to enumerate.
#
# Patterns are anchored so they cannot match ordinary prose. An earlier
# unanchored `owner/repo` pattern matched things like `api/hooks.ts`,
# `read/write`, and `5000/hour` -- a gate that cries wolf gets disabled, so
# anchoring is load-bearing, not tidiness. The patterns themselves live at
# the scan() calls below.
set -euo pipefail

# The only repository owners this project legitimately references.
# `org` and `owner` are the generic placeholders used in format examples
# (`- [org/repo#123] Title`), not real accounts.
# `acme` is the synthetic placeholder this repo uses in path examples.
ALLOWED='octocat|pktstorm|tauri-apps|shadcn-ui|rust-lang|actions|dtolnay|Swatinem|org|owner|acme'

# Ticket-ID-shaped tokens (PREFIX-NUMBER) that are legitimate public
# identifiers, not internal tracker references.
ALLOWED_TICKET_PREFIX='RUSTSEC|CVE|GHSA'

# Mail domains that cannot carry a private address by construction.
# GitHub's no-reply domain exists so a commit is attributed without
# exposing anyone's real mailbox -- the opposite of what this check
# is looking for.
ALLOWED_EMAIL_DOMAIN='users\.noreply\.github\.com'

# Lockfiles are machine-generated dependency graphs naming hundreds of
# upstream repos; they are not a leak vector for private names.
EXCLUDES=(':!scripts/check-privacy.sh' ':!yarn.lock' ':!src-tauri/Cargo.lock')

# This gate is the only thing between a private repo name and a permanent
# public leak, so it must never fail open. `git grep` exits 1 for "no match"
# (expected, fine) and >=2 for a real error -- not a repo, corrupt index, bad
# pathspec. A bare `|| true` swallows both, which would print "clean" while
# having scanned nothing at all. Abort loudly instead.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not inside a git work tree -- the privacy scan cannot run." >&2
  echo "Refusing to report 'clean' for a scan that did not happen." >&2
  exit 2
fi

# `git grep` only searches tracked (and staged) content -- untracked files
# are invisible to it. Reporting "clean" while an untracked file sits right
# there is the same failure mode as the work-tree check above: a scan that
# never looked, dressed up as one that did. Abort instead of silently
# skipping them.
untracked=$(git ls-files --others --exclude-standard)
if [ -n "$untracked" ]; then
  echo "ERROR: untracked files present; git grep cannot see them:" >&2
  echo "$untracked" | sed 's/^/  /' >&2
  echo "Stage them (git add -N) and re-run." >&2
  exit 2
fi

# Commit MESSAGES, which `git grep` cannot see -- it searches blobs only.
# A private repository name in a commit subject is exactly as permanently
# public as one in a file, and this history is full of "(#221)"-style
# subjects, which is a natural place to paste one.
scan_log() {
  local out status
  set +e
  out=$(git log --format='%s%n%b' | grep -hoIE "$1")
  status=$?
  set -e
  if [ "$status" -gt 1 ]; then
    echo "ERROR: scanning commit messages failed (exit $status)." >&2
    exit 2
  fi
  printf '%s' "$out"
}

scan() {
  local out status
  set +e
  out=$(git grep -hoIE "$1" -- "${EXCLUDES[@]}")
  status=$?
  set -e
  if [ "$status" -gt 1 ]; then
    echo "ERROR: git grep failed (exit $status) -- the privacy scan is unreliable." >&2
    exit 2
  fi
  printf '%s' "$out"
}

# Anchored forms. Anchoring is load-bearing: an earlier unanchored
# `owner/repo` pattern matched ordinary prose (api/hooks.ts, read/write,
# 5000/hour) and produced ~40 false positives. A gate that cries wolf is a
# gate someone disables. Every pattern below keys off a syntactic marker
# (a URL scheme, an `@` host, a `#N` suffix, a known SaaS domain) that does
# not occur in ordinary prose, rather than a bare `owner/repo` shape.
#   1. https://github.com/<owner>/<repo>
#   2. git@github.com:<owner>/<repo>          -- what `git remote -v` prints
#   3. <owner>/<repo>#<number>                -- the PR/issue shorthand
#   4. https://github.<host>/<owner>/<repo>   -- GitHub Enterprise Server
#   5. ssh://git@<host>/<owner>/<repo>.git    -- SSH clone URL, any host
#   6. <user>@<company-domain>                -- employer email addresses
#   7. <WORKSPACE>.slack.com / *.atlassian.net -- SaaS workspace URLs
#   8. <PREFIX>-<NNN>                          -- internal ticket IDs
urls=$(scan 'github\.com/[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+' \
       | sed -E 's#.*github\.com/##')

# scp-style SSH remote to ANY host, not just github.com -- `git@host:owner/repo`
# is exactly what `git remote -v` prints, so it is the likeliest shape to get
# pasted into a README. Anchored on `git@`, a dotted host, and the `:` that
# separates host from path, which ordinary prose does not produce.
ssh_scp=$(scan 'git@[A-Za-z0-9][-A-Za-z0-9.]*\.[a-z]{2,}:[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+' \
          | sed -E 's/^git@[^:]+://; s/\.git$//' || true)

ssh=$(scan 'git@github\.com:[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+' \
      | sed -E 's#.*github\.com:##')

# `owner/repo#123` in FILES and in COMMIT MESSAGES. The message half is
# the leak-prone one: a subject like "port the fix from acme/private#4"
# is as permanently public as a file, and `git grep` cannot see it.
refs=$(printf '%s\n%s\n' \
       "$(scan '[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+#[0-9]+')" \
       "$(scan_log '[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+#[0-9]+')" \
       | grep -vE '^[[:space:]]*$' \
       | sed -E 's/#[0-9]+$//' || true)

# GitHub Enterprise Server: same path shape as github.com, different host.
# Anchored on the literal "github." host prefix so it can't match arbitrary
# domains, then the github.com case is filtered back out below.
ghes=$(scan 'github\.[A-Za-z0-9][-A-Za-z0-9.]*\.[a-z]{2,}/[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+' \
       | sed -E 's#^github\.[^/]+/##' || true)

# SSH clone URL to any host, GitHub or not (GHES, self-hosted GitLab/Gitea,
# etc.). Anchored on the `ssh://git@...` scheme and the `.git` suffix, both
# of which are specific enough that ordinary prose never produces them.
ssh_any=$(scan 'ssh://git@[A-Za-z0-9][-A-Za-z0-9.]*[a-zA-Z]/[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]*\.git' \
          | sed -E 's#^ssh://git@[^/]+/##; s/\.git$//' || true)

# Employer email addresses. Anchored on a real TLD and excluding `git@`
# (that's SSH remote syntax: `git@host:owner/repo`, not an email) and any
# `@<digit>` (asset-scale filenames like `trayTemplate@2x.png`).
emails=$(scan '[A-Za-z][A-Za-z0-9._%+-]*@[A-Za-z][-A-Za-z0-9.]*\.[A-Za-z]{2,6}' \
         | grep -vE '^git@' \
         | sed -E 's/^[^@]+@//' \
         | grep -vE "^($ALLOWED_EMAIL_DOMAIN)$" || true)

# Local checkout paths that name a real project directory.
#
# The gap this closes: `~/code/acme/widget` in a doc comment, and a
# hardcoded `format!("{home}/code/acme/widget")` in an ignored live
# test, both sat in tracked files while every other pattern here
# reported clean. None of them look for a FILESYSTEM PATH -- they look
# for `owner/repo`, remote URLs, and emails -- so a private project name
# spelled as a directory walked straight through.
#
# Anchored on a `code/`-style parent so it cannot match ordinary
# relative paths in prose or imports (`src/lib/x`, `api/hooks.ts`). Two
# segments after it, which is the shape that actually names something.
paths=$(scan '(~|\{home\}|\$HOME|/Users/[A-Za-z0-9._-]+)/(code|src|dev|projects|work|repos)/[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]*' \
        | sed -E 's#^.*/(code|src|dev|projects|work|repos)/##' || true)

# Slack/Atlassian workspace URLs. The workspace name is the owner-like
# token; anchored on the literal SaaS domain suffix so it can't match
# arbitrary `*.com` prose.
saas=$(scan '[A-Za-z0-9][-A-Za-z0-9]*\.(slack\.com|atlassian\.net)' \
       | sed -E 's/\.(slack\.com|atlassian\.net)$//' || true)

# Internal ticket IDs (JIRA-shaped: LETTERS-NUMBER). Two-or-more digits
# excludes license/spec tokens that share the shape (UTF-8, BSD-2, MPL-2).
# A small allow-list covers legitimate public identifiers of the same shape
# (RUSTSEC-2025-...).
tickets=$(scan '[A-Z]{2,10}-[0-9]{2,}' \
          | grep -vE "^($ALLOWED_TICKET_PREFIX)-" || true)

owner_matches=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$urls" "$ssh" "$refs" "$ghes" "$ssh_any" "$ssh_scp" \
        | grep -vE '^[[:space:]]*$' \
        | grep -vE "^($ALLOWED)/" \
        | sort -u || true)

other_matches=$(printf '%s\n%s\n%s\n' "$emails" "$saas" "$tickets" \
        | grep -vE '^[[:space:]]*$' \
        | sort -u || true)

# Checkout paths reuse the owner allow-list: `~/code/pktstorm/headstate`
# is this project's own and must not trip the gate.
path_matches=$(printf '%s\n' "$paths" \
        | grep -vE '^[[:space:]]*$' \
        | grep -vE "^($ALLOWED)/" \
        | sort -u || true)

if [ -n "$owner_matches" ] || [ -n "$other_matches" ] || [ -n "$path_matches" ]; then
  echo "ERROR: possible private references found:"
  if [ -n "$owner_matches" ]; then
    echo "  repository owners not on the allow-list:"
    echo "$owner_matches" | sed 's/^/    /'
  fi
  if [ -n "$other_matches" ]; then
    echo "  emails / ticket IDs / SaaS workspaces:"
    echo "$other_matches" | sed 's/^/    /'
  fi
  if [ -n "$path_matches" ]; then
    echo "  local checkout paths naming a real project:"
    echo "$path_matches" | sed 's/^/    /'
  fi
  echo
  echo "Use synthetic fixtures (octocat/hello-world, AcmeCorp, example.internal),"
  echo "or add the owner to ALLOWED in this script if it is a legitimate public"
  echo "dependency."
  exit 1
fi

echo "privacy check: clean"
