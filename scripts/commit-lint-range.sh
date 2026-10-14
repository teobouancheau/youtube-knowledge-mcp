#!/bin/sh
# Lints the message of every commit this branch has that origin/main does not, which is
# exactly what a push would add. Older history is not re-judged.
#
# A base that cannot be found is a failure, never a skip: a check that passes because it had
# nothing to look at is a check that stopped working without saying so.
set -eu

base_ref="origin/main"

if ! git rev-parse --verify --quiet "$base_ref" >/dev/null; then
  echo "$base_ref is not known here, so the commits to push cannot be told apart." >&2
  echo "Run 'git fetch origin' and push again." >&2
  exit 1
fi

base="$(git merge-base "$base_ref" HEAD)"

# Nothing ahead of the base: nothing to lint, and commitlint rejects an empty range.
if [ "$base" = "$(git rev-parse HEAD)" ]; then
  exit 0
fi

exec npx --no -- commitlint --from "$base" --to HEAD
