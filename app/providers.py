from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Any

from . import APP_VERSION


PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "openai": {
        "label": "OpenAI / GPT",
        "api_mode": "responses",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-5.6",
        "model_label": "模型 ID",
        "model_placeholder": "例如 gpt-5.6",
        "note": "使用 OpenAI Responses API；模型 ID 可按账号权限修改。",
    },
    "deepseek": {
        "label": "DeepSeek",
        "api_mode": "chat",
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-flash",
        "model_label": "模型 ID",
        "model_placeholder": "例如 deepseek-v4-flash",
        "note": "使用 OpenAI 兼容 Chat Completions 接口。",
    },
    "doubao": {
        "label": "豆包 / 火山方舟",
        "api_mode": "chat",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "model": "",
        "model_label": "模型或推理接入点 ID",
        "model_placeholder": "例如 ep-xxxxxxxx，或账号支持的模型 ID",
        "note": "请填写方舟控制台中的推理接入点 ID；部分新接口也支持直接填写模型 ID。",
    },
    "glm": {
        "label": "智谱 GLM",
        "api_mode": "chat",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model": "glm-5.3",
        "model_label": "模型 ID",
        "model_placeholder": "例如 glm-5.3",
        "note": "使用智谱开放平台 Chat Completions 接口。",
    },
    "gemini": {
        "label": "Google Gemini",
        "api_mode": "gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "model": "gemini-3.7-flash",
        "model_label": "模型 ID",
        "model_placeholder": "例如 gemini-3.7-flash",
        "note": "使用 Gemini generateContent REST 接口。",
    },
    "custom": {
        "label": "自定义 OpenAI 兼容端点",
        "api_mode": "chat",
        "base_url": "",
        "model": "",
        "model_label": "模型 / 接入点 ID",
        "model_placeholder": "填写服务商要求的 model 值",
        "note": "适用于其他 OpenAI Chat Completions 兼容平台或本地代理。",
    },
    "demo": {
        "label": "本地演示（不调用 API）",
        "api_mode": "mock",
        "base_url": "local://demo",
        "model": "demo-deterministic-v1",
        "model_label": "演示模型",
        "model_placeholder": "无需修改",
        "note": "只用于检查流程与导出文件，不能作为研究数据。",
    },
}

HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
BLOCKED_HEADER_NAMES = {"host", "content-length", "transfer-encoding", "connection", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"}
ENDPOINT_VALIDATION_TTL_SECONDS = 60.0
_ENDPOINT_VALIDATION_CACHE: dict[tuple[str, int], float] = {}
_ENDPOINT_VALIDATION_LOCK = threading.Lock()


def _online_mode() -> bool:
    return os.environ.get("CDPA_ONLINE", "").lower() in {"1", "true", "yes"}


def _validate_public_endpoint(parsed: urllib.parse.SplitResult) -> None:
    host = parsed.hostname or ""
    if parsed.scheme != "https":
        raise ValueError("线上模式只允许 HTTPS API 端点")
    if host.lower() == "localhost" or host.lower().endswith(".local"):
        raise ValueError("线上模式不允许访问本机或内网 API 端点")
    port = parsed.port or 443
    cache_key = (host.lower(), port)
    now = time.monotonic()
    with _ENDPOINT_VALIDATION_LOCK:
        if _ENDPOINT_VALIDATION_CACHE.get(cache_key, 0.0) > now:
            return
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("API Base URL 的域名暂时无法解析") from exc
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address[4][0])
        except ValueError:
            raise ValueError("API Base URL 解析结果不合法") from None
        if not ip.is_global:
            raise ValueError("线上模式不允许访问本机、内网、链路本地或保留地址")
    with _ENDPOINT_VALIDATION_LOCK:
        _ENDPOINT_VALIDATION_CACHE[cache_key] = now + ENDPOINT_VALIDATION_TTL_SECONDS


class ApiError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str = "API_ERROR",
        retryable: bool = False,
        retry_after: float | None = None,
        response_body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable
        self.retry_after = retry_after
        self.response_body = response_body


