from __future__ import annotations

import csv
import io
import re
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable


class BankValidationError(ValueError):
    """Raised when a question-bank CSV cannot be used safely."""


@dataclass(frozen=True)
class FieldMapping:
    context: str
    question: str
    options: tuple[str, str, str]


@dataclass
class QuestionItem:
    source_file: str
    source_row: int
    context: str
    question: str
    options: tuple[str, str, str]
    metadata: dict[str, str]

    @property
    def item_id(self) -> str:
        for key in ("ItemID", "item_id", "ID", "id"):
            value = (self.metadata.get(key) or "").strip()
            if value:
                return value
        return f"row_{self.source_row}"

    @property
    def group_id(self) -> str:
        return (self.metadata.get("GroupID") or self.metadata.get("ID") or "").strip()


@dataclass
class BankReport:
    filename: str
    encoding: str
    delimiter: str
    row_count: int
    headers: list[str]
    field_mapping: FieldMapping | None
    errors: list[str]
    warnings: list[str]
    category_count: int
    item_version: str

    @property
    def valid(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["valid"] = self.valid
        return payload


def _header_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").strip().lower()
    return re.sub(r"[\s_\-—–:：./\\]+", "", normalized)


CONTEXT_ALIASES = {
    "context",
    "scenario",
    "vignette",
    "material",
    "story",
    "情境",
    "情境材料",
    "小品文",
    "材料",
    "题干",
}
QUESTION_ALIASES = {"question", "promptquestion", "问题", "提问", "决策问题"}


def _option_index(normalized: str) -> int | None:
    patterns = (
        r"opt(?:ion)?([123])",
        r"choice([123])",
        r"选项([123])",
        r"方案([123])",
    )
    for pattern in patterns:
        match = re.fullmatch(pattern, normalized)
        if match:
            return int(match.group(1))
    return None


def resolve_fields(headers: Iterable[str]) -> FieldMapping:
    headers = list(headers)
    normalized: dict[str, list[str]] = {}
    for header in headers:
        normalized.setdefault(_header_key(header), []).append(header)

    def unique_alias(aliases: set[str], label: str) -> str:
        matches: list[str] = []
        for alias in aliases:
            matches.extend(normalized.get(_header_key(alias), []))
        matches = list(dict.fromkeys(matches))
        if not matches:
            raise BankValidationError(f"缺少{label}字段")
        if len(matches) > 1:
            raise BankValidationError(f"{label}字段存在多个候选列：{', '.join(matches)}")
        return matches[0]

    context = unique_alias(CONTEXT_ALIASES, "Context/情境")
    question = unique_alias(QUESTION_ALIASES, "Question/问题")

    options: dict[int, str] = {}
    for header in headers:
        index = _option_index(_header_key(header))
        if index is None:
            continue
        if index in options:
            raise BankValidationError(
                f"选项{index}存在多个候选列：{options[index]}, {header}"
            )
        options[index] = header
    if set(options) != {1, 2, 3}:
        found = ", ".join(str(i) for i in sorted(options)) or "无"
        raise BankValidationError(
            f"必须恰好包含三个选项列（Opt1/Opt2/Opt3），当前识别到：{found}"
        )
    return FieldMapping(context, question, (options[1], options[2], options[3]))


def read_csv_text(path: Path) -> tuple[str, str]:
    raw = path.read_bytes()
    if b"\x00" in raw:
        raise BankValidationError("文件包含 NUL 字节，可能不是文本 CSV")
    attempts = ("utf-8-sig", "utf-8", "gb18030")
    for encoding in attempts:
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    raise BankValidationError("无法按 UTF-8、UTF-8 BOM 或 GB18030 解码")


def _read_rows(path: Path) -> tuple[list[str], list[dict[str, str]], str, str]:
    text, encoding = read_csv_text(path)
    try:
        dialect = csv.Sniffer().sniff(text[:16384], delimiters=",\t;")
        delimiter = dialect.delimiter
    except csv.Error:
        delimiter = ","
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=delimiter)
    headers = list(reader.fieldnames or [])
    if not headers:
        raise BankValidationError("CSV 没有表头")
    if len(headers) != len(set(headers)):
        raise BankValidationError("CSV 存在完全重复的表头")
    rows: list[dict[str, str]] = []
    for physical_row, raw_row in enumerate(reader, start=2):
        if None in raw_row:
            raise BankValidationError(f"第 {physical_row} 行比表头多出字段")
        clean = {str(key): (value or "") for key, value in raw_row.items()}
        if not any(value.strip() for value in clean.values()):
            continue
        clean["__physical_row__"] = str(physical_row)
        rows.append(clean)
    return headers, rows, encoding, delimiter


