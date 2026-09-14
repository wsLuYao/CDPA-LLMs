from __future__ import annotations

import json
import mimetypes
import re
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import APP_VERSION
from .auth import AuthError, AuthStore, Session
from .csv_loader import BankValidationError
from .project_manager import ProjectManager
from .providers import ApiError, PROVIDER_PRESETS


PROJECT_ROUTE = re.compile(r"^/api/projects/([^/]+)$")
PROJECT_ACTION_ROUTE = re.compile(r"^/api/projects/([^/]+)/(analysis|advanced-files|download|pause|continue|resume|cancel|open-folder)$")
RUN_ROUTE = re.compile(r"^/api/runs/([^/]+)$")
RUN_DOWNLOAD_ROUTE = re.compile(r"^/api/runs/([^/]+)/download/(.+)$")
AUTH_COOKIE = "cdpa_session"


@dataclass
class AttemptWindow:
    started_at: float
    count: int


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        web_dir: Path,
        manager: ProjectManager,
        auth_store: AuthStore | None = None,
        trusted_origins: set[str] | None = None,
        cookie_secure: bool = False,
    ) -> None:
        super().__init__(address, AppHandler)
        self.web_dir = web_dir.resolve()
        self.manager = manager
        self.auth_store = auth_store
        self.online = auth_store is not None
        self.trusted_origins = {value.rstrip("/") for value in (trusted_origins or set()) if value}
        self.cookie_secure = cookie_secure
        self._attempts: dict[str, AttemptWindow] = {}
        self._attempt_lock = threading.Lock()

    def allow_auth_attempt(self, client_key: str) -> bool:
        now = time.monotonic()
        with self._attempt_lock:
            current = self._attempts.get(client_key)
            if not current or now - current.started_at > 300:
                self._attempts[client_key] = AttemptWindow(started_at=now, count=1)
                return True
            current.count += 1
            return current.count <= 20


