# 题库 CSV 契约 / Question-bank CSV contract

[中文](#中文) · [English](#english)

## 中文

公开仓库中的四个 CSV 是无研究结论的合成样例。复制样例并替换内容，是接入自有授权题库最稳妥的方式。

### 必需字段

| 语义 | 支持的表头 | 规则 |
| --- | --- | --- |
| 情境 | `Context`、`Scenario`、`Vignette`、`情境`、`材料` 等 | 非空文本 |
| 问题 | `Question`、`问题`、`提问`、`决策问题` | 非空文本 |
| 三个选项 | `Opt1` / `Opt2` / `Opt3`，也支持 `Option1`、`Choice1`、`选项1` 等 | 必须恰好识别到 1、2、3 三列且均非空 |

文件必须是文本 CSV，支持 UTF-8、UTF-8 BOM 和 GB18030。分隔符可为逗号、制表符或分号。空行会跳过；多余字段、重复表头、NUL 字节和路径越界会被拒绝。

### 推荐元数据

| 字段 | 用途 |
| --- | --- |
| `ItemID` | 稳定题目 ID；缺失时退回物理行号 |
| `GroupID` | 条件或情境分组 |
| `CategoryID`, `Category`, `SecondLevel` | 画像聚合维度 |
| `Domain` | 情境效应分组 |
| `OptionRole` | 例如 `L1=stable;L2=balanced;L3=volatile` |
| `Opt_to_L_Map` | 例如 `opt1=L1;opt2=L2;opt3=L3` |
| `ScoreFamily` | 含 `DIRECTIONAL` 时计算方向性 P 坐标 |
| `ItemVersion` | 用于版本与参照数据匹配 |
| `OptionCount` | 如填写，当前必须为 `3` |

不要在 CSV 中放姓名、联系方式、账号、自由文本作答或密钥。模型请求只使用当前行的情境、问题和三个显示选项；其他元数据进入审计输出，不进入模型提示。

## English

The four bundled CSV files are synthetic and carry no research conclusion. Copy one and replace its content to integrate an authorized bank.

Required semantics are context, question, and exactly three non-empty option columns. Accepted aliases include `Context`/`Scenario`/`Vignette`, `Question`, and numbered `Opt`/`Option`/`Choice` headers. Files may use UTF-8, UTF-8 with BOM, or GB18030, with comma, tab, or semicolon delimiters.

Recommended metadata—`ItemID`, `GroupID`, category fields, `Domain`, logical-option mapping, score family, and item version—supports traceable aggregation. Never place names, contact details, accounts, free-text participant responses, or secrets in a bank. Only context, question, and the three displayed options are sent to a model; metadata is retained for auditing but is not part of the prompt.
