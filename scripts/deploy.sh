#!/bin/sh
# Deploy the site to Cloudflare Pages (CONTRIBUTING.md "Deploying").
#   scripts/deploy.sh main   production: https://emt-lite.pages.dev/
#   scripts/deploy.sh dev    the dev preview: https://dev.emt-lite.pages.dev/
# The site must match a commit everyone can see: a clean checkout of that branch, level with GitHub.
set -eu
target="${1:-}"
case "$target" in main|dev) ;; *) echo "usage: scripts/deploy.sh main|dev" >&2; exit 2 ;; esac

if [ "$(git branch --show-current)" != "$target" ]; then
  echo "Check out $target to deploy it (on $(git branch --show-current))." >&2; exit 1
fi
if ! git diff --quiet HEAD || [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo 'Commit your changes before deploying: the site should match a commit.' >&2; exit 1
fi
git fetch -q origin "$target"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$target")" ]; then
  echo "$target is not level with origin/$target: pull (or merge the PR) first." >&2; exit 1
fi

npm test
npm run build
npx wrangler pages deploy dist --project-name emt-lite --branch "$target" --commit-hash "$(git rev-parse HEAD)"
