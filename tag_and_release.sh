#!/usr/bin/env bash

# THIS SCRIPT IS CUSTOM - inspired from changesets.
# The difference is, there is no workflow. So everything runs from your computer.
# Which also means, no collaboration kind of, not everyone can release.

set -euo pipefail

if [ -n "$(git status --porcelain)" ]; then
    echo "❗ Please commit all changes before bumping the version."
    exit 1
fi

NAME="herdr-serve"
CURRENT="$(tr -d '[:space:]' < VERSION)"
echo "🦋 What kind of change is this for $NAME? (current version is $CURRENT) [patch, minor, major] >"

read -r BUMP

case "$BUMP" in
    patch) NEW=$(echo "$CURRENT" | awk -F. '{$NF+=1; OFS="."; print $1,$2,$3}') ;;
    minor) NEW=$(echo "$CURRENT" | awk -F. '{$(NF-1)+=1; $NF=0; OFS="."; print $1,$2,$3}') ;;
    major) NEW=$(echo "$CURRENT" | awk -F. '{$1+=1; $2=0; $3=0; OFS="."; print $1,$2,$3}') ;;
    *) echo "Please specify patch, minor, or major"; exit 1 ;;
esac

echo "🦋 Would tag and push $NAME $CURRENT -> $NEW"

read -p "Proceed? [Y/n] " -r CONFIRM
CONFIRM=${CONFIRM:-y}
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# ============================================
# Update & Commit - Release manifests
# ============================================

echo "🦋 Updating VERSION to ${NEW}"
echo "${NEW}" > VERSION

if [ -f "npm/package.json" ]; then
    echo "🦋 Updating npm/package.json to version ${NEW}"
    sed -i.bak "s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"${NEW}\"/" npm/package.json
    rm npm/package.json.bak
    git add npm/package.json
fi

if [ -f "herdr-plugin.toml" ]; then
    echo "🦋 Updating herdr-plugin.toml to version ${NEW}"
    sed -i.bak "s/^version *= *\"[^\"]*\"/version = \"${NEW}\"/" herdr-plugin.toml
    rm herdr-plugin.toml.bak
    git add herdr-plugin.toml
fi

if [ -f "web/package.json" ]; then
    echo "🦋 Updating web/package.json to version ${NEW}"
    sed -i.bak "s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"${NEW}\"/" web/package.json
    rm web/package.json.bak
    git add web/package.json
fi

echo "🦋 Regenerating CHANGELOG.md..."
git cliff --tag "v${NEW}" --offline -o CHANGELOG.md

echo "🦋 Building UI so go install embeds the latest web/dist..."
(cd web && npm ci && npm run build)

echo "🦋 Committing version bump ${NEW}..."
git add .
git commit -m "release: ${NAME} v${NEW}"

# ============================================
# goreleaser Publish GitHub Releases via actions
# ============================================

echo "🦋 Creating git tag v${NEW}"
git tag "v${NEW}"

echo "🦋 Pushing..."
git push --tags
git push
