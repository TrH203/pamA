# pamA server image: self-host and pamA Cloud run the same image (Constitution IV).
# Build from the repository root: docker build -f deploy/Dockerfile -t pama-server .

FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @pama/web build
RUN pnpm --filter @pama/server deploy --prod --legacy /out/server

FROM node:24-slim
ENV NODE_ENV=production \
    PAMA_MODE=selfhost \
    PAMA_PORT=7465 \
    PAMA_BIND=0.0.0.0 \
    PAMA_DATA_DIR=/data \
    PAMA_WEB_DIR=/app/web \
    PAMA_RULES_DIR=/app/rules \
    PAMA_PROMPTS_DIR=/app/prompts \
    PAMA_MIGRATIONS_DIR=/app/server/migrations
WORKDIR /app/server
COPY --from=build /out/server /app/server
COPY --from=build /src/apps/web/dist /app/web
COPY rules/gitleaks.toml rules/pama.toml /app/rules/
COPY prompts /app/prompts
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 7465
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:7465/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]
