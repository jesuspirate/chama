ARCHES := x86 arm
# overrides to s9pk.mk must precede the include statement
include node_modules/@start9labs/start-sdk/s9pk.mk

# The SDK's stock recipe runs `npm run check` / `npm run build`; in this repo
# those script names belong to the Chama web app, so the StartOS bundle is
# driven by the `startos:*` scripts. A recipe override must follow the include.
javascript/index.js: $(shell find startos -type f) node_modules
	npm run startos:check
	npm run startos:lint
	npm run startos:build
