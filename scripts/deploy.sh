#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "未检测到 Docker。请先阅读 README 的部署章节并安装 Docker Engine。"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "未检测到 Docker Compose 插件。请先安装 docker-compose-plugin。"
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "已生成 .env。新手建议直接运行 ./scripts/setup.sh；也可手动填写后重新部署。"
  exit 1
fi

./scripts/check-config.sh
docker compose build --pull app
docker compose up -d

domain="$(awk -F= '$1 == "DOMAIN" {sub(/^[^=]*=/, ""); print; exit}' .env | tr -d '\r')"
healthy=0
for _ in $(seq 1 30); do
  if docker compose exec -T app python -c "import json,urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=3)); raise SystemExit(0 if data.get('ok') else 1)" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" -ne 1 ]]; then
  echo "应用在 60 秒内未通过健康检查。请运行 ./scripts/status.sh 查看原因。"
  docker compose ps
  exit 1
fi

echo "平台应用已通过健康检查。HTTPS 证书首次签发通常还需要几十秒。"
echo "访问地址：https://${domain}"
echo "部署向导：https://${domain}/deploy.html"
echo "如需完整诊断：./scripts/doctor.sh"
docker compose ps
