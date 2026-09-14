from __future__ import annotations

import csv
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IGNORED_PARTS = {".git", ".ruff_cache", "__pycache__"}


def repository_files() -> list[Path]:
    return [
        path
        for path in ROOT.rglob("*")
        if path.is_file() and not any(part in IGNORED_PARTS for part in path.relative_to(ROOT).parts)
    ]


class OpenSourceDistributionTests(unittest.TestCase):
    def test_private_and_application_artifacts_are_not_distributed(self) -> None:
        forbidden_suffixes = {
            ".7z", ".bak", ".doc", ".docm", ".docx", ".gz", ".jsonl", ".pdf",
            ".ppt", ".pptm", ".pptx", ".rar", ".sqlite", ".sqlite3", ".tar",
            ".xls", ".xlsm", ".xlsx", ".zip",
        }
        violations = [
            path.relative_to(ROOT).as_posix()
            for path in repository_files()
            if path.suffix.lower() in forbidden_suffixes
        ]
        self.assertEqual(violations, [])
        self.assertFalse((ROOT / ".env").exists())

    def test_only_documented_synthetic_csv_files_are_distributed(self) -> None:
        names = {"ambiguity_sample.csv", "cni_sample.csv", "intertemporal_sample.csv", "risk_sample.csv"}
        expected = {
            *(f"question_banks/{name}" for name in names),
            *(f"web/advanced/data_banks/{name}" for name in names),
        }
        actual = {
            path.relative_to(ROOT).as_posix()
            for path in repository_files()
            if path.suffix.lower() == ".csv"
        }
        self.assertEqual(actual, expected)
        for name in names:
            with (ROOT / "question_banks" / name).open("r", encoding="utf-8-sig", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 3, name)
            self.assertTrue(all(row.get("ItemVersion") == "oss-demo-1" for row in rows), name)
            self.assertTrue(all("DEMO" in row.get("ItemID", "") for row in rows), name)

    def test_runtime_and_human_reference_directories_are_empty_placeholders(self) -> None:
        for directory in (ROOT / "projects", ROOT / "results"):
            self.assertEqual([path.name for path in directory.iterdir()], [".gitkeep"])

        public_reference = ROOT / "web" / "advanced" / "human_reference"
        manifest = json.loads((public_reference / "human_reference_manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest.get("files"), [])
        self.assertTrue(manifest.get("public_release"))
        for name in ("risk_human_reference_v1.json", "cni_human_reference_v1.json"):
            self.assertIsNone(json.loads((public_reference / name).read_text(encoding="utf-8")))

    def test_no_common_secret_material_is_present(self) -> None:
        patterns = {
            "OpenAI-style API key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
            "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
            "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
            "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
            "bearer token": re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}", re.IGNORECASE),
        }
        violations: list[str] = []
        text_suffixes = {".css", ".html", ".js", ".json", ".md", ".py", ".sh", ".svg", ".toml", ".yaml", ".yml"}
        for path in repository_files():
            if path.suffix.lower() not in text_suffixes and path.name not in {"Caddyfile", "Dockerfile"}:
                continue
            text = path.read_text(encoding="utf-8")
            for label, pattern in patterns.items():
                if pattern.search(text):
                    violations.append(f"{path.relative_to(ROOT).as_posix()}: {label}")
        self.assertEqual(violations, [])

    def test_advanced_ui_uses_the_same_synthetic_banks(self) -> None:
        source = ROOT / "question_banks"
        bundled = ROOT / "web" / "advanced" / "data_banks"
        names = sorted(path.name for path in source.glob("*.csv"))
        self.assertEqual(names, sorted(path.name for path in bundled.glob("*.csv")))
        for name in names:
            self.assertEqual((source / name).read_bytes(), (bundled / name).read_bytes())

    def test_local_markdown_links_resolve(self) -> None:
        documents = [ROOT / "README.md", ROOT / "README.en.md", *sorted((ROOT / "docs").glob("*.md"))]
        broken = []
        pattern = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
        for document in documents:
            for target in pattern.findall(document.read_text(encoding="utf-8")):
                clean = target.split("#", 1)[0].strip()
                if not clean or "://" in clean or clean.startswith("mailto:"):
                    continue
                path = (document.parent / clean).resolve()
                if not path.exists():
                    broken.append(f"{document.relative_to(ROOT)} -> {target}")
        self.assertEqual(broken, [])


if __name__ == "__main__":
    unittest.main()
