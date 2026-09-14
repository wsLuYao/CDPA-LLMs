from __future__ import annotations

import itertools
import random
import re
from dataclasses import dataclass


SYSTEM_PROMPT = """你是决策偏好测评中的独立作答模型。请基于给定情境与问题，将三个选项按你选择的可能性从大到小作完整排序。

硬性规则：
1. 只能输出 opt1、opt2、opt3 的一种完整排列；
2. 只能使用半角大于号 > 连接；
3. 三个标签必须各出现一次，不得遗漏、重复或并列；
4. 不得输出解释、理由、前后缀、引号、句号、代码块或任何其他文字。

输出语法必须为 optX>optY>optZ，其中 X、Y、Z 是 1、2、3 的不重复排列。"""

FORMAT_REPAIR_PROMPT = (
    "你的回答未形成包含3个方案且不重复的完整排序。"
    "请仅按 optX>optY>optZ 的格式重新输出，其中 X、Y、Z 是1、2、3的不重复排列。"
    "不要添加解释或其他字符。"
)

ORDER_PATTERN = re.compile(r"^opt([123])>opt([123])>opt([123])$")
ALL_PERMUTATIONS = tuple(itertools.permutations((1, 2, 3)))


@dataclass(frozen=True)
class Presentation:
    display_options: tuple[str, str, str]
    display_to_source: tuple[int, int, int]
    permutation_id: str


def build_user_prompt(context: str, question: str, options: tuple[str, str, str]) -> str:
    return (
        f"情境：\n{context}\n\n"
        f"问题：\n{question}\n\n"
        "选项：\n"
        f"opt1：{options[0]}\n"
        f"opt2：{options[1]}\n"
        f"opt3：{options[2]}\n\n"
        "请严格按规定格式输出排序。"
    )


def initial_messages(context: str, question: str, options: tuple[str, str, str]) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_prompt(context, question, options)},
    ]


def repair_messages(
    context: str,
    question: str,
    options: tuple[str, str, str],
    invalid_response: str,
) -> list[dict[str, str]]:
    messages = initial_messages(context, question, options)
    messages.append({"role": "assistant", "content": invalid_response[:1000]})
    messages.append({"role": "user", "content": FORMAT_REPAIR_PROMPT})
    return messages


def parse_ranking(raw: str) -> str | None:
    candidate = (raw or "").strip()
    match = ORDER_PATTERN.fullmatch(candidate)
    if not match:
        return None
    values = match.groups()
    if set(values) != {"1", "2", "3"}:
        return None
    return candidate


def invalid_status(raw: str) -> str:
    text = (raw or "").strip().lower()
    refusal_tokens = ("抱歉", "无法", "不能协助", "拒绝", "sorry", "cannot", "can't comply")
    if any(token in text for token in refusal_tokens):
        return "REFUSAL"
    if "=" in text or "并列" in text or "tie" in text:
        return "TIE"
    labels = re.findall(r"opt[123]", text)
    if labels:
        if len(labels) < 3:
            return "MISSING_OPTION"
        if len(set(labels)) < len(labels):
            return "DUPLICATE_OPTION"
        if len(labels) > 3:
            return "CONFLICT"
    return "PARSE_ERROR"


def presentation_for(
    options: tuple[str, str, str],
    permutation: tuple[int, int, int],
) -> Presentation:
    display = tuple(options[index - 1] for index in permutation)
    return Presentation(
        display_options=display,
        display_to_source=permutation,
        permutation_id="P" + "".join(str(index) for index in permutation),
    )


def choose_permutation(mode: str, rng: random.Random) -> tuple[int, int, int]:
    if mode == "original":
        return (1, 2, 3)
    if mode == "random":
        return rng.choice(ALL_PERMUTATIONS)
    raise ValueError(f"不支持的选项位置模式：{mode}")


def canonical_ranking(ranking: str | None, mapping: tuple[int, int, int]) -> str:
    if not ranking:
        return ""
    labels = ranking.split(">")
    canonical: list[str] = []
    for label in labels:
        display_index = int(label[-1])
        canonical.append(f"opt{mapping[display_index - 1]}")
    return ">".join(canonical)

