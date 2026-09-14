#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p backups
stamp="$(date -u +%Y%m%d_%H%M%S)"
archive="cdpa_data_${stamp}.tar.gz"

restart_app() {
  docker compose start app >/dev/null 2>&1 || true
}
trap restart_app EXIT

docker compose stop app
docker run --rm \
  -v cdpa_data:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.22 \
  tar -czf "/backup/${archive}" -C /source .
docker compose start app
trap - EXIT

echo "备份已生成：backups/${archive}"
