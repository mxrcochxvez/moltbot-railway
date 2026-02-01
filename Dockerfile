# Build OpenClaw from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:22.12-bookworm AS openclaw-build

# Dependencies needed for OpenClaw build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  git \
  ca-certificates \
  curl \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (OpenClaw build uses it)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Avoid Corepack signature/key issues on some builders (e.g., Railway) by installing pnpm directly.
RUN npm install -g pnpm@10.23.0

WORKDIR /openclaw

# Pin to a known ref (tag/branch). If it doesn't exist, fall back to main.
ARG OPENCLAW_GIT_REF=v2026.1.30
ARG CLAWDBOT_GIT_REF
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF:-${CLAWDBOT_GIT_REF:-main}}" https://github.com/openclaw/openclaw.git . || \
  git clone --depth 1 https://github.com/openclaw/openclaw.git .

# Patch: relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
  sed -i -E 's/"clawdbot"[[:space:]]*:[[:space:]]*">=[^"]+"/\"clawdbot\": \"*\"/g' "$f"; \
  sed -i -E 's/"clawdbot"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/\"clawdbot\": \"*\"/g' "$f"; \
  done

RUN pnpm install --no-frozen-lockfile
# Limit memory to avoid OOM on Railway builders
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm build
ENV CLAWDBOT_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# Runtime image
FROM node:22.12-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates \
  git \
  curl \
  jq \
  bash \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update \
  && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built OpenClaw
COPY --from=openclaw-build /openclaw /openclaw

# Provide OpenClaw executables (with legacy aliases)
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw \
  && ln -s /usr/local/bin/openclaw /usr/local/bin/clawdbot

COPY src ./src

# The wrapper listens on this port.
ENV CLAWDBOT_PUBLIC_PORT=8080
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
