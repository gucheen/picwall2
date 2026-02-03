FROM node:24-alpine AS base

RUN corepack enable && corepack prepare pnpm@latest --activate

RUN apk add --no-cache \
    su-exec \
    shadow \
    bash \
    jemalloc

# Use jemalloc to prevent memory fragmentation in Alpine
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2

WORKDIR /usr/src/app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json pnpm-lock.yaml* /temp/dev/
RUN cd /temp/dev && pnpm install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json pnpm-lock.yaml* /temp/prod/
RUN cd /temp/prod && pnpm install --prod --frozen-lockfile

FROM install AS build
COPY . /temp/dev
RUN cd /temp/dev && pnpm run build

FROM base AS release
WORKDIR /usr/src/app
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=build /temp/dev/dist dist
COPY package.json .

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
