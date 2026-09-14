#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "未找到 .env。请先运行 ./scripts/setup.sh，或复制 .env.example 后填写。"
  exit 1
fi

read_value() {
  awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' .env | tr -d '\r'
}

domain="$(read_value DOMAIN)"
email="$(read_value ACME_EMAIL)"
registration_code="$(read_value CDPA_REGISTRATION_CODE)"

if [[ -z "$domain" || "$domain" == *"://"* || "$domain" == */* || ! "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  echo "DOMAIN 格式不正确：只填写域名，例如 assessment.example.com。"
  exit 1
fi

if [[ ! "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "ACME_EMAIL 格式不正确：请填写可以接收证书提醒的邮箱。"
  exit 1
fi

if (( ${#registration_code} < 20 )) || [[ "$registration_code" =~ [[:space:]] ]] || [[ "$registration_code" == replace-* ]]; then
  echo "CDPA_REGISTRATION_CODE 必须是至少 20 位、无空格且已替换的随机字符串。"
  exit 1
fi

chmod 600 .env
echo "✓ 站点配置格式正确"
echo "✓ .env 权限已限制为仅当前管理员可读写"

if command -v getent >/dev/null 2>&1; then
  if getent ahostsv4 "$domain" >/dev/null 2>&1; then
    resolved_ip="$(getent ahostsv4 "$domain" | awk 'NR == 1 {print $1}')"
    echo "✓ 域名可以解析：${domain} -> ${resolved_ip}"
  else
    echo "! 暂时查不到域名解析。请先在域名控制台添加 A 记录，再继续部署。"
  fi
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose config --quiet
  echo "✓ Docker Compose 配置通过检查"
else
  echo "! 尚未检测到 Docker 与 Compose。新服务器请先运行：sudo ./scripts/install-docker-ubuntu.sh"
fi

