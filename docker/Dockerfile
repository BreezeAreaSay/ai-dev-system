# syntax=docker/dockerfile:1.7

# gitleaks is the only one of the six security scanners that works with no
# network at all, and the container runs with `--network none`. Without it
# `run_security_scan` in the image comes back `unchecked` — nothing was looked
# at (docs/DEFECTS.md, Д-55). A static CGO_ENABLED=0 Go binary, so it is copied
# out of the upstream image rather than installed; the digest is the multi-arch
# index for v8.30.1 and covers linux/amd64 and linux/arm64. MIT licensed; see
# THIRD_PARTY_NOTICES.md.
ARG GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
FROM ${GITLEAKS_IMAGE} AS gitleaks

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG INSTALL_BGE_M3=0
ARG VERSION=dev
ARG VCS_REF=unknown
ARG SOURCE_URL=""

LABEL org.opencontainers.image.title="AI Dev MCP System" \
      org.opencontainers.image.description="Local-first MCP engineering system for AI agents" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="MIT"

# Whether this image carries the *legacy* BGE-M3 Python stack. It no longer
# decides whether dense search is possible: the ONNX runtime is an ordinary npm
# dependency and is always installed, so a default image can run dense search
# from mounted weights with no Python at all (docs/DEFECTS.md, Д-62). The
# diagnostics still read it to tell "the legacy stack was left out on purpose"
# from "dense is broken", and to advise a mount rather than
# `npm run setup -- --dense`, which no container can run (Д-59).
ENV AI_DEV_DENSE_INSTALLED=${INSTALL_BGE_M3}

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    AI_DEV_RUNTIME=docker \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    AI_DEV_VAULT_ROOT=/data/ai-dev-system \
    AI_DEV_HOME=/data/runtime-home/.ai-dev \
    AI_DEV_STATE_ROOT=/data/runtime-home/.ai-dev/state \
    AI_DEV_SEARCH_INDEX_DIR=/data/runtime-home/.ai-dev/cache/search-index \
    AI_DEV_FRONTEND_QA_ARTIFACT_ROOT=/data/runtime-home/.ai-dev/artifacts/frontend-qa \
    AI_DEV_PYTHON=/usr/bin/python3 \
    BGE_M3_MODEL_DIR=/models/bge-m3 \
    BGE_M3_ONNX_DIR=/models/bge-m3-onnx \
    HOME=/data/runtime-home \
    USERPROFILE=/data/runtime-home

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-freefont-ttf \
      fonts-ipafont-gothic \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-tlwg-loma-otf \
      fonts-unifont \
      fonts-wqy-zenhei \
      git \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libfontconfig1 \
      libfreetype6 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      python3 \
      python3-venv \
      tini \
      xfonts-scalable \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ai-dev/app
COPY app/package.json app/package-lock.json ./
# --ignore-scripts on purpose, and onnxruntime-node survives it: its prebuilt
# binaries ship inside the npm package rather than arriving through a postinstall
# download, so `require`ing it here works without `npm rebuild`. The step below
# proves that at build time instead of leaving it to a user's first search
# (docs/DEFECTS.md, Д-62).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node -e "import('onnxruntime-node').then((m) => { if (!m.InferenceSession) { throw new Error('onnxruntime-node loaded without InferenceSession'); } })" \
    && npm cache clean --force
COPY app/ ./

WORKDIR /opt/ai-dev/frontend-qa
COPY runtime/frontend-qa/package.json runtime/frontend-qa/pnpm-lock.yaml ./
RUN npm install --global pnpm@11.9.0 --ignore-scripts --no-audit --no-fund \
    && pnpm install --frozen-lockfile --prod=false \
    && pnpm exec playwright install chromium \
    && pnpm store prune \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
COPY runtime/frontend-qa/frontend_qa_runner.mjs ./

COPY runtime/search-index/ /opt/ai-dev/search-index/
COPY runtime/search-eval/ /opt/ai-dev/search-eval/
COPY runtime/embeddings/ /opt/ai-dev/embeddings/
# The legacy backend only. The default image has dense search through ONNX and
# does not need any of this (docs/DEFECTS.md, Д-62).
RUN if [ "${INSTALL_BGE_M3}" = "1" ]; then \
      python3 -m venv /opt/ai-dev/embeddings/.venv \
      && /opt/ai-dev/embeddings/.venv/bin/python -m pip install \
        --no-cache-dir \
        -r /opt/ai-dev/embeddings/requirements-bge-m3.txt; \
    fi

COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks

COPY public-seed/ /opt/ai-dev/public-seed/
COPY LICENSE README.md THIRD_PARTY_NOTICES.md /opt/ai-dev/

# The Frontend QA runner imports the server as `../ai-dev-mcp-server`, which is
# where it sits in a checkout. Without this the runner dies on its first import
# and the health check blames Playwright, which is installed (docs/DEFECTS.md,
# Д-56). ESM resolves through realpath, so the symlink is enough.
RUN ln -s /opt/ai-dev/app /opt/ai-dev/ai-dev-mcp-server
COPY container/entrypoint.sh /usr/local/bin/ai-dev-entrypoint

RUN chmod 0755 /usr/local/bin/ai-dev-entrypoint \
    && mkdir -p /data /models/bge-m3 /models/bge-m3-onnx /workspace \
    && chown -R node:node /data /models /workspace

VOLUME ["/data"]
WORKDIR /workspace
USER node
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ai-dev-entrypoint"]
CMD ["node", "/opt/ai-dev/app/src/server.mjs"]
