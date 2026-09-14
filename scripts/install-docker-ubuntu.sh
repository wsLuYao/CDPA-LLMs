#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 sudo 运行：sudo ./scripts/install-docker-ubuntu.sh"
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "无法识别服务器系统。本脚本仅支持 Ubuntu 22.04、24.04 或 26.04 64 位。"
  exit 1
fi

. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]] || [[ ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04|26\.04)$ ]]; then
  echo "当前系统为 ${PRETTY_NAME:-未知}。请按 Docker 官方文档手动安装，不要强行运行本脚本。"
  exit 1
fi

conflicts=()
for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
    conflicts+=("$package")
  fi
done
if (( ${#conflicts[@]} > 0 )); then
  echo "检测到可能冲突的旧软件包：${conflicts[*]}"
  echo "为避免误删现有容器，本脚本已停止。请先备份并参照 Docker 官方文档处理冲突包。"
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

ubuntu_codename="${UBUNTU_CODENAME:-${VERSION_CODENAME}}"
architecture="$(dpkg --print-architecture)"
printf '%s\n' \
  'Types: deb' \
  'URIs: https://download.docker.com/linux/ubuntu' \
  "Suites: ${ubuntu_codename}" \
  'Components: stable' \
  "Architectures: ${architecture}" \
  'Signed-By: /etc/apt/keyrings/docker.asc' \
  > /etc/apt/sources.list.d/docker.sources

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker run --rm hello-world
docker compose version

echo "Docker Engine 与 Compose 已安装并启动。"

