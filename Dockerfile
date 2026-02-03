# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base

# 安装 gosu 和 passwd (用于 usermod)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    passwd \
    libjemalloc2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# 拷贝并设置 entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Change memory allocator to avoid leaks
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src src
COPY --from=prerelease /usr/src/app/server server
COPY --from=prerelease /usr/src/app/types types
COPY --from=prerelease /usr/src/app/package.json .

# run the app
ENV NODE_ENV=production
EXPOSE 3000/tcp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "server/index.ts"]
