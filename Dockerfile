# Drawesome realtime server + built SPA (single Node process on one port).
# PocketBase runs as a separate service (see docker-compose.yml).
#
# Base images are pinned by digest: a floating tag means tomorrow's build can
# ship a different OS + Node than the one that was tested. Bump deliberately:
#   docker pull node:24-alpine && docker image inspect node:24-alpine --format '{{index .RepoDigests 0}}'

# ---- build the Vite SPA ----
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The public PocketBase URL is inlined into the SPA at build time (Vite). Passed
# as a build arg from compose; written to .env so Vite reliably picks it up.
ARG VITE_PB_URL=
ARG VITE_GAM_AD_UNIT_CHAT=
ARG VITE_GAM_AD_UNIT_INTERSTITIAL=
ARG VITE_AD_BREAK_MINUTES=10
RUN printf "VITE_PB_URL=%s\nVITE_GAM_AD_UNIT_CHAT=%s\nVITE_GAM_AD_UNIT_INTERSTITIAL=%s\nVITE_AD_BREAK_MINUTES=%s\n" \
  "$VITE_PB_URL" "$VITE_GAM_AD_UNIT_CHAT" "$VITE_GAM_AD_UNIT_INTERSTITIAL" "$VITE_AD_BREAK_MINUTES" > .env
RUN npm run build

# ---- runtime ----
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production
# All persistent state lives here (mounted as a volume in compose).
ENV DATA_DIR=/data
# server.js binds loopback by default; inside a container the published port
# needs every interface.
ENV HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.js ./server.js
COPY server ./server
EXPOSE 8787
# The server runs as the unprivileged `node` user. The container still STARTS as
# root, for one job: a bind-mounted ./app_data arrives owned by whoever made it
# on the host, so make it writable, then drop privileges for good (exec — node
# stays PID 1 and gets SIGTERM for the graceful-shutdown path). Inline rather
# than a .sh file so a CRLF checkout on Windows can't break the shebang.
ENTRYPOINT ["/bin/sh", "-c", "if [ \"$(id -u)\" = 0 ]; then mkdir -p \"$DATA_DIR\"; su-exec node test -w \"$DATA_DIR\" || chown -R node:node \"$DATA_DIR\" || true; exec su-exec node \"$@\"; fi; exec \"$@\"", "--"]
CMD ["node", "server.js"]
