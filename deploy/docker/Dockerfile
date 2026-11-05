# syntax=docker/dockerfile:1.7
#
# Agent orchestrator, server mode: backend + built frontend + the toolchains
# role sessions need to build and test target repos.
#
#   docker compose -f deploy/docker-compose.yml --profile server up -d --build
#
# Build args turn toolchains off to shrink the image (all on by default):
#   INSTALL_PYTHON, INSTALL_GO, INSTALL_DOTNET, INSTALL_PLAYWRIGHT_DEPS
# Behind a TLS-intercepting proxy, pass its CA as a build secret:
#   docker build --secret id=extra_ca,src=corp-ca.crt ...
# (it is added to the image's trust store, so the running container trusts it too).

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN --mount=type=secret,id=extra_ca,required=false \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && if [ -f /run/secrets/extra_ca ]; then cp /run/secrets/extra_ca /usr/local/share/ca-certificates/extra-ca.crt && update-ca-certificates; fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
COPY backend/package.json backend/package-lock.json backend/
COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm --prefix backend ci && npm --prefix frontend ci
COPY backend backend
COPY frontend frontend
RUN npm --prefix backend run build \
 && npm --prefix frontend run build \
 && npm --prefix backend prune --omit=dev

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG INSTALL_PYTHON=true
ARG INSTALL_GO=true
ARG INSTALL_DOTNET=true
ARG INSTALL_PLAYWRIGHT_DEPS=true
ARG GH_VERSION=2.63.2
ARG GO_VERSION=1.23.4
ARG DOTNET_CHANNEL=8.0
ARG PLAYWRIGHT_VERSION=1.49.1
ARG TARGETARCH

RUN --mount=type=secret,id=extra_ca,required=false \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && if [ -f /run/secrets/extra_ca ]; then cp /run/secrets/extra_ca /usr/local/share/ca-certificates/extra-ca.crt && update-ca-certificates; fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Base tools: git (worktrees, clones), ssh (git@ URLs), curl (installers).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client curl ca-certificates \
 && if [ "$INSTALL_PYTHON" = "true" ]; then apt-get install -y --no-install-recommends python3 python3-venv python3-pip; fi \
 && if [ "$INSTALL_DOTNET" = "true" ]; then apt-get install -y --no-install-recommends libicu72; fi \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI: PR creation and git credentials (GH_TOKEN).
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" | tar -xz -C /tmp \
 && mv /tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh /usr/local/bin/gh \
 && rm -rf /tmp/gh_*

RUN if [ "$INSTALL_GO" = "true" ]; then \
      curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" | tar -xz -C /usr/local; \
    fi
ENV PATH=/usr/local/go/bin:$PATH

RUN if [ "$INSTALL_DOTNET" = "true" ]; then \
      curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
      && bash /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir /usr/share/dotnet \
      && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
      && rm /tmp/dotnet-install.sh; \
    fi
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

# System libraries for headless Chromium. Browsers themselves are installed per
# repo by the E2E Tester (after approval), matching that repo's Playwright version.
RUN if [ "$INSTALL_PLAYWRIGHT_DEPS" = "true" ]; then \
      npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium && rm -rf /var/lib/apt/lists/* /root/.npm; \
    fi

RUN useradd --create-home --uid 10001 --shell /bin/bash orchestrator \
 && mkdir -p /data && chown orchestrator:orchestrator /data

WORKDIR /app
COPY --from=build --chown=orchestrator:orchestrator /app/backend/dist backend/dist
COPY --from=build --chown=orchestrator:orchestrator /app/backend/node_modules backend/node_modules
COPY --from=build --chown=orchestrator:orchestrator /app/backend/package.json backend/package.json
COPY --from=build --chown=orchestrator:orchestrator /app/frontend/dist frontend/dist
COPY --chown=orchestrator:orchestrator roles roles
COPY --chown=orchestrator:orchestrator templates templates
COPY --chmod=755 deploy/docker/entrypoint.sh /usr/local/bin/orchestrator-entrypoint

# Everything stateful lives under /data (one volume): runs, SDK session ids,
# worktrees, clones, and Claude Code's own config + session history.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5174 \
    RUNS_DIR=/data/runs \
    SESSIONS_DIR=/data/sessions \
    WORKTREES_DIR=/data/worktrees \
    REPOS_DIR=/data/repos \
    CLAUDE_CONFIG_DIR=/data/claude \
    PLAYWRIGHT_BROWSERS_PATH=/data/playwright-browsers \
    ALLOW_LOCAL_REPO_PATHS=false

USER orchestrator
VOLUME ["/data"]
EXPOSE 5174
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5174)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["orchestrator-entrypoint"]
CMD ["node", "backend/dist/index.js"]
