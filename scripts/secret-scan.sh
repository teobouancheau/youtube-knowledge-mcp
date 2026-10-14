#!/bin/sh
# Scans for committed secrets with gitleaks (https://github.com/gitleaks/gitleaks), the
# project's own tool, using .gitleaks.toml at the repository root.
#
#   secret-scan.sh staged    what is about to be committed        (pre-commit)
#   secret-scan.sh history   every commit that would be pushed to a remote  (pre-push)
#   secret-scan.sh tree      every file in the working tree, tracked or not (validate)
#
# A missing gitleaks is a failure, never a skip: a gate that passes because its tool is
# absent is a gate that stopped checking without telling anyone.
set -eu

mode="${1:-}"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed, so secrets cannot be scanned for." >&2
  echo "Install it: macOS 'brew install gitleaks', or see https://github.com/gitleaks/gitleaks#installing" >&2
  exit 127
fi

root="$(git rev-parse --show-toplevel)"
config="$root/.gitleaks.toml"

case "$mode" in
  staged)  exec gitleaks git --config "$config" --redact --no-banner --staged "$root" ;;
  history) exec gitleaks git --config "$config" --redact --no-banner "$root" ;;
  tree)    exec gitleaks dir --config "$config" --redact --no-banner "$root" ;;
  *)
    echo "usage: secret-scan.sh staged|history|tree" >&2
    exit 64
    ;;
esac
