from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

from app import APP_NAME, APP_VERSION
from app.auth import AuthStore
from app.web_server import build_server


def available_port(host: str, preferred: int) -> int:
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError("8765—8784端口均被占用，请关闭旧平台后重试")


def main() -> int:
    parser = argparse.ArgumentParser(description=f"{APP_NAME} {APP_VERSION}")
    env_online = os.environ.get("CDPA_ONLINE", "").lower() in {"1", "true", "yes"}
    parser.add_argument("--host", default="0.0.0.0" if env_online else "127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("CDPA_PORT", "8765")))
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--online", action="store_true", default=env_online)
    parser.add_argument("--data-dir", default=os.environ.get("CDPA_DATA_DIR", ""))
    parser.add_argument("--trusted-origins", default=os.environ.get("CDPA_TRUSTED_ORIGINS", ""))
    parser.add_argument("--registration-code", default=os.environ.get("CDPA_REGISTRATION_CODE", ""))
    parser.add_argument("--cookie-secure", action="store_true", default=os.environ.get("CDPA_COOKIE_SECURE", "").lower() in {"1", "true", "yes"})
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    if args.online:
        os.environ["CDPA_ONLINE"] = "1"
    port = args.port if args.online else available_port(args.host, args.port)
    data_root = Path(args.data_dir).expanduser().resolve() if args.data_dir else root
    data_root.mkdir(parents=True, exist_ok=True)
    if args.online and not args.registration_code:
        print("错误：线上模式必须设置 CDPA_REGISTRATION_CODE，避免站点被陌生人注册。", file=sys.stderr)
        return 2
    auth_store = AuthStore(data_root / "auth" / "accounts.sqlite3", args.registration_code) if args.online else None
    trusted_origins = {value.strip().rstrip("/") for value in args.trusted_origins.split(",") if value.strip()}
    server = build_server(
        args.host,
        port,
        root / "web",
        root / "question_banks",
        data_root / "results",
        data_root / "projects",
        root / "human_reference",
        auth_store=auth_store,
        trusted_origins=trusted_origins,
        cookie_secure=args.cookie_secure,
    )
    url = f"http://{args.host}:{port}/"
    print("=" * 70)
    print(f"{APP_NAME} {APP_VERSION}")
    print(f"服务地址：{url}")
    if args.online:
        print("线上模式已启用：账号数据与项目结果持久化；API Key仍只保留在进程内存。")
    else:
        print("本地模式：题库、API Key与运行结果均在本机处理；关闭本窗口会停止服务。")
    print("=" * 70)
    if not args.no_browser and not args.online:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("\n平台已停止。未完成项目可在下次启动后恢复。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
