FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/db/package.json packages/db/
COPY packages/judge-protocol/package.json packages/judge-protocol/
COPY packages/observability/package.json packages/observability/
COPY packages/realtime/package.json packages/realtime/
COPY apps/judged/package.json apps/judged/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter "@duckoj/judged..." typecheck

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 9999 3001
CMD ["node", "apps/judged/dist/main.js"]
