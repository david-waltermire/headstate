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
# Three patterns are scanned, all anchored so they cannot match ordinary
# prose. An earlier unanchored `owner/repo` pattern matched things like
# `api/hooks.ts`, `read/write`, and `5000/hour` -- a gate that cries wolf
# gets disabled, so anchoring is load-bearing, not tidiness. The patterns
# themselves live at the scan() calls below.
set -euo pipefail

# The only repository owners this project legitimately references.
# `org` and `owner` are the generic placeholders used in format examples
# (`- [org/repo#123] Title`), not real accounts.
ALLOWED='octocat|pktstorm|tauri-apps|shadcn-ui|rust-lang|actions|dtolnay|Swatinem|org|owner'

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

# Three anchored forms. Anchoring is load-bearing: an earlier unanchored
# `owner/repo` pattern matched ordinary prose (api/hooks.ts, read/write,
# 5000/hour) and produced ~40 false positives. A gate that cries wolf is a
# gate someone disables.
#   1. https://github.com/<owner>/<repo>
#   2. git@github.com:<owner>/<repo>   -- what `git remote -v` prints
#   3. <owner>/<repo>#<number>         -- the PR/issue shorthand
urls=$(scan 'github\.com/[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+' \
       | sed -E 's#.*github\.com/##')

ssh=$(scan 'git@github\.com:[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+' \
      | sed -E 's#.*github\.com:##')

refs=$(scan '[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+#[0-9]+' \
       | sed -E 's/#[0-9]+$//')

found=$(printf '%s\n%s\n%s\n' "$urls" "$ssh" "$refs" \
        | grep -vE '^[[:space:]]*$' \
        | grep -vE "^($ALLOWED)/" \
        | sort -u || true)

if [ -n "$found" ]; then
  echo "ERROR: repository references with a non-allow-listed owner:"
  echo "$found" | sed 's/^/  /'
  echo
  echo "Use synthetic fixtures (octocat/hello-world), or add the owner to"
  echo "ALLOWED in this script if it is a legitimate public dependency."
  exit 1
fi

echo "privacy check: clean"
