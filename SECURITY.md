# 安全政策 / Security policy

## 报告漏洞

请使用仓库的 **GitHub Security Advisories → Report a vulnerability** 私下报告。不要在公开 Issue 中粘贴 API Key、Cookie、邀请码、账号数据库、原始模型响应、私有题库或参与者数据。

报告请包含受影响版本、最小复现、影响和建议缓解方式。维护者会尽快确认；修复发布前请保持信息私密。

## 部署基线

- 本地模式默认只监听 `127.0.0.1`；不要通过端口映射把它直接暴露到公网。
- 公网使用 `compose.yaml` 与 Caddy 提供 HTTPS，并设置至少 20 位的随机 `CDPA_REGISTRATION_CODE`。
- 配置准确的 `CDPA_TRUSTED_ORIGINS`，限制 SSH 来源，并保持主机、Docker 与 Caddy 更新。
- 对外部模型流量使用出口白名单或可信代理。应用的公网 IP 校验降低 SSRF 风险，但不能替代网络层控制。
- 定期备份并演练恢复；备份包含敏感数据，应加密并限制访问。
- API Key 不持久化，但可能由上游服务商处理。不要使用权限超过当前测评所需范围的 Key。

## English

Report vulnerabilities privately through **GitHub Security Advisories → Report a vulnerability**. Never post keys, cookies, registration codes, account databases, raw private responses, restricted banks, or participant data in a public issue.

Local mode binds to `127.0.0.1` and must not be exposed directly. Internet-facing deployments should use the provided Caddy/Compose stack, HTTPS, a strong registration code, trusted origins, restricted SSH, patched hosts, encrypted backups, and outbound allowlists. In-process key handling reduces persistence risk but does not change the selected provider's data-processing role.
