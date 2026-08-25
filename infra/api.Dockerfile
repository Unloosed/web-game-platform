# Multi-stage API image. Build context must be the repository root.
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY apps/api ./apps/api
COPY packages ./packages
# Run as the unprivileged node user, not root.
USER node
EXPOSE 4000
CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]