class AppHandler(BaseHTTPRequestHandler):
    server: AppServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; "
            "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        )

    def _json(self, payload: Any, status: int = 200, extra_headers: list[tuple[str, str]] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        for key, value in extra_headers or []:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 400, code: str = "BAD_REQUEST") -> None:
        self._json({"ok": False, "error": message, "code": code}, status)

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Content-Length 不合法") from None
        if length <= 0:
            return {}
        if length > 80_000_000:
            raise ValueError("请求内容过大；请分批导入历史结果")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求不是有效的 UTF-8 JSON") from None
        if not isinstance(payload, dict):
            raise ValueError("请求 JSON 顶层必须是对象")
        return payload

    def _cookie_value(self) -> str:
        try:
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            morsel = cookies.get(AUTH_COOKIE)
            return morsel.value if morsel else ""
        except Exception:
            return ""

    def _session(self) -> Session | None:
        if not self.server.auth_store:
            return Session(user_id="local", email="local@device", csrf_token="", expires_at=2**31)
        return self.server.auth_store.read_session(self._cookie_value())

    def _require_session(self) -> Session:
        session = self._session()
        if not session:
            raise PermissionError("请先登录")
        return session

    def _require_csrf(self, session: Session) -> None:
        if not self.server.online:
            return
        supplied = self.headers.get("X-CSRF-Token", "")
        if not supplied or not secrets_compare(supplied, session.csrf_token):
            raise PermissionError("页面安全校验已失效，请刷新后重试")

    def _check_origin(self) -> None:
        if not self.server.online or not self.server.trusted_origins:
            return
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin and origin not in self.server.trusted_origins:
            raise PermissionError("请求来源不受信任")

    def _session_cookie(self, token: str, max_age: int = 7 * 24 * 60 * 60) -> str:
        parts = [f"{AUTH_COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
        if self.server.cookie_secure:
            parts.append("Secure")
        return "; ".join(parts)

    def _client_key(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
        return forwarded or str(self.client_address[0])

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self._json({"ok": True, "version": APP_VERSION, "online": self.server.online, "local_only": not self.server.online})
                return
            if path == "/api/auth/me":
                session = self._session()
                self._json({
                    "ok": True,
                    "authenticated": bool(session),
                    "online": self.server.online,
                    "registration_enabled": bool(self.server.auth_store and self.server.auth_store.registration_enabled),
                    "user": {"id": session.user_id, "email": session.email} if session else None,
                    "csrf_token": session.csrf_token if session else "",
                })
                return
            if not path.startswith("/api/"):
                self._static(path)
                return
            session = self._require_session()
            owner_id = session.user_id
            if path == "/api/presets":
                self._json({"ok": True, "presets": PROVIDER_PRESETS})
                return
            if path == "/api/banks":
                self._json({"ok": True, "banks": self.server.manager.banks()})
                return
            if path == "/api/projects":
                self._json({"ok": True, "projects": self.server.manager.list_projects(owner_id)})
                return
            if match := PROJECT_ACTION_ROUTE.fullmatch(path):
                project_id, action = match.groups()
                if action == "analysis":
                    self._json({"ok": True, "analysis": self.server.manager.analysis(project_id, owner_id)})
                    return
                if action == "advanced-files":
                    self._json({"ok": True, **self.server.manager.advanced_files(project_id, owner_id)})
                    return
                if action == "download":
                    file_path = self.server.manager.zip_project(project_id, owner_id)
                    self._file(file_path, download_name=file_path.name)
                    return
            if match := PROJECT_ROUTE.fullmatch(path):
                self._json({"ok": True, "project": self.server.manager.get_project(match.group(1), owner_id)})
                return
            if match := RUN_DOWNLOAD_ROUTE.fullmatch(path):
                run_id, filename = match.groups()
                self.server.manager.assert_run_owner(run_id, owner_id)
                filename = urllib.parse.unquote(filename)
                file_path = self.server.manager.runs.zip_run(run_id) if filename.endswith(".zip") else self.server.manager.runs.output_file(run_id, filename)
                self._file(file_path, None if query.get("inline") else file_path.name)
                return
            if match := RUN_ROUTE.fullmatch(path):
                run_id = match.group(1)
                self.server.manager.assert_run_owner(run_id, owner_id)
                self._json({"ok": True, "run": self.server.manager.runs.get_run(run_id)})
                return
            self._error("接口不存在", 404, "NOT_FOUND")
        except PermissionError as exc:
            self._error(str(exc), 401, "AUTH_REQUIRED")
        except KeyError as exc:
            self._error(str(exc).strip("'"), 404, "NOT_FOUND")
        except (ValueError, BankValidationError) as exc:
            self._error(str(exc), 400)
        except Exception as exc:
            self._internal_error(exc)

    def do_POST(self) -> None:
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        try:
            self._check_origin()
            payload = self._body()
            if path in {"/api/auth/login", "/api/auth/register"}:
                self._auth_action(path, payload)
                return
            session = self._require_session()
            self._require_csrf(session)
            owner_id = session.user_id
            if path == "/api/auth/logout":
                if self.server.auth_store:
                    self.server.auth_store.destroy_session(self._cookie_value())
                self._json({"ok": True}, extra_headers=[("Set-Cookie", self._session_cookie("", 0))])
                return
            if path == "/api/test-connection":
                result = self.server.manager.runs.test_connection(payload)
                self._json({"ok": True, "result": result})
                return
            if path == "/api/projects":
                project = self.server.manager.create_project(payload, owner_id)
                self._json({"ok": True, "project": project}, HTTPStatus.ACCEPTED)
                return
            if path == "/api/import":
                project = self.server.manager.import_project(payload, owner_id)
                self._json({"ok": True, "project": project}, HTTPStatus.CREATED)
                return
            if match := PROJECT_ACTION_ROUTE.fullmatch(path):
                project_id, action = match.groups()
                if action == "pause":
                    result = self.server.manager.pause_project(project_id, owner_id)
                elif action == "continue":
                    result = self.server.manager.continue_project(project_id, owner_id)
                elif action == "resume":
                    result = self.server.manager.resume_project(project_id, payload.get("models") or [], owner_id)
                elif action == "cancel":
                    result = self.server.manager.cancel_project(project_id, owner_id)
                elif action == "open-folder" and not self.server.online:
                    self.server.manager.open_folder(project_id, owner_id)
                    self._json({"ok": True})
                    return
                else:
                    self._error("该操作不支持POST", 405, "METHOD_NOT_ALLOWED")
                    return
                self._json({"ok": True, "project": result})
                return
            self._error("接口不存在", 404, "NOT_FOUND")
        except AuthError as exc:
            self._error(str(exc), 400, "AUTH_ERROR")
        except PermissionError as exc:
            self._error(str(exc), 401, "AUTH_REQUIRED")
        except ApiError as exc:
            self._error(str(exc), 502, exc.code)
        except KeyError as exc:
            self._error(str(exc).strip("'"), 404, "NOT_FOUND")
        except (ValueError, BankValidationError) as exc:
            self._error(str(exc), 400)
        except Exception as exc:
            self._internal_error(exc)

    def _auth_action(self, path: str, payload: dict[str, Any]) -> None:
        if not self.server.auth_store:
            self._json({"ok": True, "user": {"id": "local", "email": "local@device"}, "csrf_token": ""})
            return
        if not self.server.allow_auth_attempt(self._client_key()):
            self._error("尝试次数过多，请稍后再试", 429, "RATE_LIMITED")
            return
        if path.endswith("/register"):
            user = self.server.auth_store.register(
                str(payload.get("email") or ""),
                str(payload.get("password") or ""),
                str(payload.get("registration_code") or ""),
            )
        else:
            user = self.server.auth_store.authenticate(
                str(payload.get("email") or ""),
                str(payload.get("password") or ""),
            )
        token, session = self.server.auth_store.create_session(user["id"])
        self._json(
            {"ok": True, "user": user, "csrf_token": session.csrf_token},
            HTTPStatus.CREATED if path.endswith("/register") else HTTPStatus.OK,
            [("Set-Cookie", self._session_cookie(token))],
        )

    def _internal_error(self, exc: Exception) -> None:
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] server error: {exc!r}", file=sys.stderr)
        message = "服务器处理失败，请稍后重试" if self.server.online else f"服务器处理失败：{exc}"
        self._error(message, 500, "INTERNAL_ERROR")

    def _static(self, request_path: str) -> None:
        relative = "index.html" if request_path in {"", "/"} else request_path.lstrip("/")
        candidate = (self.server.web_dir / relative).resolve()
        if self.server.web_dir not in candidate.parents and candidate != self.server.web_dir:
            self._error("路径越界", 403, "FORBIDDEN")
            return
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.is_file():
            self._error("页面不存在", 404, "NOT_FOUND")
            return
        self._file(candidate)

    def _file(self, path: Path, download_name: str | None = None) -> None:
        data = path.read_bytes()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() == ".csv":
            mime = "text/csv"
        if mime.startswith("text/") or mime in {"application/javascript", "application/json"}:
            mime += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache" if not download_name else "no-store")
        self._security_headers()
        if download_name:
            quoted = urllib.parse.quote(download_name)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted}")
        self.end_headers()
        self.wfile.write(data)


def secrets_compare(left: str, right: str) -> bool:
    import hmac

    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def build_server(
    host: str,
    port: int,
    web_dir: Path,
    bank_dir: Path,
    results_dir: Path,
    projects_dir: Path,
    human_dir: Path,
    auth_store: AuthStore | None = None,
    trusted_origins: set[str] | None = None,
    cookie_secure: bool = False,
) -> AppServer:
    manager = ProjectManager(bank_dir, results_dir, projects_dir, human_dir)
    return AppServer(
        (host, port),
        web_dir,
        manager,
        auth_store=auth_store,
        trusted_origins=trusted_origins,
        cookie_secure=cookie_secure,
    )
