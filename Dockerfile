FROM oven/bun:1.4.0-alpine AS base
WORKDIR /usr/src/app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM install AS build
COPY . .
RUN bun run build
RUN bun test

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM base AS release
USER root
RUN apk add --no-cache su-exec shadow
COPY --from=production-dependencies /usr/src/app/node_modules node_modules
COPY --from=build /usr/src/app/dist dist
COPY package.json LICENSE ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && \
    mkdir -p data files && chown bun:bun data files
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "dist/server/index.js"]