def inspect_bank(path: Path) -> BankReport:
    errors: list[str] = []
    warnings: list[str] = []
    headers: list[str] = []
    rows: list[dict[str, str]] = []
    encoding = "unknown"
    delimiter = ","
    mapping: FieldMapping | None = None
    try:
        headers, rows, encoding, delimiter = _read_rows(path)
        mapping = resolve_fields(headers)
    except (OSError, csv.Error, BankValidationError) as exc:
        errors.append(str(exc))

    if mapping:
        for row in rows:
            row_no = row.get("__physical_row__", "?")
            required = [mapping.context, mapping.question, *mapping.options]
            blanks = [name for name in required if not (row.get(name) or "").strip()]
            if blanks:
                errors.append(f"第 {row_no} 行必需字段为空：{', '.join(blanks)}")
            declared_option_count = (row.get("OptionCount") or "").strip()
            if declared_option_count and declared_option_count != "3":
                errors.append(
                    f"第 {row_no} 行 OptionCount={declared_option_count}，本工具当前要求三选项"
                )

        item_ids: dict[str, int] = {}
        for row in rows:
            item_id = (row.get("ItemID") or "").strip()
            if item_id:
                item_ids[item_id] = item_ids.get(item_id, 0) + 1
        duplicates = sorted(key for key, count in item_ids.items() if count > 1)
        if duplicates:
            warnings.append(
                "ItemID 存在重复，程序将以“文件名+物理行号”维持唯一性："
                + ", ".join(duplicates[:8])
            )

        groups: dict[str, int] = {}
        declared_counts: dict[str, set[str]] = {}
        for row in rows:
            group = (row.get("GroupID") or row.get("ID") or "").strip()
            if not group:
                continue
            groups[group] = groups.get(group, 0) + 1
            declared = (row.get("ConditionCount") or "").strip()
            if declared:
                declared_counts.setdefault(group, set()).add(declared)
        mismatch_count = 0
        for group, actual in groups.items():
            values = declared_counts.get(group, set())
            if len(values) == 1:
                try:
                    if actual != int(next(iter(values))):
                        mismatch_count += 1
                except ValueError:
                    warnings.append(f"GroupID={group} 的 ConditionCount 不是整数")
        if mismatch_count:
            warnings.append(
                f"{mismatch_count} 个 GroupID 的实际行数与 ConditionCount 元数据不一致；"
                "程序只调用 CSV 中真实存在的行，不会自动生成缺失条件。"
            )

    categories = {
        (row.get("CategoryID") or row.get("Category") or "").strip()
        for row in rows
        if (row.get("CategoryID") or row.get("Category") or "").strip()
    }
    versions = sorted(
        {
            (row.get("ItemVersion") or "").strip()
            for row in rows
            if (row.get("ItemVersion") or "").strip()
        }
    )
    return BankReport(
        filename=path.name,
        encoding=encoding,
        delimiter=delimiter,
        row_count=len(rows),
        headers=headers,
        field_mapping=mapping,
        errors=errors,
        warnings=warnings,
        category_count=len(categories),
        item_version=", ".join(versions) if versions else "未标注",
    )


def load_bank(path: Path) -> tuple[BankReport, list[QuestionItem]]:
    report = inspect_bank(path)
    if not report.valid or not report.field_mapping:
        raise BankValidationError("；".join(report.errors) or "题库校验失败")
    headers, rows, _, _ = _read_rows(path)
    mapping = report.field_mapping
    items: list[QuestionItem] = []
    for row in rows:
        physical_row = int(row.pop("__physical_row__"))
        metadata = {header: row.get(header, "") for header in headers}
        items.append(
            QuestionItem(
                source_file=path.name,
                source_row=physical_row,
                context=row[mapping.context].strip(),
                question=row[mapping.question].strip(),
                options=tuple(row[name].strip() for name in mapping.options),
                metadata=metadata,
            )
        )
    return report, items


def safe_bank_path(bank_dir: Path, filename: str) -> Path:
    if Path(filename).name != filename or not filename.lower().endswith(".csv"):
        raise BankValidationError("题库文件名不合法")
    candidate = (bank_dir / filename).resolve()
    if candidate.parent != bank_dir.resolve():
        raise BankValidationError("题库路径越界")
    if not candidate.is_file():
        raise BankValidationError(f"题库文件不存在：{filename}")
    return candidate


def list_banks(bank_dir: Path) -> list[BankReport]:
    bank_dir.mkdir(parents=True, exist_ok=True)
    return [inspect_bank(path) for path in sorted(bank_dir.glob("*.csv"))]

