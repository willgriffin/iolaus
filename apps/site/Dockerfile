# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/site/package.json apps/site/package.json
COPY apps/resume-pdf/package.json apps/resume-pdf/package.json
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
# The CI workflow sets NODE_OPTIONS for the runner, but that does not cross into
# the Docker build, so the in-container vite build OOMs on Node's ~2GB default
# heap. Raise it here to match the workflow.
ENV NODE_OPTIONS=--max-old-space-size=8192
COPY . .
RUN pnpm --filter @willgriffin/iolaus-site build

FROM base AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "apps/site/build"]
