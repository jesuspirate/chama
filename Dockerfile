FROM rust:1-bookworm AS bridge-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang cmake libssl-dev pkg-config && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /bridge
COPY native/fedimint-bridge/Cargo.toml native/fedimint-bridge/Cargo.lock ./
COPY native/fedimint-bridge/src ./src
RUN cargo build --locked --release

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN VITE_CHAMA_NATIVE_BRIDGE_REQUIRED=1 VITE_CHAMA_NATIVE_BRIDGE_URL=/bridge npm run build

FROM nginx:1.27-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends apache2-utils openssl && \
    rm -rf /var/lib/apt/lists/*
COPY startos/nginx.conf.template /etc/nginx/nginx.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=bridge-build /bridge/target/release/chama-fedimint-bridge /usr/local/bin/chama-fedimint-bridge
COPY startos/entrypoint.sh /usr/local/bin/chama-startos-entrypoint
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=25s --retries=3 \
  CMD password="$(cat /data/security/access-password)" \
    && curl -fsS -u "chama:$password" http://127.0.0.1:8080/ >/dev/null \
    && curl -fsS -H "Authorization: Bearer $(cat /data/security/bridge-token-1)" http://127.0.0.1:8787/health >/dev/null \
    || exit 1
ENTRYPOINT ["/usr/local/bin/chama-startos-entrypoint"]
