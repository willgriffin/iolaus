# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/site/package.json apps/site/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/resume/package.json packages/resume/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install --frozen-lockfile

FROM deps AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV DATABASE_URL=postgresql://iolaus:iolaus@localhost:5432/iolaus_build
ENV SMRT_RUNTIME_PROFILE=self-hosted
# The CI workflow sets NODE_OPTIONS for the runner, but that does not cross into
# the Docker build, so the in-container vite build OOMs on Node's ~2GB default
# heap. Raise it here to match the workflow.
ENV NODE_OPTIONS=--max-old-space-size=8192
COPY . .
RUN pnpm --filter @willgriffin/iolaus-site build

FROM base AS runner
ARG IOLAUS_SOURCE_REVISION=unknown
ARG IOLAUS_LOCKFILE_SHA256=unknown
LABEL org.opencontainers.image.revision="${IOLAUS_SOURCE_REVISION}"
LABEL dev.happyvertical.iolaus.pnpm-lock.sha256="${IOLAUS_LOCKFILE_SHA256}"
ENV NODE_ENV=production
ENV SMRT_RUNTIME_PROFILE=self-hosted
ENV HOST=0.0.0.0
ENV PORT=3000
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
  && groupadd --gid 10001 iolaus \
  && useradd --uid 10001 --gid iolaus --create-home --home-dir /home/iolaus \
    --shell /usr/sbin/nologin iolaus \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=iolaus:iolaus /app /app
# Runtime entrypoints use this lockfile-pinned loader directly. This build-time
# smoke prevents a released image from falling back to Corepack/pnpm downloads.
RUN test -x /app/node_modules/.bin/tsx \
  && node --import tsx --eval "import('./apps/site/scripts/jobs-worker-bootstrap.ts')"
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/site/build"]
