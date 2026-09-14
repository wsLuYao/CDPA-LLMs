from __future__ import annotations

import re
from typing import Any


PREFERRED_MODEL_ORDER = (
    "Deepseek-v4-flash",
    "Doubao-2.0-pro",
    "Qwen-3.7-flash",
    "Gemini-3.7-flash",
    "GPT-5.6-sol",
    "Grok-4.6",
)


def _normalized(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


_ORDER_TOKENS = tuple(_normalized(value) for value in PREFERRED_MODEL_ORDER)


def model_identity_text(value: Any) -> str:
    """Return the useful identity fields as one string for order matching."""
    if not isinstance(value, dict):
        return str(value or "")
    config = value.get("config") if isinstance(value.get("config"), dict) else {}
    return " ".join(
        str(part or "")
        for part in (
            value.get("label"),
            value.get("model"),
            value.get("provider"),
            config.get("model"),
            config.get("provider"),
            value.get("analysisModelKey"),
            value.get("modelConfig"),
        )
    )


def model_sort_key(value: Any) -> tuple[int, str]:
    """Place the six requested models first and keep all other models stable."""
    identity = model_identity_text(value)
    normalized = _normalized(identity)
    rank = next(
        (index for index, token in enumerate(_ORDER_TOKENS) if token in normalized),
        len(PREFERRED_MODEL_ORDER),
    )
    return rank, identity.casefold()


def sorted_models(values: list[Any]) -> list[Any]:
    return sorted(values, key=model_sort_key)
