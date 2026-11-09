#!/bin/sh
# Frontend container entrypoint: inject the backend URL (if provided) into
# config.js, then start nginx. PB_URL is set by docker-compose from ${DOMAIN}.
set -e
if [ -n "$PB_URL" ]; then
  printf 'window.PB_URL=%s;\n' "\"$PB_URL\"" > /usr/share/nginx/html/config.js
  echo "[entrypoint] PB_URL set to $PB_URL"
fi
exec nginx -g 'daemon off;'
