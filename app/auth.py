from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
SESSION_SECONDS = 7 * 24 * 60 * 60


@dataclass(frozen=True)
class Session:
    user_id: str
    email: str
    csrf_token: str
    expires_at: int


class AuthError(ValueError):
    pass


class AuthStore:
    """Small, single-node authentication store for the self-hosted platform.

    Passwords are protected with scrypt and session tokens are stored only as
    SHA-256 digests. The plaintext token exists only in the secure browser
    cookie. SQLite WAL mode keeps this reliable for a modest single-VM launch.
    """

    def __init__(self, database_path: Path, registration_code: str = "") -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.registration_code = registration_code.strip()
        self._lock = threading.RLock()
        self._initialize()

    @property
    def registration_enabled(self) -> bool:
        return bool(self.registration_code)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=20)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA busy_timeout = 20000")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._lock, self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_login_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    csrf_token TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
                CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
                """
            )

    @staticmethod
    def _normalize_email(email: str) -> str:
        value = str(email or "").strip().lower()
        if len(value) > 254 or not EMAIL_RE.fullmatch(value):
            raise AuthError("请输入有效的邮箱地址")
        return value

    @staticmethod
    def _password_hash(password: str) -> str:
        value = str(password or "")
        if not 10 <= len(value) <= 128:
            raise AuthError("密码长度应为10—128个字符")
        salt = secrets.token_bytes(16)
        digest = hashlib.scrypt(value.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64)
        return f"scrypt$16384$8$1${salt.hex()}${digest.hex()}"

    @staticmethod
    def _password_matches(password: str, encoded: str) -> bool:
        try:
            scheme, n, r, p, salt_hex, digest_hex = encoded.split("$", 5)
            if scheme != "scrypt":
                return False
            digest = hashlib.scrypt(
                str(password or "").encode("utf-8"),
                salt=bytes.fromhex(salt_hex),
                n=int(n),
                r=int(r),
                p=int(p),
                dklen=len(bytes.fromhex(digest_hex)),
            )
            return hmac.compare_digest(digest.hex(), digest_hex)
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def register(self, email: str, password: str, registration_code: str) -> dict[str, str]:
        if not self.registration_enabled:
            raise AuthError("当前站点未开放新账号注册")
        supplied = str(registration_code or "")
        if not hmac.compare_digest(supplied.encode("utf-8"), self.registration_code.encode("utf-8")):
            raise AuthError("注册邀请码不正确")
        normalized = self._normalize_email(email)
        encoded = self._password_hash(password)
        user_id = f"user_{uuid.uuid4().hex}"
        now = int(time.time())
        try:
            with self._lock, self._connect() as connection:
                connection.execute(
                    "INSERT INTO users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (user_id, normalized, encoded, now),
                )
        except sqlite3.IntegrityError as exc:
            raise AuthError("该邮箱已经注册") from exc
        return {"id": user_id, "email": normalized}

    def authenticate(self, email: str, password: str) -> dict[str, str]:
        normalized = self._normalize_email(email)
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT id, email, password_hash FROM users WHERE email = ? COLLATE NOCASE",
                (normalized,),
            ).fetchone()
            if not row or not self._password_matches(password, row["password_hash"]):
                raise AuthError("邮箱或密码不正确")
            connection.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (int(time.time()), row["id"]))
            return {"id": row["id"], "email": row["email"]}

    def create_session(self, user_id: str) -> tuple[str, Session]:
        token = secrets.token_urlsafe(40)
        csrf_token = secrets.token_urlsafe(32)
        now = int(time.time())
        expires_at = now + SESSION_SECONDS
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                raise AuthError("账号不存在")
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            connection.execute(
                "INSERT INTO sessions(token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
                (self._token_hash(token), user_id, csrf_token, now, expires_at, now),
            )
        return token, Session(user_id=user_id, email=row["email"], csrf_token=csrf_token, expires_at=expires_at)

    def read_session(self, token: str) -> Session | None:
        if not token:
            return None
        now = int(time.time())
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT sessions.user_id, sessions.csrf_token, sessions.expires_at, users.email
                FROM sessions JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ?
                """,
                (self._token_hash(token), now),
            ).fetchone()
            if not row:
                return None
            connection.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
                (now, self._token_hash(token)),
            )
            return Session(
                user_id=row["user_id"],
                email=row["email"],
                csrf_token=row["csrf_token"],
                expires_at=int(row["expires_at"]),
            )

    def destroy_session(self, token: str) -> None:
        if not token:
            return
        with self._lock, self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (self._token_hash(token),))
