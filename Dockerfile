# Pose Board — the app has no npm dependencies, so there is nothing to install
# and no build stage: copy the source in and run it.
FROM node:22-alpine

# su-exec lets the entrypoint fix ownership of the mounted volume as root and
# then drop to an unprivileged user before starting the server.
RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# ADMIN_PASSWORD is deliberately not set here — the server refuses to start in
# production without one, so it must come from the host's secrets.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# Photos and db.json live here. Mount a real volume at /data or they vanish
# when the container is replaced.
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
