# ---- build ----
FROM node:22-bookworm-slim AS build
# Compiler tools in case the SQLite module has to be built from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- run ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 PHOTOS_ROOT=/photos DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/jm-entrypoint
RUN chmod 755 /usr/local/bin/jm-entrypoint && mkdir -p /data /projects
# Starts as root only long enough to fix the data folder's owner, then runs the app as a
# normal user (see docker/entrypoint.sh).
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/jm-entrypoint"]
