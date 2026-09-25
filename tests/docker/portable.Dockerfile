FROM golang:1.26.2-bookworm@sha256:47ce5636e9936b2c5cbf708925578ef386b4f8872aec74a67bd13a627d242b19 AS go
FROM mcr.microsoft.com/powershell:7.5-debian-12@sha256:7ab5bd5ca6f95a3351fa0c6a1205237d57048c94542355aab55519a0861a9b25 AS powershell
FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2
COPY --from=go /usr/local/go /usr/local/go
COPY --from=powershell /opt/microsoft/powershell/7 /opt/microsoft/powershell/7
ENV PATH="/usr/local/go/bin:${PATH}" CI=true GOTOOLCHAIN=local GOMAXPROCS=2 GOPATH=/go COREPACK_HOME=/opt/corepack
ENV npm_config_store_dir=/opt/pnpm-store pnpm_config_store_dir=/opt/pnpm-store
RUN apt-get update && apt-get install -y --no-install-recommends git python3 gcc libc6-dev ca-certificates libicu72 libunwind8 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global corepack@0.34.6 \
    && corepack enable && corepack prepare pnpm@11.18.0 --activate \
    && ln -s /usr/bin/git /usr/local/bin/git.exe \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh
WORKDIR /work
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN corepack pnpm install --frozen-lockfile --ignore-scripts \
    && mkdir /go && chown -R node:node /work /go /opt/corepack /opt/pnpm-store
COPY --chown=node:node . .
USER node
RUN node tests/docker/prepare-go.mjs && git init && git add . ':!external'
ENV GOPATH=/go GOPROXY=off GOSUMDB=off
CMD ["node", "tests/docker/run-portable.mjs"]
