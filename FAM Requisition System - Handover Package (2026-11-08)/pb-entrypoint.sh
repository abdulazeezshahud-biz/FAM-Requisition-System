#!/bin/sh
# PocketBase container entrypoint: ensure the superuser exists (from env, idempotent),
# then start the server. Data persists in the pb_data volume.
set -e
if [ -n "$PB_ADMIN" ] && [ -n "$PB_ADMIN_PASS" ]; then
  /pb/pocketbase superuser upsert "$PB_ADMIN" "$PB_ADMIN_PASS" 2>/dev/null \
    && echo "[pb] superuser ensured: $PB_ADMIN" \
    || echo "[pb] superuser upsert skipped (already set or password too short)"
fi
exec /pb/pocketbase serve --http=0.0.0.0:8090
