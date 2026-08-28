#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
    USER_ID=${LOCAL_USER_ID:-1000}
    GROUP_ID=${LOCAL_GROUP_ID:-$USER_ID}
    if [ "$(id -g bun)" != "$GROUP_ID" ]; then
        groupmod -o -g "$GROUP_ID" bun
    fi
    if [ "$(id -u bun)" != "$USER_ID" ]; then
        usermod -o -u "$USER_ID" bun
    fi
    mkdir -p data files
    chown bun:bun data files
    exec /sbin/su-exec bun "$@"
fi

exec "$@"
