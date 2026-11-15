# Botling relay image. Build from the repository root (the phone web app is built from desktop/ and Web/):
#   docker build -f relay/Dockerfile -t botling-relay:0.1.0 .                       # relay + Botling 3 phone page (default, target full)
# Relay only, no phone web app (smaller, no desktop dependencies):
#   docker build -f relay/Dockerfile --target relay -t botling-relay:0.1.0-bare .
# Rollback only: the relay with the 2.x phone page under /mobile/ (as images before the Botling 3 page):
#   docker build -f relay/Dockerfile --target full-2x -t botling-relay:0.1.0-2x .

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

# --- The desktop sources with their dependencies (Electron/Playwright binaries are not fetched); both phone pages build from here.
FROM node:24-bookworm-slim AS web-src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src/desktop
COPY desktop/package.json desktop/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY desktop/ ./
COPY Web/ ../Web/
RUN ln -sfn ../desktop/node_modules ../Web/node_modules

# --- The Botling 3 phone page (desktop/web-v3/dist): the page botlingd also serves at /v3/ on the tailnet.
FROM web-src AS web-v3
RUN node web-v3/build.mjs

# --- The 2.x phone page (desktop/mobile/dist), for the full-2x rollback image only.
FROM web-src AS web
RUN node mobile/build.mjs

# --- Rollback: relay + the 2.x phone page under /mobile/ (/ redirects to /mobile/).
FROM relay AS full-2x
ENV STATIC_DIR=/app/public
COPY --from=web /src/desktop/mobile/dist ./public

# --- Default: relay + the Botling 3 phone page under /v3/. It is THE phone page: / and every /mobile address (an old
# 2.x Home Screen app) redirect to /v3/. The relay protocol is unchanged, so 2.x and 3.x desktops both keep their rooms.
FROM relay AS full
ENV STATIC_V3_DIR=/app/public-v3
COPY --from=web-v3 /src/desktop/web-v3/dist ./public-v3
