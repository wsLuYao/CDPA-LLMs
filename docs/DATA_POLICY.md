# 数据与隐私政策 / Data and privacy policy

[中文](#中文) · [English](#english)

## 中文

本项目默认把以下内容视为敏感数据：API Key、账号数据库、注册邀请码、模型原始响应、运行日志、项目导出、自有/受限题库和任何参与者衍生数据。`.gitignore` 已覆盖默认运行目录，但提交前仍应人工检查。

建议部署者遵循：

1. 只收集完成明确目的所需的最少字段，并为研究数据建立独立的同意、访问和删除流程。
2. 将 `CDPA_DATA_DIR` 指向受访问控制和加密保护的存储，不要使用仓库目录保存生产数据。
3. 根据服务商政策评估题目与提示词是否可外发；需要保密时使用经过批准的本地端点。
4. 为 `results/`、`projects/`、`auth/` 和备份设置保留期限，测试结束后安全清理。
5. 分享问题时只使用合成样例；不要上传原始响应或完整环境文件。
6. 人类参照数据必须经过批准、去标识化，并以 `ItemID`、`ItemVersion` 与内容摘要严格匹配，不能把不同题目误作同题比较。

公开版没有遥测、广告或外部前端脚本。选择真实模型服务商时，浏览器把配置发送到自托管后端，后端再向该服务商发起请求；服务商是独立的数据处理方。

## English

Treat API keys, account databases, registration codes, raw model responses, run logs, exports, restricted banks, and all participant-derived records as sensitive. The default `.gitignore` covers runtime locations, but a human review is still required before every release.

Collect the minimum data required for a documented purpose; store production data outside the repository on access-controlled, encrypted storage; evaluate each provider before sending stimuli; apply retention and deletion schedules; and use only synthetic samples in public reports. Human-reference data requires approval, de-identification, and exact item/version/content-digest matching.

The public frontend contains no telemetry, ads, or third-party scripts. When a real provider is configured, the self-hosted backend sends the selected stimulus to that provider, which remains an independent data processor under its own terms.
