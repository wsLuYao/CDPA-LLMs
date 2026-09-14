#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  read -r -p "已经存在 .env。是否重新填写站点配置？输入 y 才会覆盖：[y/N] " overwrite
  if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
    echo "已保留原配置。可以运行 ./scripts/deploy.sh 继续部署。"
    exit 0
  fi
  backup_name=".env.backup.$(date -u +%Y%m%d_%H%M%S)"
  cp .env "$backup_name"
  chmod 600 "$backup_name"
  echo "原配置已备份为 ${backup_name}"
fi

while true; do
  read -r -p "请输入已经解析到本服务器的域名（不要写 https://）：" domain
  if [[ "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then break; fi
  echo "格式不正确。示例：assessment.example.com"
done

while true; do
  read -r -p "请输入接收 HTTPS 证书提醒的邮箱：" email
  if [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then break; fi
  echo "邮箱格式不正确，请重新输入。"
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "未检测到 openssl。请先执行：sudo apt-get update && sudo apt-get install -y openssl"
  exit 1
fi
registration_code="$(openssl rand -hex 24)"

umask 077
printf '%s\n' \
  "DOMAIN=${domain}" \
  "ACME_EMAIL=${email}" \
  "CDPA_REGISTRATION_CODE=${registration_code}" \
  'CDPA_MAX_ACTIVE_PROJECTS=2' \
  'CDPA_MAX_ACTIVE_PER_USER=2' \
  'TZ=Asia/Shanghai' \
  > .env

echo
echo "站点配置已生成。请把下面的邀请码保存到密码管理器或安全位置："
echo "${registration_code}"
echo
./scripts/check-config.sh

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "下一步：sudo ./scripts/install-docker-ubuntu.sh"
  echo "安装完成后再运行：./scripts/deploy.sh"
  exit 0
fi

read -r -p "配置检查完成。现在构建并启动网站吗？[Y/n] " launch
if [[ -z "$launch" || "$launch" =~ ^[Yy]$ ]]; then
  ./scripts/deploy.sh
else
  echo "稍后运行 ./scripts/deploy.sh 即可启动。"
fi