@dataclass
class ProviderConfig:
    provider: str
    api_key: str
    model: str
    base_url: str
    api_mode: str
    timeout_sec: float = 60.0
    max_output_tokens: int = 256
    send_sampling: bool = True
    temperature: float | None = 0.0
    top_p: float | None = 1.0
    seed: int | None = None
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer "
    extra_headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ProviderConfig":
        provider = str(payload.get("provider") or "").strip().lower()
        preset = PROVIDER_PRESETS.get(provider)
        if not preset:
            raise ValueError("未知模型厂商")

        def optional_float(name: str, default: float | None) -> float | None:
            value = payload.get(name, default)
            if value in (None, ""):
                return None
            return float(value)

        seed_value = payload.get("seed")
        config = cls(
            provider=provider,
            api_key=str(payload.get("api_key") or "").strip(),
            model=str(payload.get("model") or preset["model"]).strip(),
            base_url=str(payload.get("base_url") or preset["base_url"]).strip(),
            api_mode=str(payload.get("api_mode") or preset["api_mode"]).strip(),
            timeout_sec=float(payload.get("timeout_sec", 60)),
            max_output_tokens=int(payload.get("max_output_tokens", 256)),
            send_sampling=bool(payload.get("send_sampling", True)),
            temperature=optional_float("temperature", 0.0),
            top_p=optional_float("top_p", 1.0),
            seed=int(seed_value) if seed_value not in (None, "") else None,
            auth_header=str(payload.get("auth_header") or "Authorization").strip(),
            auth_prefix=str(payload.get("auth_prefix") if payload.get("auth_prefix") is not None else "Bearer "),
            extra_headers={
                str(key): str(value)
                for key, value in (payload.get("extra_headers") or {}).items()
            },
        )
        config.validate()
        return config

    def validate(self) -> None:
        if self.provider != "demo" and not self.api_key:
            raise ValueError("请输入 API Key")
        if not self.model:
            raise ValueError("请输入模型或接入点 ID")
        if not 5 <= self.timeout_sec <= 600:
            raise ValueError("超时时间应在 5—600 秒之间")
        if not 16 <= self.max_output_tokens <= 4096:
            raise ValueError("最大输出 token 应在 16—4096 之间")
        if self.temperature is not None and not 0 <= self.temperature <= 2:
            raise ValueError("temperature 应在 0—2 之间")
        if self.top_p is not None and not 0 < self.top_p <= 1:
            raise ValueError("top_p 应在 0—1 之间且大于 0")
        if self.api_mode == "mock":
            return
        if len(self.auth_prefix) > 80 or not HEADER_NAME_RE.fullmatch(self.auth_header) or self.auth_header.lower() in BLOCKED_HEADER_NAMES:
            raise ValueError("认证请求头设置不合法")
        for key in self.extra_headers:
            if not HEADER_NAME_RE.fullmatch(key) or key.lower() in BLOCKED_HEADER_NAMES:
                raise ValueError("自定义请求头包含不允许的名称")
        parsed = urllib.parse.urlsplit(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("API Base URL 必须是有效的 http(s) 地址")
        if parsed.username or parsed.password:
            raise ValueError("API Base URL 不能包含用户名或密码")
        if _online_mode():
            _validate_public_endpoint(parsed)
            return
        if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("非本机 API 端点必须使用 HTTPS")

    def public_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload.pop("api_key", None)
        payload["extra_headers"] = {}
        return payload


@dataclass
class ApiCallResult:
    content: str
    raw_response: dict[str, Any]
    extraction_source: str
    model_version: str
    usage: dict[str, Any]
    latency_ms: int
    request_id: str
    endpoint: str


def _endpoint(base_url: str, suffix: str) -> str:
    base = base_url.rstrip("/")
    suffix = suffix.strip("/")
    if base.lower().endswith("/" + suffix.lower()) or base.lower().endswith(suffix.lower()):
        return base
    return f"{base}/{suffix}"


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content", "")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts)
    if isinstance(content, dict):
        text_value = content.get("text")
        if isinstance(text_value, str):
            return text_value
        if isinstance(text_value, dict) and isinstance(text_value.get("value"), str):
            return text_value["value"]
    return ""


def _response_text(data: dict[str, Any], mode: str) -> tuple[str, str]:
    """Extract the assistant answer and record exactly which response field was used.

    Successful provider responses are intentionally allowed to produce an empty string.
    The runner will preserve the full provider JSON and classify/repair the answer as a
    format problem instead of incorrectly turning it into a network/API failure.
    """
    if mode == "responses":
        direct = data.get("output_text")
        if isinstance(direct, str) and direct:
            return direct, "responses.output_text"
        parts: list[str] = []
        for output in data.get("output") or []:
            if not isinstance(output, dict):
                continue
            for content in output.get("content") or []:
                if not isinstance(content, dict):
                    continue
                text_value = content.get("text")
                if isinstance(text_value, str):
                    parts.append(text_value)
                elif isinstance(text_value, dict) and isinstance(text_value.get("value"), str):
                    parts.append(text_value["value"])
                elif isinstance(content.get("refusal"), str):
                    parts.append(content["refusal"])
            if not parts and isinstance(output.get("text"), str):
                parts.append(output["text"])
        if parts:
            return "".join(parts), "responses.output[].content[]"
        return "", "none"
    if mode == "gemini":
        candidates = data.get("candidates") or []
        if not candidates:
            return "", "none"
        parts = ((candidates[0] or {}).get("content") or {}).get("parts") or []
        visible = [
            part.get("text", "")
            for part in parts
            if isinstance(part, dict)
            and isinstance(part.get("text"), str)
            and not part.get("thought", False)
        ]
        if visible:
            return "".join(visible), "gemini.candidates[0].content.parts[].text"
        thought = [
            part.get("text", "")
            for part in parts
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ]
        if thought:
            return "".join(thought), "gemini.candidates[0].content.parts[].thought_text"
        return "", "none"
    choices = data.get("choices") or []
    if not choices:
        return "", "none"
    choice = choices[0] if isinstance(choices[0], dict) else {}
    message = choice.get("message") or {}
    if isinstance(message, dict):
        content = _message_text(message)
        if content:
            return content, "chat.choices[0].message.content"
        refusal = message.get("refusal")
        if isinstance(refusal, str) and refusal:
            return refusal, "chat.choices[0].message.refusal"
        reasoning = message.get("reasoning_content")
        if isinstance(reasoning, str) and reasoning:
            return reasoning, "chat.choices[0].message.reasoning_content"
    legacy_text = choice.get("text")
    if isinstance(legacy_text, str) and legacy_text:
        return legacy_text, "chat.choices[0].text"
    return "", "none"


def _usage(data: dict[str, Any], mode: str) -> dict[str, Any]:
    if mode == "gemini":
        usage = data.get("usageMetadata") or {}
        return {
            "prompt_tokens": usage.get("promptTokenCount"),
            "completion_tokens": usage.get("candidatesTokenCount"),
            "thinking_tokens": usage.get("thoughtsTokenCount"),
            "total_tokens": usage.get("totalTokenCount"),
        }
    usage = data.get("usage") or {}
    return {
        "prompt_tokens": usage.get("input_tokens", usage.get("prompt_tokens")),
        "completion_tokens": usage.get("output_tokens", usage.get("completion_tokens")),
        "total_tokens": usage.get("total_tokens"),
    }


def _error_message(data: Any, fallback: str) -> str:
    if isinstance(data, dict):
        error = data.get("error", data)
        if isinstance(error, dict):
            for key in ("message", "msg", "detail", "code"):
                if error.get(key):
                    return str(error[key])[:1000]
        if isinstance(error, str):
            return error[:1000]
    return fallback[:1000]


def _redact_secret(value: Any, secret: str) -> Any:
    if not secret:
        return value
    if isinstance(value, str):
        return value.replace(secret, "[REDACTED]")
    if isinstance(value, list):
        return [_redact_secret(item, secret) for item in value]
    if isinstance(value, dict):
        return {key: _redact_secret(item, secret) for key, item in value.items()}
    return value


def _http_post(
    endpoint: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout_sec: float,
) -> tuple[dict[str, Any], dict[str, str], int]:
    started = time.perf_counter()
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    opener = urllib.request.build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=timeout_sec) as response:
            raw = response.read()
            response_headers = {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            parsed_body: Any = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            parsed_body = raw.decode("utf-8", errors="replace")[:2000]
        retry_after = None
        try:
            if exc.headers.get("Retry-After"):
                retry_after = float(exc.headers["Retry-After"])
        except (TypeError, ValueError):
            retry_after = None
        retryable = exc.code in {408, 409, 425, 429, 500, 502, 503, 504}
        raise ApiError(
            _error_message(parsed_body, f"HTTP {exc.code}"),
            status=exc.code,
            code=f"HTTP_{exc.code}",
            retryable=retryable,
            retry_after=retry_after,
            response_body=parsed_body,
        ) from None
    except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        raise ApiError(
            f"网络连接失败或超时：{getattr(exc, 'reason', exc)}",
            code="NETWORK_ERROR",
            retryable=True,
        ) from None
    latency_ms = int((time.perf_counter() - started) * 1000)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ApiError(
            f"API 返回了无法解析的 JSON：{exc}",
            code="INVALID_JSON",
            retryable=False,
            response_body=raw.decode("utf-8", errors="replace")[:2000],
        ) from None
    if not isinstance(data, dict):
        raise ApiError("API 返回的顶层 JSON 不是对象", code="INVALID_JSON")
    return data, response_headers, latency_ms


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def _mock_call(config: ProviderConfig, messages: list[dict[str, str]]) -> ApiCallResult:
    prompt = "\n".join(_message_text(message) for message in messages)
    digest = hashlib.sha256(prompt.encode("utf-8")).digest()
    permutations = (
        "opt1>opt2>opt3",
        "opt1>opt3>opt2",
        "opt2>opt1>opt3",
        "opt2>opt3>opt1",
        "opt3>opt1>opt2",
        "opt3>opt2>opt1",
    )
    content = permutations[digest[0] % len(permutations)]
    return ApiCallResult(
        content=content,
        raw_response={"model": config.model, "output_text": content, "demo": True},
        extraction_source="mock.output_text",
        model_version=config.model,
        usage={"prompt_tokens": None, "completion_tokens": None, "total_tokens": None},
        latency_ms=12,
        request_id="demo-" + digest.hex()[:12],
        endpoint="local://demo",
    )


def call_provider(config: ProviderConfig, messages: list[dict[str, str]]) -> ApiCallResult:
    if config.api_mode == "mock" or config.provider == "demo":
        return _mock_call(config, messages)

    if _online_mode():
        _validate_public_endpoint(urllib.parse.urlsplit(config.base_url))

    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": f"CDPA-LLMs-Assessment/{APP_VERSION}",
        **config.extra_headers,
    }
    if config.api_mode == "gemini":
        headers["x-goog-api-key"] = config.api_key
        endpoint = _endpoint(config.base_url, f"models/{urllib.parse.quote(config.model, safe='')}:generateContent")
        system = next(
            (_message_text(message) for message in messages if message.get("role") == "system"),
            "",
        )
        contents = []
        for message in messages:
            if message.get("role") == "system":
                continue
            role = "model" if message.get("role") == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": _message_text(message)}]})
        generation: dict[str, Any] = {
            "maxOutputTokens": config.max_output_tokens,
        }
        if config.send_sampling:
            if config.temperature is not None:
                generation["temperature"] = config.temperature
            if config.top_p is not None:
                generation["topP"] = config.top_p
            if config.seed is not None:
                generation["seed"] = config.seed
        body = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": generation,
        }
    elif config.api_mode == "responses":
        headers[config.auth_header] = config.auth_prefix + config.api_key
        endpoint = _endpoint(config.base_url, "responses")
        system = next(
            (_message_text(message) for message in messages if message.get("role") == "system"),
            "",
        )
        input_messages = [
            {"role": message.get("role", "user"), "content": _message_text(message)}
            for message in messages
            if message.get("role") != "system"
        ]
        body = {
            "model": config.model,
            "instructions": system,
            "input": input_messages,
            "max_output_tokens": config.max_output_tokens,
            "store": False,
        }
        if config.send_sampling:
            if config.temperature is not None:
                body["temperature"] = config.temperature
            if config.top_p is not None:
                body["top_p"] = config.top_p
    else:
        headers[config.auth_header] = config.auth_prefix + config.api_key
        endpoint = _endpoint(config.base_url, "chat/completions")
        body = {
            "model": config.model,
            "messages": messages,
            "max_tokens": config.max_output_tokens,
            "stream": False,
        }
        if config.send_sampling:
            if config.temperature is not None:
                body["temperature"] = config.temperature
            if config.top_p is not None:
                body["top_p"] = config.top_p
            if config.seed is not None:
                body["seed"] = config.seed
    try:
        data, response_headers, latency_ms = _http_post(
            endpoint, headers, body, config.timeout_sec
        )
    except ApiError as exc:
        raise ApiError(
            str(_redact_secret(str(exc), config.api_key)),
            status=exc.status,
            code=exc.code,
            retryable=exc.retryable,
            retry_after=exc.retry_after,
            response_body=_redact_secret(exc.response_body, config.api_key),
        ) from None
    content, extraction_source = _response_text(data, config.api_mode)
    request_id = str(
        response_headers.get("x-request-id")
        or response_headers.get("request-id")
        or data.get("id")
        or ""
    )
    model_version = str(data.get("modelVersion") or data.get("model") or config.model)
    return ApiCallResult(
        content=content,
        raw_response=data,
        extraction_source=extraction_source,
        model_version=model_version,
        usage=_usage(data, config.api_mode),
        latency_ms=latency_ms,
        request_id=request_id,
        endpoint=endpoint,
    )
