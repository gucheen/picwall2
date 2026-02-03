# use the official Node.js 24 image
FROM node:24-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies (shadow/bash might still be useful for entrypoint, jemalloc for sharp)
RUN apk add --no-cache \
    su-exec \
    shadow \
    bash \
    jemalloc

WORKDIR /usr/src/app

# 拷贝并设置 entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json pnpm-lock.yaml* /temp/dev/
RUN cd /temp/dev && pnpm install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json pnpm-lock.yaml* /temp/prod/
RUN cd /temp/prod && pnpm install --prod --frozen-lockfile

# install with --production (exclude devDependencies) for final image usage? 
# actually we build first.
# Let's keep a build stage.
FROM install AS build
COPY . /temp/dev
RUN cd /tem/dev && pnpm run build

# Release stage
FROM base AS release
WORKDIR /usr/src/app
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=build /temp/dev/dist dist
COPY package.json .

# Use jemalloc to prevent memory fragmentation in Alpine
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
# run the app
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
