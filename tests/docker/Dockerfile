# Portable contract tests only: this image cannot qualify Windows VHDX/SCM.
FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2
WORKDIR /work
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npx --yes pnpm@11.18.0 install --frozen-lockfile --ignore-scripts --filter honey-bee --filter @honeybee/core \
    && chown -R node:node /work
COPY vitest.config.ts ./
COPY packages/core/src/ packages/core/src/
USER node
CMD ["node", "node_modules/vitest/vitest.mjs", "run", "packages/core/src/workspace-storage-timeout.test.ts", "packages/core/src/workspace-storage-tools.test.ts"]
