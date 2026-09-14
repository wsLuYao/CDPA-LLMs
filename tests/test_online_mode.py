from __future__ import annotations

import csv
import http.cookiejar
import json
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
import sqlite3


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.auth import AuthStore  # noqa: E402
from app.public_analysis import read_rows  # noqa: E402
from app.providers import ProviderConfig, _redact_secret  # noqa: E402
from app.web_server import build_server  # noqa: E402


class Client:
    def __init__(self, base: str) -> None:
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, path: str, payload: dict | None = None, csrf: str = "") -> tuple[int, dict, dict[str, str]]:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"}
        if csrf:
            headers["X-CSRF-Token"] = csrf
        request = urllib.request.Request(
            self.base + path,
            data=data,
            headers=headers,
            method="POST" if payload is not None else "GET",
        )
        try:
            response = self.opener.open(request, timeout=12)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            body = json.loads(response.read().decode("utf-8"))
            return response.status, body, dict(response.headers.items())


class OnlineModeTests(unittest.TestCase):
    def test_v1_frontend_has_unique_landmarks_onboarding_report_and_online_controls(self) -> None:
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        ids = re.findall(r'\bid="([^"]+)"', html)
        self.assertEqual(len(ids), len(set(ids)))
        for required in (
            "authGate", "loginForm", "registerForm", "appShell", "logoutButton", "view-report",
            "productTour", "tourSpotlight", "tourBubble", "tourReplayButton", "measurementStepper",
            "modelScorecardTable", "publicProfileHeatmap", "divergenceChart", "contextEffectsTable",
            "stabilityDetailTable", "optionDistributionChart", "publicSimilarityHeatmap", "humanGapSummary",
        ):
            self.assertIn(required, ids)
        css = (ROOT / "web" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("backdrop-filter", css)
        self.assertIn("Guided onboarding", css)
        self.assertNotIn("#07111f", css)
        advanced_css = (ROOT / "web" / "advanced" / "assets" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("Consumer-grade light skin", advanced_css)
        self.assertIn("backdrop-filter", advanced_css)
        self.assertNotIn("#07111f", advanced_css)
        self.assertNotIn("linear-gradient", advanced_css)
        self.assertNotIn("radial-gradient", advanced_css)
        script = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
        self.assertIn("TOUR_STEPS", script)
        self.assertIn("startTour", script)
        self.assertIn("cdpa_tour_seen_", script)
        self.assertIn("renderCrossModelReport", script)
        self.assertIn("renderPublicSimilarity", script)
        deployment_html = (ROOT / "web" / "deploy.html").read_text(encoding="utf-8")
        deployment_js = (ROOT / "web" / "deploy.js").read_text(encoding="utf-8")
        for required in ("step-server", "step-firewall", "step-dns", "step-connect", "step-docker", "step-launch", "step-verify"):
            self.assertIn(required, deployment_html)
        for port in ("22", "80", "443", "8765"):
            self.assertIn(port, deployment_html)
        self.assertIn("cdpa_deploy_progress", deployment_js)
        requested_order = [
            "Deepseek-v4-flash", "Doubao-2.0-pro", "Qwen-3.7-flash",
            "Gemini-3.7-flash", "GPT-5.6-sol", "Grok-4.6",
        ]
        self.assertEqual(sorted(requested_order, key=script.index), requested_order)
        advanced_order = (ROOT / "web" / "advanced" / "js" / "model-order.js").read_text(encoding="utf-8")
        self.assertEqual(sorted(requested_order, key=advanced_order.index), requested_order)

    def test_statistical_p_notation_keeps_leading_zero(self) -> None:
        missing_zero = re.compile(r"\bp\s*(?:<|>|=|≤|≥)\s*\.\d+", re.IGNORECASE)
        candidates = [
            *ROOT.glob("*.md"),
            *(ROOT / "web").rglob("*.html"),
            *(ROOT / "web").rglob("*.js"),
        ]
        violations = []
        for path in candidates:
            for match in missing_zero.finditer(path.read_text(encoding="utf-8")):
                violations.append(f"{path.relative_to(ROOT)}:{match.group(0)}")
        self.assertEqual(violations, [])

    def test_provider_secrets_are_not_serialized_or_echoed(self) -> None:
        config = ProviderConfig.from_dict({
            "provider": "custom",
            "api_key": "secret-key-123",
            "model": "test-model",
            "base_url": "https://example.com/v1",
            "extra_headers": {"X-Private": "secret-key-123"},
        })
        public = config.public_dict()
        self.assertNotIn("api_key", public)
        self.assertEqual(public["extra_headers"], {})
        self.assertEqual(_redact_secret({"message": "bad secret-key-123"}, config.api_key), {"message": "bad [REDACTED]"})

    def test_online_mode_blocks_private_api_endpoints(self) -> None:
        with patch.dict("os.environ", {"CDPA_ONLINE": "1"}):
            with self.assertRaisesRegex(ValueError, "不允许访问"):
                ProviderConfig.from_dict({
                    "provider": "custom",
                    "api_key": "secret-key-123",
                    "model": "internal",
                    "base_url": "https://127.0.0.1/v1",
                })

    def test_auth_database_connections_are_closed_after_use(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            auth = AuthStore(Path(temp) / "auth.sqlite3", registration_code="invite-2026")
            with auth._connect() as connection:
                connection.execute("SELECT 1").fetchone()
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute("SELECT 1")

    def test_auth_csrf_and_project_isolation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            banks = root / "banks"
            banks.mkdir()
            source = ROOT / "question_banks" / "risk_sample.csv"
            row = read_rows(source)[0]
            with (banks / source.name).open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(row))
                writer.writeheader()
                writer.writerow(row)

            auth = AuthStore(root / "auth.sqlite3", registration_code="invite-2026")
            server = build_server(
                "127.0.0.1",
                0,
                ROOT / "web",
                banks,
                root / "results",
                root / "projects",
                root / "human",
                auth_store=auth,
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                first = Client(base)
                status, body, headers = first.request("/api/projects")
                self.assertEqual(status, 401)
                self.assertEqual(body["code"], "AUTH_REQUIRED")
                self.assertEqual(headers.get("X-Frame-Options"), "DENY")

                status, body, _ = first.request("/api/auth/register", {
                    "email": "first@example.com",
                    "password": "strong-pass-123",
                    "registration_code": "invite-2026",
                })
                self.assertEqual(status, 201)
                csrf = body["csrf_token"]

                status, _, _ = first.request("/api/projects", {
                    "name": "应被CSRF阻止",
                    "mode": "demo",
                    "bank_ids": ["risk"],
                    "repetitions": 1,
                    "models": [{"provider": "demo", "model": "demo-deterministic-v1"}],
                })
                self.assertEqual(status, 401)

                payload = {
                    "name": "线上隔离验收",
                    "mode": "demo",
                    "bank_ids": ["risk"],
                    "repetitions": 1,
                    "models": [{"provider": "demo", "model": "demo-deterministic-v1", "label": "演示模型"}],
                    "run_options": {"delay_ms": 0, "concurrency": 2, "shuffle_items": False, "permutation_mode": "original"},
                }
                status, body, _ = first.request("/api/projects", payload, csrf)
                self.assertEqual(status, 202)
                project_id = body["project"]["project_id"]
                deadline = time.time() + 8
                project = body["project"]
                while project["status"] not in {"completed", "failed"} and time.time() < deadline:
                    time.sleep(.05)
                    _, result, _ = first.request(f"/api/projects/{project_id}")
                    project = result["project"]
                self.assertEqual(project["status"], "completed")

                second = Client(base)
                status, second_auth, _ = second.request("/api/auth/register", {
                    "email": "second@example.com",
                    "password": "another-pass-456",
                    "registration_code": "invite-2026",
                })
                self.assertEqual(status, 201)
                status, body, _ = second.request(f"/api/projects/{project_id}")
                self.assertEqual(status, 404)
                self.assertEqual(body["code"], "NOT_FOUND")
                status, body, _ = second.request("/api/projects")
                self.assertEqual(status, 200)
                self.assertEqual(body["projects"], [])
                self.assertTrue(second_auth["csrf_token"])
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
