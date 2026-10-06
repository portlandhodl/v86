# Image server for the v86_64 machine manager (see server/README.md).
# Build from the repository root: docker build -f server/Dockerfile .
FROM node:22-bookworm-slim

# curl: resumable downloads; bsdtar: extracting kernels from the ISOs
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl libarchive-tools ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/image-server.mjs server/config.json /app/server/
COPY profiles/ /app/profiles/

ENV IMAGE_DIR=/data/images \
    PROFILES_DIR=/app/profiles \
    PORT=8080
VOLUME /data/images
EXPOSE 8080

# runs as any uid (compose passes the owner of the bound image directory)
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "/app/server/image-server.mjs", "--config", "/app/server/config.json"]
