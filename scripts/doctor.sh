#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."

failures=0
warnings=0
doctor_tmp="$(mktemp)"
trap 'rm -f "$doctor_tmp"' EXIT

pass() {
  echo "✓ $1"
}

warn() {
  echo "! $1"
  warnings=$((warnings + 1))
}

fail() {
  echo "✗ $1"
  failures=$((failures + 1))
}

read_env_value() {
  awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' .env 2>/dev/null | tr -d '\r'
}

echo "CDPA-LLMs 部署诊断"
echo

if [[ -r /etc/os-release ]]; then
  os_name="$(awk -F= '$1 == "PRETTY_NAME" {gsub(/^"|"$/, "", $2); print $2}' /etc/os-release)"
  if [[ -n "$os_name" ]]; then
    pass "操作系统：$os_name"
  else
    pass "已识别 Linux 操作系统"
  fi
else
  warn "无法读取 /etc/os-release；正式部署推荐 Ubuntu 24.04 LTS。"
fi

cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"
if [[ "$cpu_count" =~ ^[0-9]+$ ]] && (( cpu_count >= 2 )); then
  pass "CPU：$cpu_count 核"
else
  warn "CPU 少于 2 核，构建镜像和并发测评可能较慢。"
fi

memory_kb="$(awk '/MemTotal/ {print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)"
if [[ "$memory_kb" =~ ^[0-9]+$ ]] && (( memory_kb >= 3500000 )); then
  pass "内存：约 $((memory_kb / 1024)) MB"
else
  warn "可识别内存低于约 4 GB，正式使用建议升级到 4 GB 或更高。"
fi

disk_kb="$(df -Pk . 2>/dev/null | awk 'NR == 2 {print $4}')"
if [[ "$disk_kb" =~ ^[0-9]+$ ]] && (( disk_kb >= 10485760 )); then
  pass "当前磁盘可用：约 $((disk_kb / 1024 / 1024)) GB"
else
  warn "当前目录可用空间低于 10 GB，构建镜像或保存结果可能失败。"
fi

if command -v docker >/dev/null 2>&1; then
  pass "Docker：$(docker --version 2>/dev/null || echo 已安装)"
  if docker compose version >/dev/null 2>&1; then
    pass "Docker Compose 插件已安装"
  else
    fail "未检测到 docker compose 插件。"
  fi
else
  warn "尚未安装 Docker；新服务器请运行 sudo ./scripts/install-docker-ubuntu.sh。"
fi

if [[ -f .env ]]; then
  pass "已找到 .env"
  if ./scripts/check-config.sh >"$doctor_tmp" 2>&1; then
    sed -n 's/^[✓!] /  &/p' "$doctor_tmp"
  else
    fail "站点配置检查失败；请直接运行 ./scripts/check-config.sh 查看详情。"
  fi
else
  warn "尚未生成 .env；请运行 ./scripts/setup.sh。"
fi

if command -v ss >/dev/null 2>&1; then
  for port in 80 443; do
    if ss -lntH "sport = :$port" 2>/dev/null | grep -q .; then
      pass "TCP $port 已有服务监听"
    else
      warn "TCP $port 尚无服务监听；部署前正常，部署后应由 Caddy 监听。"
    fi
  done
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && [[ -f .env ]]; then
  if docker compose ps >/dev/null 2>&1; then
    echo
    docker compose ps
  fi
  if docker compose exec -T app python -c "import json,urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=3)); raise SystemExit(0 if data.get('ok') else 1)" >/dev/null 2>&1; then
    pass "应用容器健康检查通过"
  else
    warn "应用容器尚未运行或健康检查未通过。"
  fi

  domain="$(read_env_value DOMAIN)"
  if [[ -n "$domain" ]] && command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 12 "https://$domain/api/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      pass "公网 HTTPS 健康检查通过：https://$domain"
    else
      warn "暂时无法通过公网 HTTPS 访问 $domain；请检查 DNS、安全组与 Caddy 日志。"
    fi
  fi
fi

echo
if (( failures > 0 )); then
  echo "诊断完成：$failures 个错误，$warnings 个提醒。请先修复错误项。"
  exit 1
fi
echo "诊断完成：没有发现阻断错误，$warnings 个提醒。"
