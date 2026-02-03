#!/bin/sh

# 获取通过 docker-compose user: 指定的 UID/GID
# 如果没有指定，默认使用 1000
USER_ID=${LOCAL_USER_ID:-1000}

echo "Starting with UID : $USER_ID"

# 动态修改内部用户的 UID
usermod -u $USER_ID bun
groupmod -g $USER_ID bun

# 确保工作目录归该用户所有
chown -R bun:bun /usr/src/app

# 使用 su-exec 切换到 bun 并执行后续命令（即 CMD）
exec /sbin/su-exec bun "$@"