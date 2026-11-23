#!/bin/sh
# Use the checked-in hooks in .githooks/ for this clone. The public boundary
# check then runs before every commit and merge (staged files and identity),
# on every commit message, and before every push (the full history).
# Run once after cloning.
set -eu
cd "$(git rev-parse --show-toplevel)"
chmod +x .githooks/pre-commit .githooks/commit-msg .githooks/pre-merge-commit .githooks/pre-push
git config core.hooksPath .githooks
echo "Hooks installed (core.hooksPath=.githooks)."
if [ "$(git config user.name || true)" != "fakoli" ] || [ "$(git config user.email || true)" != "fakoli@users.noreply.github.com" ]; then
  echo "Set the commit identity first: git config user.name fakoli; git config user.email fakoli@users.noreply.github.com"
fi
terms="${XENON_BOUNDARY_TERMS_FILE:-$HOME/.config/xenon-writing/public-boundary-terms}"
if [ -z "${XENON_BOUNDARY_TERMS:-}" ] && [ ! -f "$terms" ]; then
  echo "No denied-term list at $terms. The hooks refuse every commit until it exists; ask the owner for it."
fi
