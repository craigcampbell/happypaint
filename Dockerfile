# Drawesome realtime server + built SPA (single Node process on one port).
# PocketBase runs as a separate service (see docker-compose.yml).

# ---- build the Vite SPA ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The public PocketBase URL is inlined into the SPA at build time (Vite). Passed
# as a build arg from compose; written to .env so Vite reliably picks it up.
ARG VITE_PB_URL=
RUN echo "VITE_PB_URL=${VITE_PB_URL}" > .env
RUN npm run build

# ---- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# All persistent state lives here (mounted as a volume in compose).
ENV DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.js ./server.js
COPY server ./server
EXPOSE 8787
CMD ["node", "server.js"]
