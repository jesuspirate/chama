# scripts/release.sh
#!/bin/bash
set -e
git commit ${1:+-m "$1"}    # optional message arg
git push
npm version patch
git push && git push --tags
npm run build
npx cap sync android
scp -r -i ~/.ssh/.id_satoshi_market dist/* satoshi@satoshimarket.app:~/chama-dist/
echo "Deployed $(node -p "require('./package.json').version')"
