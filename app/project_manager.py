from __future__ import annotations

import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from .model_order import model_sort_key
from .public_analysis import BANK_META, analyze_project, bank_id, read_rows
from .providers import ProviderConfig
from .runner import RunManager, atomic_json, iso_now, safe_slug


PROJECT_RE = re.compile(r"^project_[A-Za-z0-9._-]+$")


class ProjectManager:
    def __init__(
        self,
        bank_dir: Path,
        results_dir: Path,
        projects_dir: Path,
        human_dir: Path,
    ) -> None:
        self.bank_dir = bank_dir
        self.results_dir = results_dir
        self.projects_dir = projects_dir
        self.human_dir = human_dir
        for directory in (bank_dir, results_dir, projects_dir, human_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self.runs = RunManager(bank_dir, results_dir)
        self._lock = threading.RLock()
        self._projects: dict[str, dict[str, Any]] = {}
        self._secrets: dict[str, dict[str, dict[str, Any]]] = {}
        self._threads: dict[str, threading.Thread] = {}
        max_active = max(1, min(8, int(os.environ.get("CDPA_MAX_ACTIVE_PROJECTS", "2"))))
        self._project_slots = threading.Semaphore(max_active)
        self._bank_files = self._discover_banks()
        self._load_projects()

    def _discover_banks(self) -> dict[str, str]:
        mapping: dict[str, str] = {}
        for report in self.runs.banks():
            identity = bank_id(report.get("filename", ""))
            if identity in BANK_META and report.get("valid"):
                mapping[identity] = report["filename"]
        return mapping

    def _folder(self, project_id: str) -> Path:
        if not PROJECT_RE.fullmatch(project_id):
            raise KeyError("未找到该测评项目")
        folder = (self.projects_dir / project_id).resolve()
        if folder.parent != self.projects_dir.resolve():
            raise KeyError("未找到该测评项目")
        return folder

    def _manifest_path(self, project_id: str) -> Path:
        return self._folder(project_id) / "项目摘要.json"

    def _load_projects(self) -> None:
        for path in self.projects_dir.glob("project_*/项目摘要.json"):
            try:
                project = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            project["models"] = sorted(project.get("models", []), key=model_sort_key)
            if project.get("status") in {"queued", "running", "paused"}:
                project["status"] = "interrupted"
                project["status_label"] = "上次运行已中断，可重新填写API Key后继续"
                for model in project.get("models", []):
                    if model.get("status") in {"queued", "running", "paused"}:
                        model["status"] = "interrupted"
                project["updated_at"] = iso_now()
                atomic_json(path, project)
            self._projects[project["project_id"]] = project

    def _save(self, project: dict[str, Any]) -> None:
        project["updated_at"] = iso_now()
        folder = self._folder(project["project_id"])
        folder.mkdir(parents=True, exist_ok=True)
        atomic_json(folder / "项目摘要.json", project)

    def banks(self) -> list[dict[str, Any]]:
        reports = {bank_id(row.get("filename", "")): row for row in self.runs.banks()}
        result = []
        for identity, meta in BANK_META.items():
            row = reports.get(identity, {})
            result.append({
                "bank_id": identity,
                "label": meta["label"],
                "short": meta["short"],
                "color": meta["color"],
                "row_count": int(row.get("row_count") or meta["rows"]),
                "filename": row.get("filename") or self._bank_files.get(identity, ""),
                "valid": bool(row.get("valid")),
                "warnings": row.get("warnings") or [],
            })
        return result

    def create_project(self, payload: dict[str, Any], owner_id: str = "local") -> dict[str, Any]:
        active_states = {"queued", "running", "paused"}
        active_for_owner = sum(
            project.get("owner_id", "local") == owner_id and project.get("status") in active_states
            for project in self._projects.values()
        )
        max_per_user = max(1, min(6, int(os.environ.get("CDPA_MAX_ACTIVE_PER_USER", "2"))))
        if active_for_owner >= max_per_user:
            raise ValueError(f"每个账号最多同时运行{max_per_user}个测评项目，请等待当前任务完成或先安全停止")
        name = str(payload.get("name") or "未命名测评").strip()[:80]
        mode = str(payload.get("mode") or "full")
        bank_ids = [str(value) for value in (payload.get("bank_ids") or [])]
        if not bank_ids:
            bank_ids = list(BANK_META)
        if len(bank_ids) != len(set(bank_ids)) or any(value not in self._bank_files for value in bank_ids):
            raise ValueError("测评内容选择不合法")
        models_payload = payload.get("models") or []
        if not isinstance(models_payload, list) or not 1 <= len(models_payload) <= 6:
            raise ValueError("请添加1—6个模型")
        repetitions = int(payload.get("repetitions") or (1 if mode == "demo" else 5))
        if not 1 <= repetitions <= 20:
            raise ValueError("重复次数应在1—20之间")

        run_options = dict(payload.get("run_options") or {})
        run_options["repetitions"] = repetitions
        run_options.setdefault("permutation_mode", "random")
        run_options.setdefault("shuffle_items", True)
        run_options.setdefault("random_seed", 20260829)
        run_options.setdefault("concurrency", 2)
        run_options.setdefault("delay_ms", 250)
        run_options.setdefault("technical_retries", 2)
        run_options.setdefault("format_repair", True)

        models: list[dict[str, Any]] = []
        secrets: dict[str, dict[str, Any]] = {}
        for index, raw in enumerate(models_payload, start=1):
            provider = ProviderConfig.from_dict(raw)
            model_id = f"model_{index}_{uuid.uuid4().hex[:6]}"
            label = str(raw.get("label") or provider.model or f"模型{index}").strip()[:60]
            models.append({
                "model_id": model_id,
                "label": label,
                "provider": provider.provider,
                "model": provider.model,
                "config": provider.public_dict(),
                "status": "queued",
                "run_id": "",
                "error": "",
            })
            secrets[model_id] = dict(raw)
        models.sort(key=model_sort_key)

        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        project_id = f"project_{stamp}_{safe_slug(name)}_{uuid.uuid4().hex[:6]}"
        available_counts = {
            bank_id(report.get("filename", "")): int(report.get("row_count") or 0)
            for report in self.runs.banks()
            if report.get("valid")
        }
        calls_per_model = sum(available_counts[value] for value in bank_ids) * repetitions
        if run_options.get("permutation_mode") == "balanced6":
            calls_per_model *= 6
        project = {
            "project_id": project_id,
            "owner_id": owner_id,
            "name": name,
            "mode": mode,
            "bank_ids": bank_ids,
            "bank_files": [self._bank_files[value] for value in bank_ids],
            "repetitions": repetitions,
            "run_options": run_options,
            "models": models,
            "status": "queued",
            "status_label": "等待启动",
            "created_at": iso_now(),
            "updated_at": iso_now(),
            "calls_per_model": calls_per_model,
            "estimated_calls": calls_per_model * len(models),
            "active_model_id": "",
            "imported": False,
        }
        with self._lock:
            current_active = sum(
                item.get("owner_id", "local") == owner_id and item.get("status") in active_states
                for item in self._projects.values()
            )
            if current_active >= max_per_user:
                raise ValueError(f"每个账号最多同时运行{max_per_user}个测评项目，请等待当前任务完成或先安全停止")
            self._projects[project_id] = project
            self._secrets[project_id] = secrets
            self._save(project)
            self._start_coordinator(project_id)
        return self.get_project(project_id, owner_id)

    def _start_coordinator(self, project_id: str) -> None:
        current = self._threads.get(project_id)
        if current and current.is_alive():
            return
        thread = threading.Thread(target=self._coordinate, args=(project_id,), name=f"project-{project_id}", daemon=True)
        self._threads[project_id] = thread
        thread.start()

    def _coordinate(self, project_id: str) -> None:
        while self._projects.get(project_id, {}).get("status") == "paused":
            time.sleep(0.4)
        with self._project_slots:
            if self._projects.get(project_id, {}).get("status") == "cancelled":
                return
            self._coordinate_inner(project_id)

    def _coordinate_inner(self, project_id: str) -> None:
        project = self._projects[project_id]
        project["status"] = "running"
        project["status_label"] = "正在施测"
        self._save(project)
        secrets = self._secrets.get(project_id, {})
        failures = 0
        for model in project.get("models", []):
            if model.get("status") == "completed":
                continue
            if project.get("status") == "cancelled":
                break
            config = secrets.get(model["model_id"])
            if not config:
                model["status"] = "interrupted"
                project["status"] = "interrupted"
                project["status_label"] = "需要重新填写API Key后继续"
                self._save(project)
                return
            project["active_model_id"] = model["model_id"]
            model["status"] = "running"
            self._save(project)
            try:
                if model.get("run_id"):
                    run = self.runs.resume_run(model["run_id"], config)
                else:
                    run = self.runs.start_run({
                        "files": project["bank_files"],
                        "provider_config": config,
                        "run_options": project["run_options"],
                    })
                    model["run_id"] = run["run_id"]
                    self._save(project)
            except Exception as exc:
                model["status"] = "failed"
                model["error"] = str(exc)[:1000]
                failures += 1
                self._save(project)
                continue

            while True:
                run = self.runs.get_run(model["run_id"])
                model["run_status"] = run.get("status")
                model["completed"] = run.get("completed", 0)
                model["total"] = run.get("total", 0)
                model["valid"] = run.get("valid", 0)
                model["repaired_valid"] = run.get("repaired_valid", 0)
                model["tech_error"] = run.get("tech_error", 0)
                self._save(project)
                if run.get("status") in {"completed", "cancelled", "failed"}:
                    break
                time.sleep(0.6)
            if run.get("status") == "completed":
                model["status"] = "completed"
            elif project.get("status") == "cancelled":
                model["status"] = "cancelled"
                break
            else:
                model["status"] = "failed" if run.get("status") == "failed" else "interrupted"
                model["error"] = str(run.get("error") or "运行未完成")
                failures += 1
            self._save(project)

        project["active_model_id"] = ""
        final_status = project.get("status", "failed")
        final_label = project.get("status_label", "测评未完成")
        if project.get("status") != "cancelled":
            completed = sum(model.get("status") == "completed" for model in project.get("models", []))
            if completed == len(project.get("models", [])):
                final_status = "completed"
                final_label = "测评与分析已完成"
            elif completed:
                final_status = "completed_with_issues"
                final_label = "部分模型已完成，请查看详情"
            else:
                final_status = "failed"
                final_label = "测评未完成"
            project["status"] = "analyzing"
            project["status_label"] = "正在生成分析报告"
            self._save(project)
        if any(model.get("run_id") for model in project.get("models", [])):
            try:
                analysis = self.analysis(project_id)
                atomic_json(self._folder(project_id) / "通俗报告数据.json", analysis)
            except Exception:
                pass
        project["status"] = final_status
        project["status_label"] = final_label
        self._save(project)

    def _public_project(self, project: dict[str, Any]) -> dict[str, Any]:
        result = json.loads(json.dumps(project, ensure_ascii=False))
        result.pop("owner_id", None)
        result["models"] = sorted(result.get("models", []), key=model_sort_key)
        total = sum(int(model.get("total") or project.get("calls_per_model") or 0) for model in result.get("models", []))
        completed = sum(int(model.get("completed") or 0) for model in result.get("models", []))
        result["total"] = total
        result["completed"] = completed
        result["progress"] = round(completed / total * 100, 1) if total else 0
        return result

    @staticmethod
    def _assert_owner(project: dict[str, Any], owner_id: str | None) -> None:
        if owner_id is not None and project.get("owner_id", "local") != owner_id:
            raise KeyError("未找到该测评项目")

    def _owned_project(self, project_id: str, owner_id: str | None) -> dict[str, Any]:
        project = self._projects.get(project_id)
        if not project:
            path = self._manifest_path(project_id)
            if not path.is_file():
                raise KeyError("未找到该测评项目")
            project = json.loads(path.read_text(encoding="utf-8"))
            self._projects[project_id] = project
        self._assert_owner(project, owner_id)
        return project

    def get_project(self, project_id: str, owner_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            project = self._owned_project(project_id, owner_id)
            for model in project.get("models", []):
                run_id = model.get("run_id")
                if run_id:
                    try:
                        run = self.runs.get_run(run_id)
                    except KeyError:
                        continue
                    model["run_status"] = run.get("status")
                    model["completed"] = run.get("completed", 0)
                    model["total"] = run.get("total", 0)
                    model["valid"] = run.get("valid", 0)
                    model["repaired_valid"] = run.get("repaired_valid", 0)
                    model["tech_error"] = run.get("tech_error", 0)
                    model["recent_results"] = run.get("recent_results", [])
            return self._public_project(project)

    def list_projects(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        rows = []
        for project_id in list(self._projects):
            try:
                rows.append(self.get_project(project_id, owner_id))
            except KeyError:
                continue
        return sorted(rows, key=lambda row: row.get("created_at", ""), reverse=True)[:50]

    def pause_project(self, project_id: str, owner_id: str | None = None) -> dict[str, Any]:
        project = self._owned_project(project_id, owner_id)
        active = next((model for model in project.get("models", []) if model.get("model_id") == project.get("active_model_id")), None)
        if active and active.get("run_id"):
            self.runs.pause(active["run_id"])
            active["status"] = "paused"
        project["status"] = "paused"
        project["status_label"] = "已暂停，不会发起新请求"
        self._save(project)
        return self.get_project(project_id, owner_id)

    def continue_project(self, project_id: str, owner_id: str | None = None) -> dict[str, Any]:
        project = self._owned_project(project_id, owner_id)
        active = next((model for model in project.get("models", []) if model.get("model_id") == project.get("active_model_id")), None)
        if active and active.get("run_id") and active.get("status") == "paused":
            self.runs.continue_run(active["run_id"])
            active["status"] = "running"
            project["status"] = "running"
            project["status_label"] = "正在施测"
            self._save(project)
            return self.get_project(project_id, owner_id)
        if project.get("status") == "paused" and not active:
            project["status"] = "queued"
            project["status_label"] = "等待运行资源"
            self._save(project)
            self._start_coordinator(project_id)
            return self.get_project(project_id, owner_id)
        raise ValueError("该项目需要使用“中断后恢复”并重新填写API Key")

    def resume_project(self, project_id: str, models_payload: list[dict[str, Any]], owner_id: str | None = None) -> dict[str, Any]:
        project = self._owned_project(project_id, owner_id)
        supplied: dict[str, dict[str, Any]] = {}
        for raw in models_payload:
            model_id = str(raw.get("model_id") or "")
            if not model_id:
                continue
            provider = ProviderConfig.from_dict(raw)
            target = next((model for model in project.get("models", []) if model.get("model_id") == model_id), None)
            if not target:
                raise ValueError("恢复配置包含未知模型")
            if provider.provider != target.get("provider") or provider.model != target.get("model"):
                raise ValueError(f"{target.get('label')}的厂商或模型ID与原测评不一致")
            supplied[model_id] = dict(raw)
        unfinished = [model for model in project.get("models", []) if model.get("status") != "completed"]
        if any(model["model_id"] not in supplied for model in unfinished):
            raise ValueError("请为所有未完成模型重新填写API Key")
        self._secrets[project_id] = supplied
        for model in unfinished:
            model["status"] = "queued"
            model["error"] = ""
        project["status"] = "queued"
        project["status_label"] = "准备恢复"
        self._save(project)
        self._start_coordinator(project_id)
        return self.get_project(project_id, owner_id)

    def cancel_project(self, project_id: str, owner_id: str | None = None) -> dict[str, Any]:
        project = self._owned_project(project_id, owner_id)
        project["status"] = "cancelled"
        project["status_label"] = "已安全停止，可稍后恢复"
        active = next((model for model in project.get("models", []) if model.get("model_id") == project.get("active_model_id")), None)
        if active and active.get("run_id"):
            try:
                self.runs.cancel(active["run_id"])
            except KeyError:
                pass
        self._save(project)
        return self.get_project(project_id, owner_id)

    def analysis(self, project_id: str, owner_id: str | None = None) -> dict[str, Any]:
        project = self.get_project(project_id, owner_id)
        folders = [self.results_dir / model["run_id"] for model in project.get("models", []) if model.get("run_id")]
        if not folders:
            raise ValueError("项目还没有可分析的运行结果")
        return analyze_project(project, folders, self.human_dir)

    def advanced_files(self, project_id: str, owner_id: str | None = None) -> dict[str, Any]:
        project = self.get_project(project_id, owner_id)
        runs = []
        for model in project.get("models", []):
            run_id = model.get("run_id")
            if not run_id:
                continue
            folder = self.results_dir / run_id
            if (folder / "排序结果.csv").is_file() and (folder / "完整运行记录.csv").is_file():
                runs.append({
                    "run_id": run_id,
                    "label": model.get("label") or model.get("model"),
                    "ranking_url": f"/api/runs/{run_id}/download/%E6%8E%92%E5%BA%8F%E7%BB%93%E6%9E%9C.csv?inline=1",
                    "complete_url": f"/api/runs/{run_id}/download/%E5%AE%8C%E6%95%B4%E8%BF%90%E8%A1%8C%E8%AE%B0%E5%BD%95.csv?inline=1",
                })
        return {"project_id": project_id, "project_name": project.get("name"), "runs": runs}

    def import_project(self, payload: dict[str, Any], owner_id: str = "local") -> dict[str, Any]:
        name = str(payload.get("name") or "导入的历史测评").strip()[:80]
        batches = payload.get("batches") or []
        if not isinstance(batches, list) or not batches:
            raise ValueError("没有识别到可导入的结果批次")
        if len(batches) > 12:
            raise ValueError("一次最多导入12个结果批次")
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        project_id = f"project_{stamp}_{safe_slug(name)}_{uuid.uuid4().hex[:6]}"
        models = []
        found_banks: list[str] = []
        max_repeat = 1
        for index, batch in enumerate(batches, start=1):
            ranking_text = str(batch.get("ranking") or "")
            complete_text = str(batch.get("complete") or "")
            if not ranking_text or not complete_text:
                raise ValueError(f"第{index}个批次缺少排序结果或完整运行记录")
            run_id = f"run_imported_{stamp}_{index}_{uuid.uuid4().hex[:5]}"
            folder = self.results_dir / run_id
            folder.mkdir(parents=True, exist_ok=False)
            (folder / "排序结果.csv").write_text(ranking_text.lstrip("\ufeff"), encoding="utf-8-sig")
            (folder / "完整运行记录.csv").write_text(complete_text.lstrip("\ufeff"), encoding="utf-8-sig")
            rows = read_rows(folder / "完整运行记录.csv")
            if not rows:
                raise ValueError(f"第{index}个完整运行记录没有数据")
            first = rows[0]
            for row in rows:
                identity = bank_id(row.get("SourceFile", ""))
                if identity in BANK_META and identity not in found_banks:
                    found_banks.append(identity)
                try:
                    max_repeat = max(max_repeat, int(row.get("RepeatIndex") or 1))
                except ValueError:
                    pass
            valid = sum(row.get("FinalStatus") in {"VALID", "REPAIRED_VALID"} for row in rows)
            repaired = sum(row.get("FinalStatus") == "REPAIRED_VALID" for row in rows)
            config = {
                "provider": first.get("Provider", "imported"), "model": first.get("Model", "历史模型"),
                "base_url": "", "api_mode": first.get("ApiMode", ""),
                "temperature": first.get("Temperature", ""), "top_p": first.get("TopP", ""),
                "seed": first.get("Seed", ""), "max_output_tokens": first.get("MaxOutputTokens", ""),
                "send_sampling": first.get("SamplingSent", ""),
            }
            summary = {
                "run_id": run_id, "status": "completed", "files": list(dict.fromkeys(row.get("SourceFile", "") for row in rows)),
                "total": len(rows), "completed": len(rows), "progress": 100,
                "valid": valid, "repaired_valid": repaired,
                "invalid": len(rows) - valid, "tech_error": 0,
                "config": config, "options": {"repetitions": max_repeat},
                "model_config_id": first.get("ModelConfigID", f"IMPORTED-{index}"),
                "created_at": first.get("Timestamp", iso_now()), "started_at": "", "finished_at": iso_now(),
                "error": "", "cancel_requested": False, "pause_requested": False, "recent_results": [],
                "output_folder": run_id,
            }
            atomic_json(folder / "运行摘要.json", summary)
            models.append({
                "model_id": f"model_{index}_{uuid.uuid4().hex[:6]}",
                "label": str(batch.get("label") or first.get("Model") or f"历史模型{index}"),
                "provider": first.get("Provider", "imported"), "model": first.get("Model", "历史模型"),
                "config": config, "status": "completed", "run_id": run_id,
                "completed": len(rows), "total": len(rows), "valid": valid,
                "repaired_valid": repaired, "tech_error": 0, "error": "",
            })
        models.sort(key=model_sort_key)
        project = {
            "project_id": project_id, "name": name, "mode": "imported",
            "owner_id": owner_id,
            "bank_ids": found_banks, "bank_files": [self._bank_files.get(value, "") for value in found_banks],
            "repetitions": max_repeat, "run_options": {"repetitions": max_repeat},
            "models": models, "status": "completed", "status_label": "历史结果已导入并完成分析",
            "created_at": iso_now(), "updated_at": iso_now(), "calls_per_model": 0,
            "estimated_calls": 0, "active_model_id": "", "imported": True,
        }
        self._projects[project_id] = project
        self._save(project)
        analysis = self.analysis(project_id)
        atomic_json(self._folder(project_id) / "通俗报告数据.json", analysis)
        return self.get_project(project_id, owner_id)

    def zip_project(self, project_id: str, owner_id: str | None = None) -> Path:
        project = self.get_project(project_id, owner_id)
        folder = self._folder(project_id)
        try:
            atomic_json(folder / "通俗报告数据.json", self.analysis(project_id))
        except Exception:
            pass
        zip_path = self.projects_dir / f"{project_id}.zip"
        temp = zip_path.with_suffix(".zip.tmp")
        with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(folder.iterdir()):
                if path.is_file():
                    archive.write(path, arcname=f"{project_id}/{path.name}")
            for model in project.get("models", []):
                run_id = model.get("run_id")
                if not run_id:
                    continue
                run_folder = self.results_dir / run_id
                for path in sorted(run_folder.iterdir() if run_folder.is_dir() else []):
                    if path.is_file():
                        label = safe_slug(str(model.get("label") or run_id), limit=60)
                        archive.write(path, arcname=f"{project_id}/运行结果/{label}/{path.name}")
        temp.replace(zip_path)
        return zip_path

    def open_folder(self, project_id: str, owner_id: str | None = None) -> None:
        self._owned_project(project_id, owner_id)
        folder = self._folder(project_id)
        if not folder.is_dir():
            raise KeyError("项目文件夹不存在")
        if sys.platform.startswith("win"):
            os.startfile(str(folder))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])

    def assert_run_owner(self, run_id: str, owner_id: str | None) -> None:
        if owner_id is None:
            return
        for project in self._projects.values():
            if project.get("owner_id", "local") != owner_id:
                continue
            if any(model.get("run_id") == run_id for model in project.get("models", [])):
                return
        raise KeyError("未找到该运行结果")
