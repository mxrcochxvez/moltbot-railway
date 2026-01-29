ARG NODE_VERSION=22.0.0

# -----------------------------------------------------------------------------
# Stage 1: Build Moltbot from source
# -----------------------------------------------------------------------------
FROM node:22-bookworm AS clawdbot-build

# Install dependencies for building
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  git \
  ca-certificates \
  curl \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /clawdbot

# Clone Moltbot (pinned version)
ARG CLAWDBOT_TAG=v2026.1.25
RUN git clone --depth 1 --branch "${CLAWDBOT_TAG}" https://github.com/moltbot/moltbot.git . || \
  git clone --depth 1 https://github.com/moltbot/moltbot.git .

# Patch package.json if needed (copied from reference)
# Relax version requirements for workspace packages
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
  sed -i -E 's/"clawdbot"[[:space:]]*:[[:space:]]*">=[^"]+"/"clawdbot": "*"/g' "$f"; \
  sed -i -E 's/"clawdbot"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"clawdbot": "*"/g' "$f"; \
  done

RUN pnpm install --no-frozen-lockfile
# Limit memory to avoid OOM on Railway builders
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm build
ENV CLAWDBOT_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build

# -----------------------------------------------------------------------------
# Stage 2: Runtime with Linuxbrew and ttyd
# -----------------------------------------------------------------------------
FROM node:22-bookworm

ENV NODE_ENV=production

# Install dependencies for Linuxbrew and general use
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  build-essential \
  procps \
  file \
  sudo \
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user (linuxbrew requirement)
RUN useradd -m -s /bin/bash railway \
  && echo 'railway ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER railway
WORKDIR /home/railway

# Install Linuxbrew
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Add Brew to PATH
ENV PATH="/home/railway/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/bin:${PATH}"
ENV MANPATH="/home/railway/.linuxbrew/share/man:/home/linuxbrew/.linuxbrew/share/man:${MANPATH}"
ENV INFOPATH="/home/railway/.linuxbrew/share/info:/home/linuxbrew/.linuxbrew/share/info:${INFOPATH}"

# Install ttyd (static binary) to save build resources (avoiding brew install during build)
RUN sudo curl -L https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -o /usr/local/bin/ttyd \
  && sudo chmod +x /usr/local/bin/ttyd

# Clean up brew cache
RUN brew cleanup

# Create data directories with proper permissions
# Railway mounts /data so we need to handle permissions at runtime
RUN sudo mkdir -p /data/.clawdbot /data/workspace \
  && sudo chown -R railway:railway /data

WORKDIR /app

# Wrapper deps
COPY --chown=railway:railway package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built clawdbot from build stage
COPY --from=clawdbot-build --chown=railway:railway /clawdbot /clawdbot

# Create wrapper script for clawdbot
RUN echo '#!/usr/bin/env bash' > ./clawdbot-bin \
  && echo 'exec node /clawdbot/dist/entry.js "$@"' >> ./clawdbot-bin \
  && chmod +x ./clawdbot-bin

# Link it specifically if needed, but we'll use a direct path or alias in code
# or modify PATH
ENV PATH="/app:${PATH}"

COPY --chown=railway:railway src ./src

# Environment variables
ENV PORT=8080
ENV CLAWDBOT_STATE_DIR=/data/.clawdbot
ENV CLAWDBOT_WORKSPACE_DIR=/data/workspace
EXPOSE 8080

# Entrypoint to fix permissions at runtime (Railway volume mount)
COPY --chown=railway:railway <<EOF /app/entrypoint.sh
#!/bin/bash
set -e
# Ensure data directories exist and are writable
sudo mkdir -p /data/.clawdbot /data/workspace 2>/dev/null || true
sudo chown -R railway:railway /data 2>/dev/null || true
exec "$@"
EOF
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "src/server.js"]
