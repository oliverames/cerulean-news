#!/usr/bin/env bash
# Prints one GitHub Actions output. Diagnostics go to stderr. A trailer on
# the pushed tip applies to the entire push range; scheduled/manual runs
# always generate, regardless of that commit's trailer.
set -euo pipefail

event_name="${1:-}"
before="${2:-}"
sha="${3:-}"

full_generation() {
  printf 'full=true\n'
}

if [[ "$event_name" != push ]]; then
  full_generation
  exit 0
fi

# Treat an absent, initial-push, or unusable range conservatively. Validate
# before passing revisions to Git, and never evaluate commit text as shell.
if [[ ! "$before" =~ ^[0-9a-fA-F]{40}$ || ! "$sha" =~ ^[0-9a-fA-F]{40}$ ]] ||
   ! git cat-file -e "${before}^{commit}" 2>/dev/null ||
   ! git cat-file -e "${sha}^{commit}" 2>/dev/null ||
   ! git merge-base --is-ancestor "$before" "$sha" 2>/dev/null; then
  printf '%s\n' 'Could not compare the complete push range; using a full generation.' >&2
  full_generation
  exit 0
fi

# Disabling rename detection preserves a removed runtime path when a file
# moves into docs. NUL-delimited paths also handle quoted/newline filenames.
if ! changed_mode="$(
  git diff --no-renames --name-only -z "$before" "$sha" -- |
    {
      any=false
      full=false
      while IFS= read -r -d '' changed_path; do
        any=true
        case "$changed_path" in
          (src/*|test/*|data/*|certs/*|package.json|package-lock.json|.github/workflows/publish-feed.yml|scripts/publish-mode.sh)
            full=true
            ;;
        esac
      done
      if [[ "$any" == false ]]; then
        printf 'empty\n'
      else
        printf 'full=%s\n' "$full"
      fi
    }
)"; then
  printf '%s\n' 'Could not compare the complete push range; using a full generation.' >&2
  full_generation
  exit 0
fi
if [[ "$changed_mode" == empty ]]; then
  full_generation
  exit 0
fi

if ! trailers="$(git show -s --format=%B "$sha" | git interpret-trailers --parse)"; then
  printf '%s\n' 'Could not read the pushed commit trailers; using a full generation.' >&2
  full_generation
  exit 0
fi
mode_trailers="$(printf '%s\n' "$trailers" | grep -i '^Publish-Mode:' || true)"
if [[ "$mode_trailers" == 'Publish-Mode: static' ]]; then
  printf '%s\n' 'Pushed commit requests static publication with the live feed.' >&2
  printf 'full=false\n'
elif [[ -n "$mode_trailers" ]]; then
  printf '%s\n' 'Unrecognized or repeated Publish-Mode trailer; using a full generation.' >&2
  full_generation
else
  printf '%s\n' "$changed_mode"
fi
