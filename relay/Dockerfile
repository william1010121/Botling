# Botling relay image. Build from the repository root (the phone web app is built from desktop/ and Web/):
#   docker build -f relay/Dockerfile -t botling-relay:0.1.0 .
# Relay only, no phone web app (smaller, no desktop dependencies):
#   docker build -f relay/Dockerfile --target relay -t botling-relay:0.1.0-bare .

# --- The relay itself: Node 24 runs the TypeScript sources directly (type stripping), one dependency (ws).
FROM node:24-bookworm-slim AS relay
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY relay/src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]

# --- The phone web app (desktop/mobile/dist): the desktop renderer in web mode. Electron/Playwright binaries are not fetched.
FROM node:24-bookworm-slim AS web
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src/desktop
COPY desktop/package.json desktop/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY desktop/ ./
COPY Web/ ../Web/
RUN ln -sfn ../desktop/node_modules ../Web/node_modules && node mobile/build.mjs

# --- Default: relay + phone web app under /mobile/.
FROM relay AS full
ENV STATIC_DIR=/app/public
COPY --from=web /src/desktop/mobile/dist ./public
