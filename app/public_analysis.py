from __future__ import annotations

import csv
import io
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from . import ANALYSIS_VERSION
from .model_order import model_sort_key


VALID_STATUSES = {"VALID", "REPAIRED_VALID"}

BANK_META = {
    "risk": {
        "label": "风险决策",
        "short": "已知概率下的风险权衡",
        "color": "#4ee1bd",
        "rows": 600,
    },
    "ambiguity": {
        "label": "模糊决策",
        "short": "信息不完整时的选择倾向",
        "color": "#f6ad55",
        "rows": 90,
    },
    "intertemporal": {
        "label": "跨期决策",
        "short": "现在与未来结果的权衡",
        "color": "#67a7ff",
        "rows": 150,
    },
    "moral_cni": {
        "label": "道德决策",
        "short": "规范与后果冲突中的行动排序",
        "color": "#c084fc",
        "rows": 96,
    },
}


def _decode_csv(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"无法读取CSV：{path.name}")


def read_rows(path: Path) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(_decode_csv(path), newline="")))


def _number(value: Any) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _mean(values: Iterable[float]) -> float | None:
    clean = [value for value in values if value is not None and math.isfinite(value)]
    return sum(clean) / len(clean) if clean else None


def _sample_sd(values: Iterable[float]) -> float | None:
    clean = [value for value in values if value is not None and math.isfinite(value)]
    return statistics.stdev(clean) if len(clean) >= 2 else None


def _median(values: Iterable[float]) -> float | None:
    clean = [value for value in values if value is not None and math.isfinite(value)]
    return statistics.median(clean) if clean else None


def _pearson(left: Iterable[float], right: Iterable[float]) -> float | None:
    pairs = [
        (float(a), float(b))
        for a, b in zip(left, right)
        if a is not None and b is not None and math.isfinite(float(a)) and math.isfinite(float(b))
    ]
    if len(pairs) < 3:
        return None
    xs, ys = zip(*pairs)
    x_mean, y_mean = statistics.mean(xs), statistics.mean(ys)
    x_ss = sum((value - x_mean) ** 2 for value in xs)
    y_ss = sum((value - y_mean) ** 2 for value in ys)
    if x_ss <= 1e-15 or y_ss <= 1e-15:
        return None
    return sum((a - x_mean) * (b - y_mean) for a, b in pairs) / math.sqrt(x_ss * y_ss)


def bank_id(source_file: str) -> str:
    value = str(source_file or "").lower()
    if "风险" in value or "risk" in value:
        return "risk"
    if "模糊" in value or "ambigu" in value:
        return "ambiguity"
    if "跨期" in value or "intertemporal" in value or "delay" in value:
        return "intertemporal"
    if "cni" in value or "cnis" in value:
        return "moral_cni"
    if "mft" in value:
        return "moral_mft"
    return "unknown"


