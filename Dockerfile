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

# Use jemalloc to prevent memory fragmentation in Alpine
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2

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

# install with --production (exclude devDependencies) for final image usage? 
# actually we build first.
# Let's keep a build stage.
FROM install AS build
COPY . /usr/src/app
WORKDIR /usr/src/app
RUN pnpm run build

# Release stage
FROM base AS release
COPY --from=install /temp/dev/node_modules node_modules
# Actually we need prod deps only for runner? 
# But node_modules in install/dev contains everything.
# Let's do a proper prod install.
WORKDIR /temp/prod
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile

WORKDIR /usr/src/app
COPY --from=release /temp/prod/node_modules node_modules
COPY --from=build /usr/src/app/dist dist
COPY --from=build /usr/src/app/package.json .
COPY --from=build /usr/src/app/public public 

# run the app
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
