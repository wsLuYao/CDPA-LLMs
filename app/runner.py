from __future__ import annotations

import csv
import hashlib
import itertools
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from . import APP_VERSION, PARSER_VERSION, PROMPT_VERSION
from .csv_loader import (
    BankValidationError,
    QuestionItem,
    inspect_bank,
    list_banks,
    load_bank,
    safe_bank_path,
)
from .prompting import (
    ALL_PERMUTATIONS,
    SYSTEM_PROMPT,
    canonical_ranking,
    choose_permutation,
    initial_messages,
    invalid_status,
    parse_ranking,
    presentation_for,
    repair_messages,
)
from .providers import ApiCallResult, ApiError, ProviderConfig, call_provider


RUNTIME_FIELDS = [
    "TaskIndex",
    "RunID",
    "RequestID",
    "ModelConfigID",
    "Provider",
    "ApiMode",
    "Model",
    "ModelVersion",
    "Temperature",
    "TopP",
    "Seed",
    "MaxOutputTokens",
    "SamplingSent",
    "SourceFile",
    "SourceRow",
    "ItemID",
    "GroupID",
    "RepeatIndex",
    "PermutationID",
    "DisplayToSourceMap",
    "Ranking",
    "CanonicalRanking",
    "FirstStatus",
    "RetryUsed",
    "FinalStatus",
    "OriginalAnswer",
    "OriginalExtractionSource",
    "OriginalProviderResponseJSON",
    "FinalAnswer",
    "FinalExtractionSource",
    "FinalProviderResponseJSON",
    "ResponseRaw",
    "ParsedResponse",
    "ParsedLogical",
    "TopChoice",
    "CanonicalTopChoice",
    "LatencyMs",
    "PromptTokens",
    "CompletionTokens",
    "ThinkingTokens",
    "TotalTokens",
    "TechnicalAttempts",
    "RequestAttempt",
    "TechError",
    "ErrorCode",
    "ErrorMessage",
    "PromptVersion",
    "ParserVersion",
    "Timestamp",
]

SIMPLE_FIELDS = [
    "SourceFile",
    "SourceRow",
    "ItemID",
    "GroupID",
    "RepeatIndex",
    "PermutationID",
    "Ranking",
    "CanonicalRanking",
    "FirstStatus",
    "OriginalAnswer",
    "OriginalExtractionSource",
    "OriginalProviderResponseJSON",
    "FinalStatus",
    "FinalAnswer",
    "RetryUsed",
    "Timestamp",
]