def _parse_mapping(value: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for part in str(value or "").replace("|", ";").split(";"):
        if "=" not in part:
            continue
        left, right = [item.strip() for item in part.split("=", 1)]
        if left and right:
            mapping[left.lower()] = right.upper()
    return mapping


def logical_ranking(row: dict[str, str]) -> str:
    source = str(row.get("CanonicalRanking") or row.get("ParsedLogical") or "").lower()
    if not source:
        return ""
    mapping = _parse_mapping(row.get("Source_Opt_to_L_Map", ""))
    if not mapping:
        mapping = {"opt1": "L1", "opt2": "L2", "opt3": "L3"}
    parts = [mapping.get(token.strip(), "") for token in source.split(">")]
    return ">".join(parts) if len(parts) == 3 and all(parts) and len(set(parts)) == 3 else ""


def preference_score(logical: str) -> float | None:
    parts = logical.split(">")
    if set(parts) != {"L1", "L2", "L3"}:
        return None
    ranks = {label: index + 1 for index, label in enumerate(parts)}
    return (ranks["L1"] - ranks["L3"]) / 2


def _role_labels(value: str) -> tuple[str, str]:
    roles: dict[str, str] = {}
    for part in str(value or "").split(";"):
        if "=" in part:
            key, label = part.split("=", 1)
            roles[key.strip().upper()] = label.strip()
    return roles.get("L1", "L1方向"), roles.get("L3", "L3方向")


def _domain_for(row: dict[str, str], bank: str) -> str:
    explicit = str(row.get("Source_Domain") or row.get("Domain") or "").strip()
    if explicit:
        return explicit
    group = str(row.get("GroupID") or row.get("Source_GroupID") or "")
    suffix = group.rsplit("_", 1)[-1] if "_" in group else ""
    if bank == "intertemporal":
        return {
            "01": "娱乐／生活消费",
            "02": "金融／投资",
            "03": "医疗／健康",
            "04": "教育／学业",
            "05": "职业／就业",
        }.get(suffix, "未标注情境")
    if bank == "ambiguity":
        return {
            "01": "金融／投资",
            "02": "医疗／健康与安全",
            "03": "消费／权益",
            "04": "娱乐／生活消费",
            "05": "社会／合作",
        }.get(suffix, "未标注情境")
    if bank == "risk":
        return {
            "01": "金融／财产",
            "02": "医疗／健康",
            "03": "资源／休闲",
            "04": "社会／公共参与",
        }.get(suffix, "未标注情境")
    return "未标注情境"


def _fnv_digest(row: dict[str, str]) -> str:
    fields = ["Source_Context", "Source_Question", "Source_Opt1", "Source_Opt2", "Source_Opt3"]
    text = "|".join(f"{field}={str(row.get(field) or '').strip()}" for field in fields)
    value = 2166136261
    for char in text:
        value ^= ord(char)
        value = (value * 16777619) & 0xFFFFFFFF
    return f"BCD-{value:08x}"


def _human_reference(
    human_dir: Path,
    runtime_rows: list[dict[str, str]],
) -> dict[tuple[str, str], dict[str, Any]]:
    runtime_items: dict[tuple[str, str], tuple[str, str]] = {}
    for row in runtime_rows:
        bank = bank_id(row.get("SourceFile", ""))
        item_id = str(row.get("ItemID") or row.get("Source_ItemID") or "")
        if bank in BANK_META and item_id:
            runtime_items[(bank, item_id)] = (_fnv_digest(row), str(row.get("Source_ItemVersion") or ""))

    files = {
        "ambiguity": "human_ambiguity_long.csv",
        "intertemporal": "human_intertemporal_long.csv",
        "moral_cni": "human_cni_long.csv",
    }
    grouped_p: defaultdict[tuple[str, str], list[float]] = defaultdict(list)
    grouped_pair: defaultdict[tuple[str, str], list[float]] = defaultdict(list)
    matched_items: defaultdict[tuple[str, str], set[str]] = defaultdict(set)
    blocked: defaultdict[str, Counter[str]] = defaultdict(Counter)

    for bank, filename in files.items():
        path = human_dir / filename
        if not path.is_file():
            continue
        for row in read_rows(path):
            if str(row.get("Included") or "").lower() not in {"1", "true", "yes"}:
                continue
            item_id = str(row.get("ItemID") or "")
            runtime = runtime_items.get((bank, item_id))
            if not runtime:
                blocked[bank]["未运行"] += 1
                continue
            digest, item_version = runtime
            if str(row.get("Source_ContentDigest") or "") != digest:
                blocked[bank]["题目版本不一致"] += 1
                continue
            if item_version and str(row.get("ItemVersion") or "") != item_version:
                blocked[bank]["ItemVersion不一致"] += 1
                continue
            category_id = str(row.get("CategoryID") or row.get("Category") or "")
            key = (bank, category_id)
            p = _number(row.get("PreferenceScore_P"))
            pair = _number(row.get("Pair_L1_Above_L2"))
            if p is not None:
                grouped_p[key].append(p)
            if pair is not None:
                grouped_pair[key].append(pair)
            matched_items[key].add(item_id)

    result: dict[tuple[str, str], dict[str, Any]] = {}
    for key in set(grouped_p) | set(grouped_pair):
        result[key] = {
            "mean_p": _mean(grouped_p.get(key, [])),
            "pair_l1_above_l2": _mean(grouped_pair.get(key, [])),
            "matched_items": len(matched_items[key]),
            "reference_type": "SAME_TASK_HUMAN_SAMPLE",
        }
    for bank, reasons in blocked.items():
        result[(bank, "__status__")] = {
            "blocked": sum(reasons.values()),
            "reasons": dict(reasons),
        }
    return result


def analyze_project(
    project: dict[str, Any],
    run_folders: list[Path],
    human_dir: Path,
) -> dict[str, Any]:
    all_rows: list[dict[str, str]] = []
    run_labels: dict[str, str] = {}
    label_sort_keys: dict[str, tuple[int, str]] = {}
    for index, folder in enumerate(run_folders):
        complete = folder / "完整运行记录.csv"
        if not complete.is_file():
            continue
        rows = read_rows(complete)
        label = ""
        matched_model: dict[str, Any] | None = None
        for model in project.get("models", []):
            if model.get("run_id") == folder.name:
                matched_model = model
                label = str(model.get("label") or model.get("model") or "")
                break
        label = label or (str(rows[0].get("Model") or "") if rows else f"模型{index + 1}")
        run_labels[folder.name] = label
        label_sort_keys.setdefault(label, model_sort_key(matched_model or label))
        for row in rows:
            row["__run_folder__"] = folder.name
            row["__model_label__"] = label
            row["__bank_id__"] = bank_id(row.get("SourceFile", ""))
            row["__logical__"] = logical_ranking(row)
            score_family = str(row.get("Source_ScoreFamily") or "")
            score = preference_score(row["__logical__"])
            row["__p__"] = "" if "DIRECTIONAL" not in score_family or score is None else str(score)
            all_rows.append(row)

    model_labels = sorted(dict.fromkeys(run_labels.values()), key=lambda value: label_sort_keys.get(value, model_sort_key(value)))
    valid_rows = [row for row in all_rows if str(row.get("FinalStatus")) in VALID_STATUSES and row.get("__logical__")]
    non_technical_rows = [row for row in all_rows if str(row.get("FinalStatus") or "") != "TECH_ERROR"]
    repaired = sum(str(row.get("FinalStatus")) == "REPAIRED_VALID" for row in all_rows)
    first_valid = sum(str(row.get("FirstStatus")) == "VALID" for row in non_technical_rows)

    item_groups: defaultdict[tuple[str, str, str, str, str, str], list[dict[str, str]]] = defaultdict(list)
    for row in valid_rows:
        key = (
            row["__model_label__"], row["__bank_id__"],
            str(row.get("Source_CategoryID") or row.get("Source_Category") or ""),
            str(row.get("GroupID") or row.get("Source_GroupID") or ""),
            str(row.get("ItemID") or row.get("Source_ItemID") or ""),
            str(row.get("Source_ConditionCode") or ""),
        )
        item_groups[key].append(row)

    item_summaries: list[dict[str, Any]] = []
    for key, rows in item_groups.items():
        ps = [_number(row.get("__p__")) for row in rows]
        ps = [value for value in ps if value is not None]
        logicals = [row["__logical__"] for row in rows]
        tops = [value.split(">")[0] for value in logicals]
        top_mode = Counter(tops).most_common(1)[0][1] / len(tops) if tops else 0
        full_mode = Counter(logicals).most_common(1)[0][1] / len(logicals) if logicals else 0
        first = rows[0]
        item_summaries.append({
            "model": key[0], "bank_id": key[1], "category_id": key[2],
            "group_id": key[3], "item_id": key[4], "condition_code": key[5],
            "category": str(first.get("Source_Category") or key[2]),
            "second_level": str(first.get("Source_SecondLevel") or ""),
            "domain": _domain_for(first, key[1]),
            "mean_p": _mean(ps), "p_sd": _sample_sd(ps),
            "valid_repeats": len(rows), "top_consistency": top_mode,
            "full_consistency": full_mode,
            "logical_rankings": logicals,
            "negative_label": _role_labels(first.get("Source_OptionRole", ""))[0],
            "positive_label": _role_labels(first.get("Source_OptionRole", ""))[1],
            "score_family": str(first.get("Source_ScoreFamily") or ""),
        })

    category_groups: defaultdict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    domain_groups: defaultdict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in item_summaries:
        category_groups[(item["model"], item["bank_id"], item["category_id"])].append(item)
        domain_groups[(item["model"], item["bank_id"], item["category_id"], item["domain"])].append(item)

    profiles: list[dict[str, Any]] = []
    for key, items in category_groups.items():
        p_values = [item["mean_p"] for item in items if item["mean_p"] is not None]
        logicals = [logical for item in items for logical in item["logical_rankings"]]
        top_counts = Counter(logical.split(">")[0] for logical in logicals)
        total_top = sum(top_counts.values()) or 1
        first = items[0]
        mean_p = _mean(p_values)
        profiles.append({
            "model": key[0], "bank_id": key[1], "bank": BANK_META.get(key[1], {}).get("label", key[1]),
            "category_id": key[2], "category": first["category"], "second_level": first["second_level"],
            "mean_p": mean_p, "score_0_100": None if mean_p is None else round((mean_p + 1) * 50, 1),
            "p_sd": _sample_sd(p_values), "items": len(items),
            "top_consistency": _mean([item["top_consistency"] for item in items]),
            "full_consistency": _mean([item["full_consistency"] for item in items]),
            "negative_label": first["negative_label"], "positive_label": first["positive_label"],
            "l1_top_rate": top_counts["L1"] / total_top,
            "l2_top_rate": top_counts["L2"] / total_top,
            "l3_top_rate": top_counts["L3"] / total_top,
            "score_family": first["score_family"],
        })

    domains: list[dict[str, Any]] = []
    for key, items in domain_groups.items():
        ps = [item["mean_p"] for item in items if item["mean_p"] is not None]
        if not ps:
            continue
        first = items[0]
        mean_p = _mean(ps)
        domains.append({
            "model": key[0], "bank_id": key[1], "category_id": key[2],
            "category": first["category"], "domain": key[3], "mean_p": mean_p,
            "score_0_100": round((mean_p + 1) * 50, 1), "sd": _sample_sd(ps), "items": len(items),
        })

    repetitions = int(project.get("repetitions") or 1)
    selected_banks = list(project.get("bank_ids") or [])
    coverage: list[dict[str, Any]] = []
    for model in model_labels:
        for bank in selected_banks:
            planned_items = BANK_META.get(bank, {}).get("rows", 0)
            items = [item for item in item_summaries if item["model"] == model and item["bank_id"] == bank]
            threshold = 4 if repetitions >= 5 else repetitions
            complete_items = sum(item["valid_repeats"] >= threshold for item in items)
            ratio = complete_items / planned_items if planned_items else 0
            coverage.append({
                "model": model, "bank_id": bank, "bank": BANK_META.get(bank, {}).get("label", bank),
                "planned_items": planned_items, "complete_items": complete_items,
                "coverage": ratio, "threshold": threshold,
                "ready": repetitions >= 5 and ratio >= 0.8,
            })

    model_quality: list[dict[str, Any]] = []
    for model in model_labels:
        rows = [row for row in all_rows if row["__model_label__"] == model]
        non_technical = [row for row in rows if str(row.get("FinalStatus") or "") != "TECH_ERROR"]
        model_valid = [
            row for row in rows
            if str(row.get("FinalStatus") or "") in VALID_STATUSES and row.get("__logical__")
        ]
        model_first_valid = sum(str(row.get("FirstStatus") or "") == "VALID" for row in non_technical)
        model_repaired = sum(str(row.get("FinalStatus") or "") == "REPAIRED_VALID" for row in rows)
        tech_errors = len(rows) - len(non_technical)
        model_quality.append({
            "model": model,
            "total_records": len(rows),
            "non_technical_records": len(non_technical),
            "valid_records": len(model_valid),
            "valid_rate": len(model_valid) / len(non_technical) if non_technical else 0,
            "first_valid_rate": model_first_valid / len(non_technical) if non_technical else 0,
            "repaired_records": model_repaired,
            "repair_rate": model_repaired / len(non_technical) if non_technical else 0,
            "technical_errors": tech_errors,
            "technical_error_rate": tech_errors / len(rows) if rows else 0,
        })

    stability_details: list[dict[str, Any]] = []
    for model in model_labels:
        for bank in selected_banks:
            items = [item for item in item_summaries if item["model"] == model and item["bank_id"] == bank]
            if not items:
                continue
            top_values = [item["top_consistency"] for item in items if item["top_consistency"] is not None]
            full_values = [item["full_consistency"] for item in items if item["full_consistency"] is not None]
            p_sds = [item["p_sd"] for item in items if item["p_sd"] is not None]
            stability_details.append({
                "model": model,
                "bank_id": bank,
                "bank": BANK_META.get(bank, {}).get("label", bank),
                "items": len(items),
                "mean_top_consistency": _mean(top_values),
                "mean_full_consistency": _mean(full_values),
                "median_top_consistency": _median(top_values),
                "mean_repeat_p_sd": _mean(p_sds),
                "stable_item_rate": sum(value >= 0.8 for value in top_values) / len(top_values) if top_values else None,
            })

    context_effects: list[dict[str, Any]] = []
    context_groups: defaultdict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in domains:
        context_groups[(row["model"], row["bank_id"], row["category_id"])].append(row)
    for key, rows in context_groups.items():
        if len(rows) < 2:
            continue
        values = [float(row["mean_p"]) for row in rows]
        low = min(rows, key=lambda row: row["mean_p"])
        high = max(rows, key=lambda row: row["mean_p"])
        context_effects.append({
            "model": key[0],
            "bank_id": key[1],
            "bank": BANK_META.get(key[1], {}).get("label", key[1]),
            "category_id": key[2],
            "category": rows[0]["category"],
            "domains": len(rows),
            "range": high["mean_p"] - low["mean_p"],
            "sd": _sample_sd(values),
            "minimum_domain": low["domain"],
            "minimum_p": low["mean_p"],
            "maximum_domain": high["domain"],
            "maximum_p": high["mean_p"],
        })

    option_distributions: list[dict[str, Any]] = []
    for model in model_labels:
        for bank in selected_banks:
            rows = [
                row for row in valid_rows
                if row["__model_label__"] == model and row["__bank_id__"] == bank and row.get("__logical__")
            ]
            counts = Counter(row["__logical__"].split(">", 1)[0] for row in rows)
            total = sum(counts.values())
            if not total:
                continue
            option_distributions.append({
                "model": model,
                "bank_id": bank,
                "bank": BANK_META.get(bank, {}).get("label", bank),
                "valid_records": total,
                "l1_top_rate": counts["L1"] / total,
                "l2_top_rate": counts["L2"] / total,
                "l3_top_rate": counts["L3"] / total,
            })

    profile_lookup: defaultdict[str, dict[tuple[str, str], float]] = defaultdict(dict)
    for row in profiles:
        if row["mean_p"] is not None:
            profile_lookup[row["model"]][(row["bank_id"], row["category_id"])] = float(row["mean_p"])

    model_similarity: list[dict[str, Any]] = []
    for left_index, left_model in enumerate(model_labels):
        for right_index, right_model in enumerate(model_labels):
            shared = sorted(set(profile_lookup[left_model]) & set(profile_lookup[right_model]))
            left_values = [profile_lookup[left_model][key] for key in shared]
            right_values = [profile_lookup[right_model][key] for key in shared]
            correlation = 1.0 if left_index == right_index and shared else _pearson(left_values, right_values)
            model_similarity.append({
                "model_a": left_model,
                "model_b": right_model,
                "shared_categories": len(shared),
                "pearson_r": correlation,
                "mean_absolute_difference": _mean(abs(a - b) for a, b in zip(left_values, right_values)),
            })

    category_divergence: list[dict[str, Any]] = []
    divergence_groups: defaultdict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in profiles:
        if row["mean_p"] is not None:
            divergence_groups[(row["bank_id"], row["category_id"])].append(row)
    for key, rows in divergence_groups.items():
        if len(rows) < 2:
            continue
        values = [float(row["mean_p"]) for row in rows]
        low = min(rows, key=lambda row: row["mean_p"])
        high = max(rows, key=lambda row: row["mean_p"])
        by_model = {row["model"]: row["mean_p"] for row in rows}
        category_divergence.append({
            "bank_id": key[0],
            "bank": BANK_META.get(key[0], {}).get("label", key[0]),
            "category_id": key[1],
            "category": rows[0]["category"],
            "models": len(rows),
            "mean_p": _mean(values),
            "sd": _sample_sd(values),
            "range": high["mean_p"] - low["mean_p"],
            "minimum_model": low["model"],
            "minimum_p": low["mean_p"],
            "maximum_model": high["model"],
            "maximum_p": high["mean_p"],
            "model_values": [
                {"model": model, "mean_p": by_model.get(model)} for model in model_labels
            ],
        })

    human = _human_reference(human_dir, valid_rows)
    comparisons: list[dict[str, Any]] = []
    for profile in profiles:
        reference = human.get((profile["bank_id"], profile["category_id"]))
        if not reference:
            continue
        if profile["mean_p"] is not None and reference.get("mean_p") is not None:
            comparisons.append({
                "model": profile["model"], "bank_id": profile["bank_id"],
                "category_id": profile["category_id"], "category": profile["category"],
                "metric": "偏好位置P", "ai": profile["mean_p"], "human": reference["mean_p"],
                "gap": profile["mean_p"] - reference["mean_p"],
                "matched_items": reference["matched_items"], "reference_type": reference["reference_type"],
            })
        elif profile["bank_id"] == "moral_cni" and reference.get("pair_l1_above_l2") is not None:
            related = [row for row in valid_rows if row["__model_label__"] == profile["model"] and row["__bank_id__"] == "moral_cni" and str(row.get("Source_CategoryID") or "") == profile["category_id"]]
            pair_values = []
            for row in related:
                parts = row["__logical__"].split(">")
                if set(parts) == {"L1", "L2", "L3"}:
                    pair_values.append(1.0 if parts.index("L1") < parts.index("L2") else 0.0)
            ai_pair = _mean(pair_values)
            if ai_pair is not None:
                comparisons.append({
                    "model": profile["model"], "bank_id": "moral_cni",
                    "category_id": profile["category_id"], "category": profile["category"],
                    "metric": "L1排在L2之前的比例", "ai": ai_pair,
                    "human": reference["pair_l1_above_l2"],
                    "gap": ai_pair - reference["pair_l1_above_l2"],
                    "matched_items": reference["matched_items"], "reference_type": reference["reference_type"],
                    "exploratory": True,
                })

    human_gap_summary: list[dict[str, Any]] = []
    for model in model_labels:
        rows = [row for row in comparisons if row["model"] == model]
        metric_groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            metric_groups[str(row.get("metric") or "未标注指标")].append(row)
        metric_details: list[dict[str, Any]] = []
        for metric, metric_rows in sorted(
            metric_groups.items(),
            key=lambda item: (0 if item[0] == "偏好位置P" else 1, item[0]),
        ):
            gaps = [float(row["gap"]) for row in metric_rows if row.get("gap") is not None]
            ai_values = [
                float(row["ai"])
                for row in metric_rows
                if row.get("ai") is not None and row.get("human") is not None
            ]
            human_values = [
                float(row["human"])
                for row in metric_rows
                if row.get("ai") is not None and row.get("human") is not None
            ]
            if not gaps:
                continue
            farthest = max(metric_rows, key=lambda row: abs(float(row.get("gap") or 0)))
            metric_details.append({
                "metric": metric,
                "comparisons": len(gaps),
                "mean_gap": _mean(gaps),
                "mean_absolute_gap": _mean(abs(value) for value in gaps),
                "median_absolute_gap": _median(abs(value) for value in gaps),
                "within_0_10_rate": sum(abs(value) <= 0.10 for value in gaps) / len(gaps),
                "profile_correlation": _pearson(ai_values, human_values),
                "largest_gap_category": farthest.get("category") or farthest.get("category_id"),
                "largest_gap": farthest.get("gap"),
            })
        if not metric_details:
            continue
        primary = max(
            metric_details,
            key=lambda row: (row["metric"] == "偏好位置P", row["comparisons"]),
        )
        human_gap_summary.append({
            "model": model,
            **primary,
            "metrics": metric_details,
        })

    insights: list[dict[str, str]] = []
    for model in model_labels:
        directional = [row for row in profiles if row["model"] == model and row["mean_p"] is not None]
        if directional:
            strongest = max(directional, key=lambda row: abs(row["mean_p"]))
            direction = strongest["positive_label"] if strongest["mean_p"] >= 0 else strongest["negative_label"]
            insights.append({"model": model, "title": "最突出的偏好方向", "text": f"{strongest['bank']}的“{strongest['category']}”最突出，整体更靠近“{direction}”一端。"})
            least_stable = min(directional, key=lambda row: row["top_consistency"] if row["top_consistency"] is not None else 1)
            insights.append({"model": model, "title": "重复作答波动", "text": f"“{least_stable['category']}”的首选稳定度相对最低，解读时应同时关注误差范围。"})
        model_domains = [row for row in domains if row["model"] == model]
        ranges: defaultdict[tuple[str, str], list[float]] = defaultdict(list)
        labels: dict[tuple[str, str], str] = {}
        for row in model_domains:
            key = (row["bank_id"], row["category_id"])
            ranges[key].append(row["mean_p"])
            labels[key] = row["category"]
        candidates = [(max(values) - min(values), key) for key, values in ranges.items() if len(values) >= 2]
        if candidates:
            spread, key = max(candidates)
            insights.append({"model": model, "title": "情境敏感度", "text": f"“{labels[key]}”在不同应用情境间的偏好位置差异最大（范围约 {spread:.2f}）。"})

    model_scorecards: list[dict[str, Any]] = []
    quality_by_model = {row["model"]: row for row in model_quality}
    human_by_model = {row["model"]: row for row in human_gap_summary}
    for model in model_labels:
        model_coverage = [row["coverage"] for row in coverage if row["model"] == model]
        model_stability = [row["mean_top_consistency"] for row in stability_details if row["model"] == model]
        model_full_stability = [row["mean_full_consistency"] for row in stability_details if row["model"] == model]
        model_context = [row for row in context_effects if row["model"] == model]
        context_peak = max(model_context, key=lambda row: row["range"], default=None)
        directional = [row for row in profiles if row["model"] == model and row["mean_p"] is not None]
        strongest = max(directional, key=lambda row: abs(row["mean_p"]), default=None)
        model_scorecards.append({
            "model": model,
            "valid_rate": quality_by_model.get(model, {}).get("valid_rate"),
            "first_valid_rate": quality_by_model.get(model, {}).get("first_valid_rate"),
            "repair_rate": quality_by_model.get(model, {}).get("repair_rate"),
            "coverage": _mean(model_coverage),
            "top_consistency": _mean(model_stability),
            "full_consistency": _mean(model_full_stability),
            "profile_coordinates": len(directional),
            "strongest_category": strongest.get("category") if strongest else None,
            "strongest_p": strongest.get("mean_p") if strongest else None,
            "largest_context_category": context_peak.get("category") if context_peak else None,
            "largest_context_range": context_peak.get("range") if context_peak else None,
            "human_mean_absolute_gap": human_by_model.get(model, {}).get("mean_absolute_gap"),
            "human_profile_correlation": human_by_model.get(model, {}).get("profile_correlation"),
            "human_reference_metric": human_by_model.get(model, {}).get("metric"),
        })

    report_findings: list[dict[str, str]] = []
    if category_divergence:
        row = max(category_divergence, key=lambda value: value["range"])
        report_findings.append({
            "label": "模型分歧最大维度",
            "value": row["category"],
            "detail": f"{row['minimum_model']} 到 {row['maximum_model']}，平均P跨度 {row['range']:.2f}",
        })
    unique_pairs = [
        row for row in model_similarity
        if model_labels.index(row["model_a"]) < model_labels.index(row["model_b"])
        and row["pearson_r"] is not None
    ]
    if unique_pairs:
        closest = max(unique_pairs, key=lambda value: value["pearson_r"])
        farthest = min(unique_pairs, key=lambda value: value["pearson_r"])
        report_findings.append({
            "label": "画像最相近模型对",
            "value": f"{closest['model_a']} × {closest['model_b']}",
            "detail": f"共享 {closest['shared_categories']} 个坐标，Pearson r = {closest['pearson_r']:.3f}",
        })
        report_findings.append({
            "label": "画像差异相对较大",
            "value": f"{farthest['model_a']} × {farthest['model_b']}",
            "detail": f"共享 {farthest['shared_categories']} 个坐标，Pearson r = {farthest['pearson_r']:.3f}",
        })
    stability_candidates = [row for row in model_scorecards if row["top_consistency"] is not None]
    if stability_candidates:
        row = max(stability_candidates, key=lambda value: value["top_consistency"])
        report_findings.append({
            "label": "首选重复最稳定",
            "value": row["model"],
            "detail": f"跨题库平均首选一致率 {row['top_consistency'] * 100:.1f}%",
        })
    human_candidates = [row for row in human_gap_summary if row["mean_absolute_gap"] is not None]
    if human_candidates:
        row = min(human_candidates, key=lambda value: value["mean_absolute_gap"])
        report_findings.append({
            "label": "同题人类参照最接近",
            "value": row["model"],
            "detail": f"{row['metric']}平均绝对Gap {row['mean_absolute_gap']:.3f}，共 {row['comparisons']} 个匹配坐标",
        })

    def output_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
        return (
            label_sort_keys.get(str(row.get("model") or ""), model_sort_key(row.get("model"))),
            str(row.get("bank_id") or ""),
            str(row.get("category_id") or ""),
            str(row.get("domain") or ""),
            str(row.get("item_id") or ""),
        )

    item_summaries.sort(key=output_sort_key)
    profiles.sort(key=output_sort_key)
    domains.sort(key=output_sort_key)
    coverage.sort(key=output_sort_key)
    comparisons.sort(key=output_sort_key)
    insights.sort(key=lambda row: (label_sort_keys.get(str(row.get("model") or ""), model_sort_key(row.get("model"))), str(row.get("title") or "")))
    model_quality.sort(key=output_sort_key)
    stability_details.sort(key=output_sort_key)
    context_effects.sort(key=lambda row: (label_sort_keys.get(str(row.get("model") or ""), model_sort_key(row.get("model"))), -float(row.get("range") or 0), str(row.get("bank_id") or ""), str(row.get("category_id") or "")))
    option_distributions.sort(key=output_sort_key)
    human_gap_summary.sort(key=output_sort_key)
    model_scorecards.sort(key=output_sort_key)
    category_divergence.sort(key=lambda row: (-float(row.get("range") or 0), str(row.get("bank_id") or ""), str(row.get("category_id") or "")))

    formal_ready = bool(coverage) and all(row["ready"] for row in coverage)
    return {
        "analysis_version": ANALYSIS_VERSION,
        "project_id": project.get("project_id"),
        "project_name": project.get("name"),
        "mode": project.get("mode"),
        "models": model_labels,
        "bank_meta": BANK_META,
        "selected_banks": selected_banks,
        "quality": {
            "total_records": len(all_rows), "valid_records": len(valid_rows),
            "non_technical_records": len(non_technical_rows),
            "valid_rate": len(valid_rows) / len(non_technical_rows) if non_technical_rows else 0,
            "first_valid_rate": first_valid / len(non_technical_rows) if non_technical_rows else 0,
            "repaired_records": repaired, "repetitions": repetitions,
            "technical_errors": len(all_rows) - len(non_technical_rows),
            "formal_ready": formal_ready,
            "status": "正式分析条件已满足" if formal_ready else "当前结果仅作描述性参考",
        },
        "coverage": coverage,
        "profiles": profiles,
        "domains": domains,
        "model_quality": model_quality,
        "model_scorecards": model_scorecards,
        "stability_details": stability_details,
        "context_effects": context_effects,
        "option_distributions": option_distributions,
        "model_similarity": model_similarity,
        "category_divergence": category_divergence,
        "human_comparisons": comparisons,
        "human_gap_summary": human_gap_summary,
        "report_findings": report_findings,
        "human_status": {
            bank: human.get((bank, "__status__"), {}) for bank in ("ambiguity", "intertemporal", "moral_cni")
        },
        "insights": insights,
        "interpretation_boundaries": [
            "本报告描述模型在本次配置与测评时间下的选择模式，不等同于人格或能力诊断。",
            "人类参照不是标准答案，接近或偏离人类均不表示正确或错误。",
            "四类决策使用不同计分含义，不生成未经验证的统一总分。",
            "道德结果只描述条件化排序行为，不反推标准CNIS潜在心理参数。",
            "跨模型画像相关、维度跨度与情境范围均为描述性指标；没有预登记检验时不解释为统计显著。",
        ],
        "report_method": {
            "profile_unit": "同一模型内先按ItemID汇总重复，再按三级分类形成平均P坐标。",
            "similarity": "仅在两个模型共同具备的三级分类坐标上计算Pearson r，同时报告平均绝对差。",
            "context": "情境敏感度用同一分类不同Domain平均P的最大值减最小值描述。",
            "human": "只显示内容摘要与ItemVersion均严格匹配的同题人类参照；不同量尺分别汇总，不混合计算Gap。",
            "p_value_format": "平台统一保留前导零，例如 p < 0.05；通俗报告不自动生成未预登记的显著性结论。",
        },
    }
