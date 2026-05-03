#!/bin/bash
# scripts/release.sh
# Stages everything, opens vim for commit message, then runs the full deploy chain.

set -e

# Stage all changes
git add -A

# Show what's about to be committed (sanity check)
git status

# Open vim for commit message — script PAUSES here until you :wq
git commit

# Push the commit
git push

# Bump version (creates commit + tag automatically)
npm version patch

# Push the version commit and the new tag
git push && git push --tags

# Build and deploy
npm run build
npx cap sync android
scp -r -i ~/.ssh/.id_satoshi_market dist/* satoshi@satoshimarket.app:~/chama-dist/

echo "✅ Deployed $(node -p "require('./package.json').version")"
