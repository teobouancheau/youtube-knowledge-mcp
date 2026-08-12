# Build in one stage, ship in another: the compiler, dev dependencies and
# TypeScript sources never reach the published image.
FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:24-slim

# yt-dlp is pinned so an image rebuild is reproducible. It still needs regular
# bumping — YouTube changes often and a stale yt-dlp is the most common failure.
# The scheduled workflow in .github/workflows/ opens a PR when a new one lands.
ARG YT_DLP_VERSION=2026.07.04

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates && \
    pip3 install --break-system-packages "yt-dlp==${YT_DLP_VERSION}" && \
    apt-get purge -y python3-pip && apt-get autoremove -y && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# node:*-slim ships an unprivileged `node` user; running as root is unnecessary
# for a process that only reads YouTube and writes under its own home.
ENV HOME=/home/node
USER node

EXPOSE 10000

# Reports unhealthy when yt-dlp is missing, so an orchestrator sees a broken
# image rather than a container that accepts traffic and fails every call.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "--http"]