def iso_now() -> str:
    """Return the operating system's current local time with its UTC offset."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def compact_json(value: Any) -> str:
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return json.dumps(str(value), ensure_ascii=False)


def safe_slug(value: str, limit: int = 36) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return (cleaned or "model")[:limit]


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


@dataclass(frozen=True)
class RunOptions:
    repetitions: int = 1
    permutation_mode: str = "original"
    shuffle_items: bool = True
    random_seed: int = 20260819
    concurrency: int = 2
    delay_ms: int = 250
    technical_retries: int = 2
    format_repair: bool = True

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "RunOptions":
        options = cls(
            repetitions=int(payload.get("repetitions", 1)),
            permutation_mode=str(payload.get("permutation_mode") or "original"),
            shuffle_items=bool(payload.get("shuffle_items", True)),
            random_seed=int(payload.get("random_seed", 20260819)),
            concurrency=int(payload.get("concurrency", 2)),
            delay_ms=int(payload.get("delay_ms", 250)),
            technical_retries=int(payload.get("technical_retries", 2)),
            format_repair=bool(payload.get("format_repair", True)),
        )
        if not 1 <= options.repetitions <= 20:
            raise ValueError("独立重复次数应在 1—20 之间")
        if options.permutation_mode not in {"original", "random", "balanced6"}:
            raise ValueError("选项位置模式不合法")
        if not 1 <= options.concurrency <= 12:
            raise ValueError("并发数应在 1—12 之间")
        if not 0 <= options.delay_ms <= 60000:
            raise ValueError("调用间隔应在 0—60000 毫秒之间")
        if not 0 <= options.technical_retries <= 6:
            raise ValueError("技术重试次数应在 0—6 之间")
        return options


@dataclass(frozen=True)
class Task:
    index: int
    item: QuestionItem
    repeat_index: int
    permutation: tuple[int, int, int]


@dataclass
class RunRecord:
    run_id: str
    status: str
    files: list[str]
    total: int
    output_dir: Path
    config: dict[str, Any]
    options: dict[str, Any]
    model_config_id: str
    created_at: str
    started_at: str = ""
    finished_at: str = ""
    completed: int = 0
    valid: int = 0
    repaired_valid: int = 0
    invalid: int = 0
    tech_error: int = 0
    error: str = ""
    cancel_requested: bool = False
    pause_requested: bool = False
    recent_results: list[dict[str, Any]] = field(default_factory=list)
    results: list[dict[str, Any]] = field(default_factory=list, repr=False)
    source_headers: list[str] = field(default_factory=list, repr=False)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    pause_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def public(self) -> dict[str, Any]:
        progress = round(self.completed / self.total * 100, 1) if self.total else 0
        return {
            "run_id": self.run_id,
            "status": self.status,
            "files": self.files,
            "total": self.total,
            "completed": self.completed,
            "progress": progress,
            "valid": self.valid,
            "repaired_valid": self.repaired_valid,
            "invalid": self.invalid,
            "tech_error": self.tech_error,
            "config": self.config,
            "options": self.options,
            "model_config_id": self.model_config_id,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "cancel_requested": self.cancel_requested,
            "pause_requested": self.pause_requested,
            "recent_results": self.recent_results[-12:],
            "output_folder": self.output_dir.name,
            "downloads": {
                "ranking": "排序结果.csv",
                "complete": "完整运行记录.csv",
                "raw": "原始响应.jsonl",
                "summary": "运行摘要.json",
                "zip": f"{self.output_dir.name}.zip",
            },
        }


class RateLimiter:
    def __init__(self, interval_seconds: float) -> None:
        self.interval = max(0.0, interval_seconds)
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self, cancel_event: threading.Event) -> None:
        with self._lock:
            now = time.monotonic()
            delay = max(0.0, self._next - now)
            self._next = max(now, self._next) + self.interval
        if delay and cancel_event.wait(delay):
            raise ApiError("运行已取消", code="CANCELLED", retryable=False)


class RunManager:
    def __init__(self, bank_dir: Path, results_dir: Path) -> None:
        self.bank_dir = bank_dir
        self.results_dir = results_dir
        self.bank_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self._records: dict[str, RunRecord] = {}
        self._lock = threading.RLock()

    def banks(self) -> list[dict[str, Any]]:
        return [report.to_dict() for report in list_banks(self.bank_dir)]

    def validate_files(self, filenames: list[str]) -> list[dict[str, Any]]:
        reports = []
        for filename in filenames:
            path = safe_bank_path(self.bank_dir, filename)
            reports.append(inspect_bank(path).to_dict())
        return reports

    def _stored_run_folder(self, run_id: str) -> Path:
        if not re.fullmatch(r"run_[A-Za-z0-9._-]+", run_id):
            raise KeyError("未找到该运行")
        folder = (self.results_dir / run_id).resolve()
        if folder.parent != self.results_dir.resolve():
            raise KeyError("未找到该运行")
        return folder

    def start_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        filenames = payload.get("files") or []
        if not isinstance(filenames, list) or not filenames:
            raise ValueError("请至少选择一份题库")
        filenames = [str(name) for name in filenames]
        if len(filenames) != len(set(filenames)):
            raise ValueError("题库文件选择存在重复")
        provider = ProviderConfig.from_dict(payload.get("provider_config") or {})
        options = RunOptions.from_dict(payload.get("run_options") or {})

        items: list[QuestionItem] = []
        source_headers: list[str] = []
        for filename in filenames:
            path = safe_bank_path(self.bank_dir, filename)
            report, loaded = load_bank(path)
            for header in report.headers:
                if header not in source_headers:
                    source_headers.append(header)
            items.extend(loaded)
        if not items:
            raise ValueError("所选题库没有可运行的题目")

        rng = random.Random(options.random_seed)
        tasks: list[Task] = []
        next_index = 1
        for item in items:
            if options.permutation_mode == "balanced6":
                permutations = ALL_PERMUTATIONS
                for repeat_index in range(1, options.repetitions + 1):
                    for permutation in permutations:
                        tasks.append(Task(next_index, item, repeat_index, permutation))
                        next_index += 1
            else:
                for repeat_index in range(1, options.repetitions + 1):
                    permutation = choose_permutation(options.permutation_mode, rng)
                    tasks.append(Task(next_index, item, repeat_index, permutation))
                    next_index += 1
        execution_tasks = list(tasks)
        if options.shuffle_items:
            rng.shuffle(execution_tasks)

        public_config = provider.public_dict()
        config_hash_payload = {
            "provider": public_config,
            "prompt_version": PROMPT_VERSION,
            "system_prompt": SYSTEM_PROMPT,
            "run_options": options.__dict__,
        }
        model_config_id = "MC-" + hashlib.sha256(
            json.dumps(config_hash_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:12]
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        run_id = f"run_{stamp}_{safe_slug(provider.provider)}_{safe_slug(provider.model)}_{uuid.uuid4().hex[:6]}"
        output_dir = self.results_dir / run_id
        output_dir.mkdir(parents=False, exist_ok=False)
        record = RunRecord(
            run_id=run_id,
            status="queued",
            files=filenames,
            total=len(execution_tasks),
            output_dir=output_dir,
            config=public_config,
            options=dict(options.__dict__),
            model_config_id=model_config_id,
            created_at=iso_now(),
            source_headers=source_headers,
        )
        with self._lock:
            self._records[run_id] = record
        self._write_summary(record)
        thread = threading.Thread(
            target=self._run,
            args=(record, execution_tasks, provider, options),
            name=f"runner-{run_id}",
            daemon=True,
        )
        thread.start()
        return record.public()

    def resume_run(self, run_id: str, provider_payload: dict[str, Any]) -> dict[str, Any]:
        """Resume an interrupted/cancelled run without repeating committed tasks.

        API keys are intentionally never persisted. The caller must provide the
        same provider configuration again; all public configuration fields are
        checked before any request is sent.
        """
        with self._lock:
            live = self._records.get(run_id)
            if live and live.status in {"queued", "running", "paused"}:
                raise ValueError("该运行仍在进行中")

        summary = self.get_run(run_id)
        provider = ProviderConfig.from_dict(provider_payload)
        saved_config = summary.get("config") or {}
        current_config = provider.public_dict()
        core_fields = (
            "provider", "model", "base_url", "api_mode", "max_output_tokens",
            "send_sampling", "temperature", "top_p", "seed",
        )
        mismatched = [
            field for field in core_fields
            if str(saved_config.get(field, "")) != str(current_config.get(field, ""))
        ]
        if mismatched:
            raise ValueError("恢复运行时模型配置必须与原运行完全一致：" + "、".join(mismatched))

        filenames = [str(name) for name in (summary.get("files") or [])]
        options = RunOptions.from_dict(summary.get("options") or {})
        items: list[QuestionItem] = []
        source_headers: list[str] = []
        for filename in filenames:
            path = safe_bank_path(self.bank_dir, filename)
            report, loaded = load_bank(path)
            for header in report.headers:
                if header not in source_headers:
                    source_headers.append(header)
            items.extend(loaded)
        if not items:
            raise ValueError("原运行题库已不存在或没有可运行题目")

        rng = random.Random(options.random_seed)
        tasks: list[Task] = []
        next_index = 1
        for item in items:
            if options.permutation_mode == "balanced6":
                for repeat_index in range(1, options.repetitions + 1):
                    for permutation in ALL_PERMUTATIONS:
                        tasks.append(Task(next_index, item, repeat_index, permutation))
                        next_index += 1
            else:
                for repeat_index in range(1, options.repetitions + 1):
                    tasks.append(Task(next_index, item, repeat_index, choose_permutation(options.permutation_mode, rng)))
                    next_index += 1
        execution_tasks = list(tasks)
        if options.shuffle_items:
            rng.shuffle(execution_tasks)

        output_dir = self._stored_run_folder(run_id)
        complete_path = output_dir / "完整运行记录.csv"
        existing: dict[int, dict[str, Any]] = {}
        if complete_path.is_file():
            with complete_path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    try:
                        index = int(row.get("TaskIndex") or 0)
                    except ValueError:
                        continue
                    if index > 0 and row.get("FinalStatus") != "CANCELLED":
                        existing[index] = dict(row)
        remaining = [task for task in execution_tasks if task.index not in existing]
        record = RunRecord(
            run_id=run_id,
            status="queued",
            files=filenames,
            total=len(execution_tasks),
            output_dir=output_dir,
            config=current_config,
            options=dict(options.__dict__),
            model_config_id=str(summary.get("model_config_id") or ""),
            created_at=str(summary.get("created_at") or iso_now()),
            started_at=str(summary.get("started_at") or ""),
            completed=len(existing),
            results=list(existing.values()),
            source_headers=source_headers,
        )
        for row in record.results:
            status = row.get("FinalStatus")
            if status == "VALID":
                record.valid += 1
            elif status == "REPAIRED_VALID":
                record.valid += 1
                record.repaired_valid += 1
            elif status == "TECH_ERROR":
                record.tech_error += 1
            else:
                record.invalid += 1
        record.recent_results = [
            {key: row.get(key, "") for key in SIMPLE_FIELDS}
            for row in sorted(record.results, key=lambda item: int(item.get("TaskIndex") or 0))[-12:]
        ]
        with self._lock:
            self._records[run_id] = record
            self._rewrite_sorted_outputs(record)
            self._write_summary(record)
        if not remaining:
            record.status = "completed"
            record.finished_at = iso_now()
            self._write_summary(record)
            return record.public()
        thread = threading.Thread(
            target=self._run,
            args=(record, remaining, provider, options),
            name=f"runner-resume-{run_id}",
            daemon=True,
        )
        thread.start()
        return record.public()

    def get_run(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._records.get(run_id)
            if record:
                return record.public()
        summary_path = self._stored_run_folder(run_id) / "运行摘要.json"
        if summary_path.is_file():
            return json.loads(summary_path.read_text(encoding="utf-8"))
        raise KeyError("未找到该运行")

    def list_runs(self) -> list[dict[str, Any]]:
        summaries: list[dict[str, Any]] = []
        with self._lock:
            live_ids = set(self._records)
            summaries.extend(record.public() for record in self._records.values())
        for path in sorted(self.results_dir.glob("run_*/运行摘要.json"), reverse=True):
            if path.parent.name in live_ids:
                continue
            try:
                summaries.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        return sorted(summaries, key=lambda item: item.get("created_at", ""), reverse=True)[:30]

    def analysis(self, run_id: str) -> dict[str, Any]:
        """Build a descriptive pre-run quality report without applying final scoring."""
        run = self.get_run(run_id)
        with self._lock:
            record = self._records.get(run_id)
            rows = [dict(item) for item in record.results] if record else []
        if not rows:
            complete_path = self._stored_run_folder(run_id) / "完整运行记录.csv"
            if complete_path.is_file():
                with complete_path.open("r", encoding="utf-8-sig", newline="") as handle:
                    rows = [dict(row) for row in csv.DictReader(handle)]

        def number(value: Any) -> float:
            try:
                return float(value)
            except (TypeError, ValueError):
                return 0.0

        def original_answer(row: dict[str, Any]) -> str:
            if "OriginalAnswer" in row:
                return str(row.get("OriginalAnswer") or "")
            return str(row.get("ResponseRaw") or "")

        def original_json(row: dict[str, Any]) -> str:
            return str(row.get("OriginalProviderResponseJSON") or "")

        def parse_time(value: Any) -> datetime | None:
            if not value:
                return None
            try:
                parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
                return parsed if parsed.tzinfo else parsed.astimezone()
            except ValueError:
                return None

        statuses = Counter(str(row.get("FinalStatus") or "UNKNOWN") for row in rows)
        rankings = Counter(str(row.get("Ranking") or "") for row in rows if row.get("Ranking"))
        top_choices = Counter(
            str(row.get("CanonicalTopChoice") or "")
            for row in rows
            if row.get("CanonicalTopChoice")
        )
        first_valid = sum(str(row.get("FirstStatus")) == "VALID" for row in rows)
        valid = statuses["VALID"] + statuses["REPAIRED_VALID"]
        repaired = statuses["REPAIRED_VALID"]
        technical = statuses["TECH_ERROR"] + statuses["CANCELLED"]
        invalid = max(0, len(rows) - valid - technical)
        latencies = [number(row.get("LatencyMs")) for row in rows if number(row.get("LatencyMs")) > 0]
        total_tokens = int(sum(number(row.get("TotalTokens")) for row in rows))
        blank_original = sum(not original_answer(row).strip() for row in rows)
        payload_without_text = sum(
            not original_answer(row).strip()
            and bool(original_json(row).strip())
            and str(row.get("OriginalExtractionSource") or "none") == "none"
            for row in rows
        )

        started = parse_time(run.get("started_at") or run.get("created_at"))
        finished = parse_time(run.get("finished_at"))
        if started and not finished and run.get("status") in {"queued", "running"}:
            finished = datetime.now().astimezone()
        elapsed_seconds = max(0, int((finished - started).total_seconds())) if started and finished else 0

        def empty_group() -> dict[str, Any]:
            return {"total": 0, "valid": 0, "repaired": 0, "invalid": 0, "technical": 0, "latency": 0.0}

        file_groups: defaultdict[str, dict[str, Any]] = defaultdict(empty_group)
        category_groups: defaultdict[tuple[str, str, str, str, str], dict[str, Any]] = defaultdict(empty_group)
        error_counts: Counter[str] = Counter()
        for row in rows:
            status = str(row.get("FinalStatus") or "UNKNOWN")
            filename = str(row.get("SourceFile") or "未知题库")
            category_key = (
                filename,
                str(row.get("Source_Dimension") or ""),
                str(row.get("Source_SecondLevel") or ""),
                str(row.get("Source_CategoryID") or ""),
                str(row.get("Source_Category") or ""),
            )
            for group in (file_groups[filename], category_groups[category_key]):
                group["total"] += 1
                group["latency"] += number(row.get("LatencyMs"))
                if status in {"VALID", "REPAIRED_VALID"}:
                    group["valid"] += 1
                    if status == "REPAIRED_VALID":
                        group["repaired"] += 1
                elif status in {"TECH_ERROR", "CANCELLED"}:
                    group["technical"] += 1
                else:
                    group["invalid"] += 1
            if status not in {"VALID", "REPAIRED_VALID"}:
                error_counts[str(row.get("ErrorCode") or status)] += 1

        def finish_group(group: dict[str, Any]) -> dict[str, Any]:
            total = int(group["total"])
            return {
                "total": total,
                "valid": int(group["valid"]),
                "repaired": int(group["repaired"]),
                "invalid": int(group["invalid"]),
                "technical": int(group["technical"]),
                "valid_rate": round(group["valid"] / total * 100, 1) if total else 0,
                "avg_latency_ms": round(group["latency"] / total) if total else 0,
            }

        by_file = [
            {"source_file": filename, **finish_group(group)}
            for filename, group in sorted(file_groups.items())
        ]
        by_category = [
            {
                "source_file": key[0],
                "dimension": key[1],
                "second_level": key[2],
                "category_id": key[3],
                "category": key[4],
                **finish_group(group),
            }
            for key, group in sorted(category_groups.items())
        ]

        details = []
        for row in sorted(rows, key=lambda item: int(number(item.get("TaskIndex")))):
            details.append(
                {
                    "task_index": int(number(row.get("TaskIndex"))),
                    "item_id": str(row.get("ItemID") or ""),
                    "group_id": str(row.get("GroupID") or ""),
                    "source_file": str(row.get("SourceFile") or ""),
                    "source_row": str(row.get("SourceRow") or ""),
                    "dimension": str(row.get("Source_Dimension") or ""),
                    "second_level": str(row.get("Source_SecondLevel") or ""),
                    "category_id": str(row.get("Source_CategoryID") or ""),
                    "category": str(row.get("Source_Category") or ""),
                    "condition": str(row.get("Source_Condition") or ""),
                    "repeat_index": str(row.get("RepeatIndex") or ""),
                    "permutation_id": str(row.get("PermutationID") or ""),
                    "ranking": str(row.get("Ranking") or ""),
                    "canonical_ranking": str(row.get("CanonicalRanking") or ""),
                    "first_status": str(row.get("FirstStatus") or ""),
                    "final_status": str(row.get("FinalStatus") or ""),
                    "retry_used": str(row.get("RetryUsed") or ""),
                    "original_answer": original_answer(row),
                    "original_extraction_source": str(row.get("OriginalExtractionSource") or ""),
                    "original_provider_response_json": original_json(row),
                    "final_answer": str(row.get("FinalAnswer") or row.get("ResponseRaw") or ""),
                    "latency_ms": int(number(row.get("LatencyMs"))),
                    "total_tokens": int(number(row.get("TotalTokens"))),
                    "error_code": str(row.get("ErrorCode") or ""),
                    "error_message": str(row.get("ErrorMessage") or ""),
                    "timestamp": str(row.get("Timestamp") or ""),
                }
            )

        total = len(rows)
        ranking_order = [
            "opt1>opt2>opt3",
            "opt1>opt3>opt2",
            "opt2>opt1>opt3",
            "opt2>opt3>opt1",
            "opt3>opt1>opt2",
            "opt3>opt2>opt1",
        ]
        run_info = {key: value for key, value in run.items() if key != "recent_results"}
        return {
            "generated_at": iso_now(),
            "report_scope": "AI 预跑格式与运行质量的描述性统计，不代替后续心理计分。",
            "run": run_info,
            "metrics": {
                "completed": total,
                "first_valid": first_valid,
                "valid": valid,
                "repaired": repaired,
                "invalid": invalid,
                "technical": technical,
                "valid_rate": round(valid / total * 100, 1) if total else 0,
                "first_valid_rate": round(first_valid / total * 100, 1) if total else 0,
                "repair_rate": round(repaired / total * 100, 1) if total else 0,
                "avg_latency_ms": round(sum(latencies) / len(latencies)) if latencies else 0,
                "total_tokens": total_tokens,
                "elapsed_seconds": elapsed_seconds,
                "blank_original": blank_original,
                "payload_without_text": payload_without_text,
            },
            "status_distribution": [
                {"label": label, "count": count}
                for label, count in sorted(statuses.items(), key=lambda item: (-item[1], item[0]))
            ],
            "ranking_distribution": [
                {"label": label, "count": rankings[label]} for label in ranking_order
            ],
            "top_choice_distribution": [
                {"label": label, "count": top_choices[label]} for label in ("opt1", "opt2", "opt3")
            ],
            "by_file": by_file,
            "by_category": by_category,
            "errors": [{"label": label, "count": count} for label, count in error_counts.most_common()],
            "details": details,
        }

    def cancel(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._records.get(run_id)
            if not record:
                raise KeyError("未找到正在运行的任务")
            if record.status not in {"queued", "running", "paused"}:
                return record.public()
            record.cancel_requested = True
            record.cancel_event.set()
            self._write_summary(record)
            return record.public()

    def pause(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._records.get(run_id)
            if not record:
                raise KeyError("未找到正在运行的任务")
            if record.status not in {"queued", "running", "paused"}:
                return record.public()
            record.pause_requested = True
            record.pause_event.set()
            record.status = "paused"
            self._write_summary(record)
            return record.public()

    def continue_run(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._records.get(run_id)
            if not record:
                raise KeyError("未找到可继续的运行")
            if record.status != "paused":
                return record.public()
            record.pause_requested = False
            record.pause_event.clear()
            record.status = "running"
            self._write_summary(record)
            return record.public()

    def output_file(self, run_id: str, filename: str) -> Path:
        allowed = {"排序结果.csv", "完整运行记录.csv", "原始响应.jsonl", "运行摘要.json"}
        if filename not in allowed:
            raise KeyError("不允许下载该文件")
        path = (self.results_dir / run_id / filename).resolve()
        expected_parent = (self.results_dir / run_id).resolve()
        if path.parent != expected_parent or not path.is_file():
            raise KeyError("结果文件不存在")
        return path

    def zip_run(self, run_id: str) -> Path:
        folder = (self.results_dir / run_id).resolve()
        if folder.parent != self.results_dir.resolve() or not folder.is_dir():
            raise KeyError("结果文件夹不存在")
        zip_path = self.results_dir / f"{run_id}.zip"
        temp = zip_path.with_suffix(".zip.tmp")
        with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(folder.iterdir()):
                if path.is_file():
                    archive.write(path, arcname=f"{run_id}/{path.name}")
        temp.replace(zip_path)
        return zip_path

    def open_folder(self, run_id: str) -> None:
        folder = (self.results_dir / run_id).resolve()
        if folder.parent != self.results_dir.resolve() or not folder.is_dir():
            raise KeyError("结果文件夹不存在")
        if sys.platform.startswith("win"):
            os.startfile(str(folder))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])

    def test_connection(self, payload: dict[str, Any]) -> dict[str, Any]:
        config = ProviderConfig.from_dict(payload)
        messages = [
            {"role": "system", "content": "你是接口连通性测试助手。只能输出指定文本。"},
            {"role": "user", "content": "请只输出 opt1>opt2>opt3，不要添加其他文字。"},
        ]
        result = call_provider(config, messages)
        ranking = parse_ranking(result.content)
        return {
            "ok": bool(ranking),
            "response": result.content,
            "model_version": result.model_version,
            "latency_ms": result.latency_ms,
            "request_id": result.request_id,
            "message": "接口连通且格式正确" if ranking else "接口连通，但模型未严格按格式返回",
        }

    def _run(
        self,
        record: RunRecord,
        tasks: list[Task],
        provider: ProviderConfig,
        options: RunOptions,
    ) -> None:
        with self._lock:
            record.status = "running"
            if not record.started_at:
                record.started_at = iso_now()
            self._write_summary(record)
        limiter = RateLimiter(options.delay_ms / 1000)

        try:
            task_iter = iter(tasks)
            pending: dict[Future[tuple[dict[str, Any], list[dict[str, Any]]]], Task] = {}
            with ThreadPoolExecutor(max_workers=options.concurrency) as executor:
                for _ in range(min(options.concurrency, len(tasks))):
                    task = next(task_iter, None)
                    if task is not None:
                        pending[executor.submit(self._execute_task, record, task, provider, options, limiter)] = task

                while pending:
                    finished, _ = wait(pending, return_when=FIRST_COMPLETED)
                    for future in finished:
                        task = pending.pop(future, None)
                        try:
                            result, raw_events = future.result()
                        except Exception as exc:  # Defensive boundary: one task must not stop the run.
                            result = {
                                "TaskIndex": getattr(task, "index", 0),
                                "RunID": record.run_id,
                                "SourceFile": getattr(getattr(task, "item", None), "source_file", ""),
                                "SourceRow": getattr(getattr(task, "item", None), "source_row", ""),
                                "ItemID": getattr(getattr(task, "item", None), "item_id", ""),
                                "GroupID": getattr(getattr(task, "item", None), "group_id", ""),
                                "RepeatIndex": getattr(task, "repeat_index", ""),
                                "FirstStatus": "TECH_ERROR",
                                "FinalStatus": "TECH_ERROR",
                                "ErrorCode": "INTERNAL_ERROR",
                                "ErrorMessage": str(exc)[:1000],
                                "Timestamp": iso_now(),
                            }
                            raw_events = []
                        self._commit_result(record, result, raw_events)
                        while record.pause_event.is_set() and not record.cancel_event.is_set():
                            time.sleep(0.2)
                        if not record.cancel_event.is_set():
                            next_task = next(task_iter, None)
                            if next_task is not None:
                                pending[
                                    executor.submit(
                                        self._execute_task,
                                        record,
                                        next_task,
                                        provider,
                                        options,
                                        limiter,
                                    )
                                ] = next_task
                    if record.cancel_event.is_set():
                        for future in pending:
                            future.cancel()
                        pending = {future: task for future, task in pending.items() if future.running()}

            with self._lock:
                record.status = "cancelled" if record.cancel_requested else "completed"
                record.finished_at = iso_now()
                self._rewrite_sorted_outputs(record)
                self._write_summary(record)
        except Exception as exc:
            with self._lock:
                record.status = "failed"
                record.error = str(exc)[:2000]
                record.finished_at = iso_now()
                self._rewrite_sorted_outputs(record)
                self._write_summary(record)

    def _technical_call(
        self,
        record: RunRecord,
        provider: ProviderConfig,
        messages: list[dict[str, str]],
        options: RunOptions,
        limiter: RateLimiter,
        request_id: str,
        call_kind: str,
        attempt_offset: int,
    ) -> tuple[ApiCallResult, list[dict[str, Any]]]:
        events: list[dict[str, Any]] = []
        last_error: ApiError | None = None
        for technical_index in range(options.technical_retries + 1):
            if record.cancel_event.is_set():
                raise ApiError("运行已取消", code="CANCELLED", retryable=False)
            limiter.wait(record.cancel_event)
            attempt = attempt_offset + technical_index + 1
            timestamp = iso_now()
            request_log = {
                "RunID": record.run_id,
                "RequestID": request_id,
                "RequestAttempt": attempt,
                "CallKind": call_kind,
                "Provider": provider.provider,
                "Model": provider.model,
                "PromptVersion": PROMPT_VERSION,
                "Messages": messages,
                "Timestamp": timestamp,
            }
            try:
                result = call_provider(provider, messages)
                request_log.update(
                    {
                        "Status": "RESPONSE_RECEIVED",
                        "Endpoint": result.endpoint,
                        "ResponseRaw": result.raw_response,
                        "ResponseText": result.content,
                        "ExtractionSource": result.extraction_source,
                        "ModelVersion": result.model_version,
                        "Usage": result.usage,
                        "LatencyMs": result.latency_ms,
                        "ProviderRequestID": result.request_id,
                    }
                )
                events.append(request_log)
                return result, events
            except ApiError as exc:
                last_error = exc
                request_log.update(
                    {
                        "Status": "TECH_ERROR",
                        "ErrorCode": exc.code,
                        "HTTPStatus": exc.status,
                        "ErrorMessage": str(exc),
                        "Retryable": exc.retryable,
                        "ResponseBody": exc.response_body,
                    }
                )
                events.append(request_log)
                if not exc.retryable or technical_index >= options.technical_retries:
                    setattr(exc, "attempt_events", events)
                    raise
                delay = exc.retry_after if exc.retry_after is not None else min(30.0, 2**technical_index)
                if record.cancel_event.wait(delay + random.random() * 0.25):
                    raise ApiError("运行已取消", code="CANCELLED", retryable=False)
        assert last_error is not None
        raise last_error

    def _execute_task(
        self,
        record: RunRecord,
        task: Task,
        provider: ProviderConfig,
        options: RunOptions,
        limiter: RateLimiter,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        request_id = "REQ-" + uuid.uuid4().hex
        session_id = "SES-" + uuid.uuid4().hex
        presentation = presentation_for(task.item.options, task.permutation)
        messages = initial_messages(
            task.item.context, task.item.question, presentation.display_options
        )
        events: list[dict[str, Any]] = []
        first_status = "TECH_ERROR"
        final_status = "TECH_ERROR"
        ranking = ""
        retry_used = 0
        original_answer = ""
        original_extraction_source = ""
        original_provider_response_json = ""
        final_answer = ""
        final_extraction_source = ""
        final_provider_response_json = ""
        original_captured = False
        model_version = provider.model
        error_code = ""
        error_message = ""
        total_latency = 0
        usage_totals = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "thinking_tokens": 0,
            "total_tokens": 0,
        }

        def absorb(result: ApiCallResult, *, is_original: bool = False) -> None:
            nonlocal total_latency, model_version
            nonlocal original_answer, original_extraction_source
            nonlocal original_provider_response_json, original_captured
            nonlocal final_answer, final_extraction_source, final_provider_response_json
            total_latency += result.latency_ms
            model_version = result.model_version or model_version
            final_answer = result.content
            final_extraction_source = result.extraction_source
            final_provider_response_json = compact_json(result.raw_response)
            if is_original:
                original_answer = result.content
                original_extraction_source = result.extraction_source
                original_provider_response_json = compact_json(result.raw_response)
                original_captured = True
            for key in usage_totals:
                value = result.usage.get(key)
                if isinstance(value, (int, float)):
                    usage_totals[key] += int(value)

        try:
            first, first_events = self._technical_call(
                record,
                provider,
                messages,
                options,
                limiter,
                request_id,
                "FIRST_RESPONSE",
                0,
            )
            events.extend(first_events)
            absorb(first, is_original=True)
            ranking = parse_ranking(first.content) or ""
            first_status = "VALID" if ranking else invalid_status(first.content)
            final_status = first_status

            if not ranking and options.format_repair and not record.cancel_event.is_set():
                retry_used = 1
                repaired, repair_events = self._technical_call(
                    record,
                    provider,
                    repair_messages(
                        task.item.context,
                        task.item.question,
                        presentation.display_options,
                        first.content,
                    ),
                    options,
                    limiter,
                    request_id,
                    "FORMAT_REPAIR",
                    len(events),
                )
                events.extend(repair_events)
                absorb(repaired)
                ranking = parse_ranking(repaired.content) or ""
                final_status = "REPAIRED_VALID" if ranking else invalid_status(repaired.content)
        except ApiError as exc:
            events.extend(getattr(exc, "attempt_events", []))
            audit_events = [
                event
                for event in events
                if "ResponseRaw" in event or "ResponseBody" in event
            ]
            if audit_events and not original_captured:
                first_event = audit_events[0]
                original_answer = str(first_event.get("ResponseText") or "")
                original_extraction_source = str(first_event.get("ExtractionSource") or "none")
                original_provider_response_json = compact_json(
                    first_event.get("ResponseRaw", first_event.get("ResponseBody"))
                )
            if audit_events:
                last_event = audit_events[-1]
                final_answer = str(last_event.get("ResponseText") or final_answer)
                final_extraction_source = str(
                    last_event.get("ExtractionSource") or final_extraction_source or "none"
                )
                final_provider_response_json = compact_json(
                    last_event.get("ResponseRaw", last_event.get("ResponseBody"))
                )
            error_code = exc.code
            error_message = str(exc)[:1000]
            final_status = "CANCELLED" if exc.code == "CANCELLED" else "TECH_ERROR"

        mapping = presentation.display_to_source
        timestamp = iso_now()
        result: dict[str, Any] = {
            "TaskIndex": task.index,
            "RunID": record.run_id,
            "RequestID": request_id,
            "SessionID": session_id,
            "ModelConfigID": record.model_config_id,
            "Provider": provider.provider,
            "ApiMode": provider.api_mode,
            "Model": provider.model,
            "ModelVersion": model_version,
            "Temperature": provider.temperature if provider.send_sampling else "",
            "TopP": provider.top_p if provider.send_sampling else "",
            "Seed": provider.seed if provider.send_sampling and provider.seed is not None else "",
            "MaxOutputTokens": provider.max_output_tokens,
            "SamplingSent": int(provider.send_sampling),
            "SourceFile": task.item.source_file,
            "SourceRow": task.item.source_row,
            "ItemID": task.item.item_id,
            "GroupID": task.item.group_id,
            "RepeatIndex": task.repeat_index,
            "PermutationID": presentation.permutation_id,
            "DisplayToSourceMap": ";".join(
                f"opt{display}=source_opt{source}"
                for display, source in enumerate(mapping, start=1)
            ),
            "Ranking": ranking,
            "CanonicalRanking": canonical_ranking(ranking, mapping),
            "FirstStatus": first_status,
            "RetryUsed": retry_used,
            "FinalStatus": final_status,
            "OriginalAnswer": original_answer,
            "OriginalExtractionSource": original_extraction_source,
            "OriginalProviderResponseJSON": original_provider_response_json,
            "FinalAnswer": final_answer,
            "FinalExtractionSource": final_extraction_source,
            "FinalProviderResponseJSON": final_provider_response_json,
            "ResponseRaw": final_answer,
            "ParsedResponse": ranking,
            "ParsedLogical": canonical_ranking(ranking, mapping),
            "TopChoice": ranking.split(">")[0] if ranking else "",
            "CanonicalTopChoice": canonical_ranking(ranking, mapping).split(">")[0]
            if ranking
            else "",
            "LatencyMs": total_latency,
            "PromptTokens": usage_totals["prompt_tokens"] or "",
            "CompletionTokens": usage_totals["completion_tokens"] or "",
            "ThinkingTokens": usage_totals["thinking_tokens"] or "",
            "TotalTokens": usage_totals["total_tokens"] or "",
            "TechnicalAttempts": len(events),
            "RequestAttempt": max(
                (int(event.get("RequestAttempt") or 0) for event in events),
                default=0,
            ),
            "TechError": error_code,
            "ErrorCode": error_code,
            "ErrorMessage": error_message,
            "PromptVersion": PROMPT_VERSION,
            "ParserVersion": PARSER_VERSION,
            "Timestamp": timestamp,
        }
        for key, value in task.item.metadata.items():
            result[f"Source_{key}"] = value
        for event in events:
            event.update(
                {
                    "SessionID": session_id,
                    "ModelConfigID": record.model_config_id,
                    "SourceFile": task.item.source_file,
                    "SourceRow": task.item.source_row,
                    "ItemID": task.item.item_id,
                    "GroupID": task.item.group_id,
                    "RepeatIndex": task.repeat_index,
                    "PermutationID": presentation.permutation_id,
                    "DisplayToSourceMap": result["DisplayToSourceMap"],
                }
            )
        return result, events

    def _commit_result(
        self,
        record: RunRecord,
        result: dict[str, Any],
        raw_events: list[dict[str, Any]],
    ) -> None:
        with self._lock:
            record.results.append(result)
            record.completed += 1
            status = result.get("FinalStatus")
            if status == "VALID":
                record.valid += 1
            elif status == "REPAIRED_VALID":
                record.valid += 1
                record.repaired_valid += 1
            elif status in {"TECH_ERROR", "CANCELLED"}:
                record.tech_error += 1
            else:
                record.invalid += 1
            record.recent_results.append(
                {key: result.get(key, "") for key in SIMPLE_FIELDS}
            )
            record.recent_results = record.recent_results[-12:]
            self._append_csv(record.output_dir / "排序结果.csv", SIMPLE_FIELDS, result)
            complete_fields = RUNTIME_FIELDS + [
                "SessionID"
            ] + [f"Source_{header}" for header in record.source_headers]
            self._append_csv(record.output_dir / "完整运行记录.csv", complete_fields, result)
            with (record.output_dir / "原始响应.jsonl").open("a", encoding="utf-8") as handle:
                for event in raw_events:
                    handle.write(json.dumps(event, ensure_ascii=False) + "\n")
            self._write_summary(record)

    @staticmethod
    def _append_csv(path: Path, fields: list[str], result: dict[str, Any]) -> None:
        exists = path.exists()
        with path.open("a", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            if not exists:
                writer.writeheader()
            writer.writerow({field: result.get(field, "") for field in fields})

    def _rewrite_sorted_outputs(self, record: RunRecord) -> None:
        sorted_results = sorted(record.results, key=lambda item: int(item.get("TaskIndex") or 0))
        simple_path = record.output_dir / "排序结果.csv"
        complete_path = record.output_dir / "完整运行记录.csv"
        complete_fields = RUNTIME_FIELDS + ["SessionID"] + [
            f"Source_{header}" for header in record.source_headers
        ]
        for path, fields in ((simple_path, SIMPLE_FIELDS), (complete_path, complete_fields)):
            with path.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
                writer.writeheader()
                for result in sorted_results:
                    writer.writerow({field: result.get(field, "") for field in fields})

    def _write_summary(self, record: RunRecord) -> None:
        summary = record.public()
        summary.update(
            {
                "app_version": APP_VERSION,
                "prompt_version": PROMPT_VERSION,
                "parser_version": PARSER_VERSION,
                "system_prompt": SYSTEM_PROMPT,
                "model_input_policy": (
                    "模型仅接收统一格式指令、当前行 Context、Question 和三个显示选项；"
                    "CSV 其他研究字段不进入请求。"
                ),
                "note": "API Key 未写入任何结果文件。模型只接收情境、问题、三个显示选项及统一格式指令。",
            }
        )
        atomic_json(record.output_dir / "运行摘要.json", summary)
