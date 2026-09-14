from __future__ import annotations

import csv
import json
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.project_manager import ProjectManager  # noqa: E402
from app.model_order import PREFERRED_MODEL_ORDER, model_sort_key  # noqa: E402
from app.public_analysis import BANK_META, read_rows  # noqa: E402
from app.runner import RunManager  # noqa: E402
from app.web_server import build_server  # noqa: E402


def request_json(url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


class PlatformTests(unittest.TestCase):
    def test_requested_model_display_order_is_stable(self) -> None:
        values = [
            {"label": "其他模型", "model": "other-model"},
            *({"label": value.upper(), "model": value} for value in reversed(PREFERRED_MODEL_ORDER)),
        ]
        ordered = sorted(values, key=model_sort_key)
        self.assertEqual([row["model"] for row in ordered[:6]], list(PREFERRED_MODEL_ORDER))
        self.assertEqual(ordered[-1]["model"], "other-model")

    def test_project_and_public_report_follow_model_order_even_with_custom_labels(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            banks, results, projects, human = (root / name for name in ("banks", "results", "projects", "human"))
            banks.mkdir()
            source = ROOT / "question_banks" / "risk_sample.csv"
            first = read_rows(source)[0]
            tiny = banks / source.name
            with tiny.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(first))
                writer.writeheader()
                writer.writerow(first)

            labels = ["Zulu", "Yankee", "Xray", "Whiskey", "Victor", "Uniform"]
            configured = [
                {"provider": "demo", "model": model, "label": label}
                for model, label in reversed(list(zip(PREFERRED_MODEL_ORDER, labels)))
            ]
            manager = ProjectManager(banks, results, projects, human)
            project = manager.create_project({
                "name": "模型排序验收", "mode": "demo", "bank_ids": ["risk"], "repetitions": 1,
                "models": configured,
                "run_options": {"concurrency": 2, "delay_ms": 0, "shuffle_items": False, "permutation_mode": "original"},
            })
            deadline = time.time() + 10
            while project["status"] not in {"completed", "failed", "completed_with_issues"} and time.time() < deadline:
                time.sleep(0.05)
                project = manager.get_project(project["project_id"])
            self.assertEqual(project["status"], "completed")
            self.assertEqual([row["model"] for row in project["models"]], list(PREFERRED_MODEL_ORDER))
            analysis = manager.analysis(project["project_id"])
            self.assertEqual(analysis["models"], labels)
            self.assertEqual(list(dict.fromkeys(row["model"] for row in analysis["profiles"])), labels)
            for key in ("model_quality", "model_scorecards", "stability_details", "option_distributions"):
                self.assertEqual(list(dict.fromkeys(row["model"] for row in analysis[key])), labels)
            self.assertEqual([row["model"] for row in analysis["category_divergence"][0]["model_values"]], labels)
            self.assertEqual(
                list(dict.fromkeys(row["model_a"] for row in analysis["model_similarity"])),
                labels,
            )

    def test_open_source_sample_catalog_covers_all_four_domains(self) -> None:
        expected_files = {
            "risk": "risk_sample.csv",
            "ambiguity": "ambiguity_sample.csv",
            "intertemporal": "intertemporal_sample.csv",
            "moral_cni": "cni_sample.csv",
        }
        self.assertEqual(set(BANK_META), set(expected_files))
        for bank, filename in expected_files.items():
            rows = read_rows(ROOT / "question_banks" / filename)
            self.assertGreaterEqual(len(rows), 3, bank)
            self.assertTrue(all(row.get("ItemVersion") == "oss-demo-1" for row in rows))

    def test_demo_project_runs_and_generates_public_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            banks, results, projects, human = (root / name for name in ("banks", "results", "projects", "human"))
            banks.mkdir()
            source = ROOT / "question_banks" / "risk_sample.csv"
            first = read_rows(source)[0]
            headers = list(first)
            tiny = banks / source.name
            with tiny.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=headers)
                writer.writeheader()
                writer.writerow(first)
            manager = ProjectManager(banks, results, projects, human)
            project = manager.create_project({
                "name": "自动验收",
                "mode": "demo",
                "bank_ids": ["risk"],
                "repetitions": 2,
                "models": [{"provider": "demo", "model": "demo-deterministic-v1", "label": "演示模型"}],
                "run_options": {"concurrency": 2, "delay_ms": 0, "shuffle_items": False, "permutation_mode": "original"},
            })
            deadline = time.time() + 10
            while project["status"] not in {"completed", "failed", "completed_with_issues"} and time.time() < deadline:
                time.sleep(0.05)
                project = manager.get_project(project["project_id"])
            self.assertEqual(project["status"], "completed")
            self.assertTrue((projects / project["project_id"] / "通俗报告数据.json").is_file())
            self.assertEqual(project["models"][0]["total"], 2)
            self.assertEqual(project["calls_per_model"], 2)
            self.assertEqual(project["models"][0]["valid"], 2)
            analysis = manager.analysis(project["project_id"])
            self.assertEqual(analysis["quality"]["total_records"], 2)
            self.assertEqual(analysis["models"], ["演示模型"])
            self.assertTrue(analysis["profiles"])
            for key in (
                "model_quality", "model_scorecards", "stability_details", "option_distributions",
                "model_similarity", "human_gap_summary", "report_findings", "report_method",
            ):
                self.assertIn(key, analysis)
            self.assertEqual(analysis["analysis_version"], "PUBLIC_REPORT_V2")
            self.assertIn("p < 0.05", analysis["report_method"]["p_value_format"])
            archive = manager.zip_project(project["project_id"])
            self.assertTrue(archive.is_file())

    def test_cancelled_run_resumes_without_repeating_committed_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            banks, results = root / "banks", root / "results"
            banks.mkdir()
            source = ROOT / "question_banks" / "risk_sample.csv"
            rows = read_rows(source)[:8]
            expected_total = len(rows) * 2
            tiny = banks / source.name
            with tiny.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
            provider = {"provider": "demo", "model": "demo-deterministic-v1"}
            manager = RunManager(banks, results)
            run = manager.start_run({
                "files": [tiny.name],
                "provider_config": provider,
                "run_options": {"repetitions": 2, "concurrency": 1, "delay_ms": 40, "shuffle_items": False, "permutation_mode": "original"},
            })
            deadline = time.time() + 5
            while manager.get_run(run["run_id"])["completed"] < 3 and time.time() < deadline:
                time.sleep(0.02)
            manager.cancel(run["run_id"])
            while manager.get_run(run["run_id"])["status"] != "cancelled" and time.time() < deadline:
                time.sleep(0.02)
            committed = manager.get_run(run["run_id"])["completed"]
            self.assertGreaterEqual(committed, 3)
            restarted = RunManager(banks, results)
            restarted.resume_run(run["run_id"], provider)
            deadline = time.time() + 8
            while restarted.get_run(run["run_id"])["status"] not in {"completed", "failed"} and time.time() < deadline:
                time.sleep(0.03)
            resumed = restarted.get_run(run["run_id"])
            self.assertEqual(resumed["status"], "completed")
            self.assertEqual(resumed["completed"], expected_total)
            complete_rows = read_rows(results / run["run_id"] / "完整运行记录.csv")
            indexes = [row["TaskIndex"] for row in complete_rows]
            self.assertEqual(len(indexes), expected_total)
            self.assertEqual(len(set(indexes)), expected_total)

    def test_http_health_and_static_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            banks = root / "banks"
            banks.mkdir()
            source = ROOT / "question_banks" / "cni_sample.csv"
            target = banks / source.name
            target.write_bytes(source.read_bytes())
            server = build_server("127.0.0.1", 0, ROOT / "web", banks, root / "results", root / "projects", root / "human")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_address[1]}"
                health = request_json(base + "/api/health")
                self.assertTrue(health["ok"])
                self.assertTrue(health["local_only"])
                self.assertEqual(health["version"], "V1.0")
                with urllib.request.urlopen(base + "/", timeout=5) as response:
                    html = response.read().decode("utf-8")
                self.assertIn("AI决策偏好测评平台", html)
                self.assertIn("新建测评", html)
                with urllib.request.urlopen(base + "/deploy.html", timeout=5) as response:
                    deployment = response.read().decode("utf-8")
                self.assertIn("服务器部署向导", deployment)
                self.assertIn("./scripts/doctor.sh", deployment)
                with urllib.request.urlopen(base + "/deploy.js", timeout=5) as response:
                    self.assertIn(b"cdpa_deploy_progress", response.read())
                created = request_json(base + "/api/projects", {
                    "name": "HTTP端到端验收",
                    "mode": "demo",
                    "bank_ids": ["moral_cni"],
                    "repetitions": 1,
                    "models": [{"provider": "demo", "model": "demo-deterministic-v1", "label": "演示模型"}],
                    "run_options": {"concurrency": 8, "delay_ms": 0, "permutation_mode": "random", "shuffle_items": True},
                })
                project_id = created["project"]["project_id"]
                deadline = time.time() + 15
                project = created["project"]
                while project["status"] not in {"completed", "failed", "completed_with_issues"} and time.time() < deadline:
                    time.sleep(0.1)
                    project = request_json(base + f"/api/projects/{project_id}")["project"]
                self.assertEqual(project["status"], "completed")
                self.assertEqual(project["models"][0]["total"], 3)
                report = request_json(base + f"/api/projects/{project_id}/analysis")["analysis"]
                self.assertEqual(report["quality"]["total_records"], 3)
                self.assertTrue(report["profiles"])
                advanced = request_json(base + f"/api/projects/{project_id}/advanced-files")
                self.assertEqual(len(advanced["runs"]), 1)
                for key in ("ranking_url", "complete_url"):
                    with urllib.request.urlopen(base + advanced["runs"][0][key], timeout=5) as response:
                        self.assertGreater(len(response.read()), 100)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
