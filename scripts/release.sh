#!/bin/sh
# Release main (CONTRIBUTING.md "Releasing"), after the release pull request has merged:
# tag it vVERSION (signed), publish a GitHub release with that version's CHANGELOG.md notes, and
# deploy it to https://emt-lite.pages.dev/.
set -eu
if [ "$(git branch --show-current)" != main ]; then echo 'Check out main to release it.' >&2; exit 1; fi
if ! git diff --quiet HEAD || [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo 'Commit your changes first: a release is a commit everyone can see.' >&2; exit 1
fi
git fetch -q --tags origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo 'main is not level with origin/main: pull (or merge the release PR) first.' >&2; exit 1
fi
version="$(node -p "require('./package.json').version")"
tag="v$version"
node scripts/changelog.js check "$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists: bump the version in the release PR." >&2; exit 1
fi

notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT
node scripts/changelog.js notes "$version" > "$notes"
git tag -s "$tag" -m "EMT-Lite $version"
git push origin "refs/tags/$tag"
gh release create "$tag" --repo RGx01/EMT-lite --verify-tag --title "$version" --notes-file "$notes" --latest
scripts/deploy.sh main
