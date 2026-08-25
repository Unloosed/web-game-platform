# Static web client build served by nginx. Build context: apps/web.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY . .
# Vite bakes these at build time; point them at your public origins.
ARG VITE_API_URL=http://localhost:4000
ARG VITE_GAME_URL=http://localhost:4100
ENV VITE_API_URL=$VITE_API_URL VITE_GAME_URL=$VITE_GAME_URL
RUN pnpm build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
