# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src ./src
COPY evals ./evals
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV COBLE_HOME=/data
WORKDIR /workspace

COPY --from=build /app/package.json /app/package-lock.json /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/evals /app/evals
COPY README.md LICENSE /app/

RUN mkdir -p /data /workspace \
  && chown -R node:node /app /data /workspace

USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
