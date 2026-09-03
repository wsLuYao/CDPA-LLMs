# CDPA-LLMs

<p align="center">
  <strong>大语言模型综合决策偏好测评工具</strong><br>
  Comprehensive Decision-Making Preference Assessment for LLMs
</p>

<p align="center">
  <strong>V1.0</strong>
</p>

---

## 项目简介

**CDPA-LLMs** 是一个面向大语言模型（Large Language Models, LLMs）的决策偏好自动化测评平台。平台将题库管理、模型 API 接入、批量施测、响应解析、运行恢复、数据质量检查、通俗报告、专业统计和结果导出整合在同一套 Web 工作流中，用于记录和比较不同模型在标准化决策任务中的输出偏好。

V1.0 默认正式测评覆盖 **风险决策、模糊决策、跨期决策和道德决策（CNI-Conflict）** 四类任务，共 **936 个正式测量条件**。平台以情境化材料和三选项完整排序任务为主要作答形式，并支持独立重复施测、情境域分析、模型相似性分析以及严格版本匹配的人类参照。

> CDPA-LLMs 测量的是模型在特定题库、提示词、接口参数和运行条件下产生的决策输出，不应被解释为模型的稳定人格、临床特征或总体能力排名。

---

## 核心特性

- **一站式测评流程**：项目创建 → 题库选择 → 模型配置 → 连接测试 → 自动施测 → 运行监控 → 报告分析 → 数据导出。
- **四类正式决策题库**：V1.0 共 936 个正式测量条件。
- **多模型统一测评**：单个项目可配置 1–6 个模型，并保持预设显示顺序。
- **多接口适配**：支持 `OpenAI Responses`、`OpenAI-compatible Chat Completions`、`Gemini generate Content`，以及自定义 OpenAI 兼容端点。
- **批量任务控制**：支持并发、请求间隔、超时、技术重试、暂停、继续、安全停止和服务器中断恢复。
- **标准化排序解析**：保留原始响应，区分首次有效、格式修复后有效和技术失败等状态。
- **通俗结果报告**：提供数据质量、模型画像、情境效应、重复稳定性、模型相似性和人类参照等结果。
- **专业统计工作区**：提供 P、E、D、FACTORIAL、效应量、ICC、DBWVR、映射审计等分析模块。
- **账号与项目隔离**：线上模式支持邀请码注册、登录、会话、CSRF 防护和不同账号间项目隔离。
- **容器化部署**：提供 Docker Compose、Caddy 自动 HTTPS、健康检查、持久数据卷、诊断和备份脚本。
- **本地直接运行**：核心应用仅依赖 Python 标准库，无需额外安装 Python 第三方依赖。

---

## 正式测评范围

| 决策类型 | 正式测量条件 |
| --- | ---: |
| 风险决策 | 600 |
| 模糊决策 | 90 |
| 跨期决策 | 150 |
| 道德决策（CNI-Conflict） | 96 |
| **合计** | **936** |

正式研究方案默认要求每题独立重复 5 次，因此单模型完整运行的基础调用量为：

```text
936 × 5 = 4,680 次调用 / 模型
```

`research_optional/` 中另保留 **MFT 210 题**作为研究扩展材料，但不进入 V1.0 默认正式总览、覆盖门槛和通俗报告。

---

## 工作流程

```text
注册 / 登录
    ↓
创建测评项目
    ↓
选择测评方案与题库
    ↓
设置独立重复次数
    ↓
配置 1–6 个模型
    ↓
测试模型连接
    ↓
设置运行参数
    ↓
启动前确认
    ↓
自动批量施测
    ↓
暂停 / 继续 / 安全停止 / 恢复
    ↓
数据质量与覆盖检查
    ↓
通俗结果报告
    ↓
专业统计分析
    ↓
导出项目与运行数据
```

---

## 模型接口

V1.0 内置以下模型服务预设：

| Provider | 接口模式 | 说明 |
| --- | --- | --- |
| OpenAI / GPT | Responses API | 模型 ID 可按账号权限配置 |
| DeepSeek | Chat Completions | OpenAI 兼容接口 |
| 豆包 / 火山方舟 | Chat Completions | 支持模型 ID 或推理接入点 ID |
| 智谱 GLM | Chat Completions | 智谱开放平台兼容接口 |
| Google Gemini | `generateContent` | Gemini REST 接口 |
| Custom | Chat Completions | 自定义 OpenAI 兼容端点 |
| Demo | Local Mock | 本地确定性演示，不调用外部 API |

模型配置可记录或控制：

```text
Provider
Model / Endpoint ID
API Base URL
API Mode
API Key
Timeout
Max Output Tokens
Temperature
Top-P
Seed
Concurrency
Request Interval
Retry Count
```

线上模式下，自定义 API 端点必须使用 HTTPS，并会阻止指向本机、内网、链路本地或保留地址的端点。

---

## 响应解析与数据质量

平台不会直接把模型原始输出当作统计结果。每次调用先保留原始响应，再进行标准化解析与状态分类。

典型状态包括：

```text
VALID
REPAIRED_VALID
MISSING_OPTION
DUPLICATE_OPTION
TIE
CONFLICT
REFUSAL
PARSE_ERROR
TECH_ERROR
CANCELLED
```

当首次返回仅存在可修复的格式问题时，平台允许一次纯格式修复。格式修复不会改变题目理论内容；首次状态、最终状态、是否修复及原始响应均会保留在运行记录中。

---

## 通俗结果报告

通俗报告优先呈现数据质量和可解释边界，再展示模型偏好结果，主要包括：

- 有效记录、首次格式合格、格式修复、技术失败和题库覆盖；
- 模型综合观察与单模型决策偏好画像；
- 模型 × 三级分类偏好热图；
- 跨模型分歧维度；
- 情境域（Domain）效应与情境敏感维度；
- 首选一致程度、完整排序一致程度和重复稳定性；
- 逻辑首选结构与选项分布；
- 模型间 Pearson 相似矩阵及平均绝对差；
- 严格题目版本匹配下的 AI–Human 同题参照；
- 自动观察和方法说明。

### 偏好位置 P

方向性排序分类使用：

```text
P = [rank(L1) - rank(L3)] / 2
```

P 的理论范围为 `-1` 到 `+1`。前端为提升可读性，可将其映射到 `0–100` 坐标：

```text
Score = 50 × (P + 1)
```

其中 `50` 表示量尺两端相对平衡，不是及格线，也不是能力分。

### 正式就绪门槛

V1.0 的正式研究就绪规则为：

- 每题计划重复至少 5 次；
- 每个所选模型 × 子测验中，至少 80% 的题目达到 4 次有效回答。

未满足条件时，报告应按描述性结果解释。

---

## 专业统计分析工作区

专业统计前端位于：

```text
web/advanced/
```

该工作区与普通用户报告分离，支持完整结果数据的进一步复核与统计分析，包括：

- P 与平均 P；
- E 题组效应与平均 E；
- D；
- FACTORIAL 分析；
- 效应量；
- ICC；
- DBWVR；
- Domain 分析；
- 人类参照分析；
- 质量与映射审计；
- 图表与数据导出。

专业统计指标仅在对应题组、分类、情境、重复和有效记录满足计算条件时显示，不使用推测值补齐不可计算结果。

---

## 人类参照

V1.0 包含同题人类参照数据接口。模型与人类结果只有在以下条件同时满足时才允许进入对应比较：

```text
ItemID 匹配
+ ItemVersion 匹配
+ 题目内容摘要匹配
```

人类样本不是“标准答案”，AI–Human 差异也不等同于错误率。不同量尺的结果不会被混合为同一个 Gap 指标。

---

## 技术架构

```text
┌────────────────────────────────────┐
│              Browser               │
│ HTML5 / CSS3 / Vanilla JavaScript  │
└─────────────────┬──────────────────┘
                  │ HTTPS
                  ▼
┌────────────────────────────────────┐
│               Caddy                │
│ Reverse Proxy / TLS / Compression  │
└─────────────────┬──────────────────┘
                  │
                  ▼
┌────────────────────────────────────┐
│          Python Web Server         │
│                                    │
│ Auth / Projects / Runner           │
│ Providers / Parser / Analysis      │
└───────────────┬───────────────┬────┘
                │               │
                ▼               ▼
      ┌─────────────────┐  ┌──────────────────┐
      │ Persistent Data │  │ External LLM API │
      │ SQLite/JSON/CSV │  │ OpenAI / Gemini  │
      │ JSONL           │  │ Compatible APIs  │
      └─────────────────┘  └──────────────────┘
```

### 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | HTML5 / CSS3 / Vanilla JavaScript |
| 后端 | Python 标准库 HTTP 服务 |
| 账号与会话 | SQLite |
| 项目与运行数据 | JSON / CSV / JSONL |
| 容器 | Docker / Docker Compose |
| HTTPS / 反向代理 | Caddy 2 |
| Docker Python Runtime | Python 3.12 slim |

本地启动脚本要求 **Python 3.10 或更高版本**；官方 Dockerfile 使用 **Python 3.12**。

---

## 项目结构

```text
CDPA-LLMs/
├── app/                         # Python 后端核心模块
│   ├── __init__.py              # 产品与组件版本常量
│   ├── auth.py                  # 账号、会话与 CSRF
│   ├── csv_loader.py            # 题库与 CSV 读取
│   ├── model_order.py           # 模型显示顺序
│   ├── project_manager.py       # 项目管理、导入与下载
│   ├── prompting.py             # 标准化提示词
│   ├── providers.py             # 模型 API 适配
│   ├── public_analysis.py       # 通俗报告分析
│   ├── runner.py                # 批量任务、解析、暂停与恢复
│   └── web_server.py            # HTTP 服务与 API 路由
│
├── web/                         # 普通用户 Web 前端
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── deploy.html              # 可视化部署向导
│   ├── deploy.js
│   ├── deploy.css
│   └── advanced/                # 专业统计分析工作区
│       ├── index.html
│       ├── js/
│       ├── data_banks/
│       ├── human_reference/
│       └── sample_data/
│
├── question_banks/              # V1.0 四套正式冻结题库
├── human_reference/             # 同题人类参照及版本清单
├── research_optional/           # 默认不运行的研究扩展材料
├── projects/                    # 本地项目运行目录
├── results/                     # 本地运行结果目录
├── scripts/                     # 部署、诊断、状态、备份与审计脚本
├── tests/                       # 自动化验收测试
│
├── server.py                    # 服务启动入口
├── Dockerfile                   # 应用镜像
├── compose.yaml                 # Docker Compose 编排
├── Caddyfile                    # HTTPS / 反向代理配置
├── .env.example                 # 线上环境变量模板
├── VERSION.json                 # 产品与内部组件版本信息
├── FREEZE_MANIFEST.json         # V1.0 冻结快照清单
├── V1.0冻结快照说明.md
├── V1.0版本一致性审计报告.md
├── 题库与指标口径.md
└── 硅云部署说明.md
```

---

## 快速开始

### 方式一：本地运行

本地模式适合开发、功能检查和单机研究使用。默认仅监听：

```text
http://127.0.0.1:8765/
```

#### Windows

直接双击：

```text
启动测评平台.bat
```

或在命令行运行：

```powershell
py -3 server.py
```

#### macOS

运行：

```bash
chmod +x 启动测评平台.command
./启动测评平台.command
```

#### Linux

运行：

```bash
chmod +x 启动测评平台.sh
./启动测评平台.sh
```

也可以直接：

```bash
python3 server.py
```

本地模式会自动寻找 `8765–8784` 范围内的可用端口，并默认打开浏览器。

---

## 线上部署

V1.0 推荐使用单台 Linux 云服务器，通过 Docker Compose + Caddy 部署。

推荐环境：

```text
Ubuntu Server 24.04 LTS
2 vCPU / 4 GB RAM 或更高
40 GB SSD 或更高
公网 IPv4
域名
Docker Engine + Compose Plugin
```

详细部署步骤见：

- [`硅云部署说明.md`](./硅云部署说明.md)
- 部署完成后访问 `/deploy.html` 查看可视化部署向导。

### 最短部署流程

```bash
chmod +x scripts/*.sh
sudo ./scripts/install-docker-ubuntu.sh
./scripts/setup.sh
./scripts/doctor.sh
```

`setup.sh` 会引导填写域名和邮箱、生成站点注册邀请码、校验配置并启动服务。

### Docker Compose

手动启动：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
```

查看应用日志：

```bash
docker compose logs -f app
```

查看 Caddy 日志：

```bash
docker compose logs -f caddy
```

停止：

```bash
docker compose stop
```

启动：

```bash
docker compose start
```

> 公网只应开放 `80/443`。应用端口 `8765` 仅在 Docker 网络内部暴露，不应直接开放到互联网。

---

## 环境变量

线上部署使用 `.env`。仓库提供 `.env.example`：

```dotenv
DOMAIN=assessment.example.com
ACME_EMAIL=admin@example.com
CDPA_REGISTRATION_CODE=replace-with-a-long-random-code
CDPA_MAX_ACTIVE_PROJECTS=2
CDPA_MAX_ACTIVE_PER_USER=2
TZ=Asia/Shanghai
```

请勿将真实 `.env`、注册邀请码、账号数据库或 API Key 提交到公开仓库。

### API Key

API Key **不写入 SQLite、项目持久化配置或结果导出文件**，仅用于运行时向用户配置的外部模型接口发起请求。服务器重启后，如需恢复未完成项目，需要重新填写相应模型的 API Key。

---

## 运行输出

每个测评运行会生成核心结构化文件：

```text
排序结果.csv
完整运行记录.csv
原始响应.jsonl
运行摘要.json
```

平台也支持将单次运行或完整项目打包为 ZIP 下载。

### 主要用途

| 文件 | 用途 |
| --- | --- |
| `排序结果.csv` | 标准化排序结果与主要分析字段 |
| `完整运行记录.csv` | 运行参数、解析状态、题目字段和技术信息 |
| `原始响应.jsonl` | 原始模型响应留痕 |
| `运行摘要.json` | 本次运行配置、状态、计数和版本信息 |

原始响应采用追加式保存，技术失败和模型无效回答与有效记录区分处理。

---

## 历史数据导入

平台支持将既有数据重新导入分析工作区，主要支持：

```text
排序结果.csv
+
完整运行记录.csv
```

导入时会检查必要字段、记录对应关系和题库信息。对于正式分析，建议优先使用来源明确的完整项目结果，而不是人工拼接 CSV。

---

## 测试与版本审计

运行 Python 自动化测试：

```bash
python3 -m unittest discover -s tests -v
```

运行 V1.0 版本一致性审计：

```bash
python3 scripts/audit-version-freeze.py
```

检查前端 JavaScript 语法：

```bash
node --check web/app.js
```

V1.0 冻结快照记录的验收结果：

```text
Python tests:      11 / 11 passed
JavaScript syntax: 15 / 15 passed
Python compile:    passed
JSON parse:        passed
Shell syntax:      passed
```

完整说明：

- [`V1.0冻结快照说明.md`](./V1.0冻结快照说明.md)
- [`V1.0版本一致性审计报告.md`](./V1.0版本一致性审计报告.md)

---

## 安全设计

线上模式包含以下安全边界：

- HTTPS 入口与 Caddy 反向代理；
- 公网不直接暴露应用内部端口 `8765`；
- 邀请码限制新账号注册；
- 密码使用 `scrypt` 加盐哈希；
- 会话令牌以摘要形式存入 SQLite；
- Cookie 使用 `HttpOnly`、`SameSite=Lax`，线上模式启用 `Secure`；
- 修改型请求执行 CSRF 校验；
- 用户项目、结果、报告与下载按账号隔离；
- API Key 不持久化到数据库、项目或导出数据；
- 线上自定义 API 端点限制为 HTTPS 公网地址；
- 应用容器使用非 root 用户、只读文件系统、`no-new-privileges` 并移除 Linux capabilities；
- Caddy 默认移除 `Server` 响应头，并设置 HSTS。

---

## 数据持久化与备份

Docker 部署使用持久化数据卷保存账号和项目数据。重新构建应用镜像不会自动删除 `cdpa_data`。

备份：

```bash
./scripts/backup.sh
```

状态和诊断：

```bash
./scripts/status.sh
./scripts/doctor.sh
```

升级或迁移前应先备份持久数据和 `.env`。

---

## 版本说明

V1.0 软件产品版本与内部组件版本分开管理：

| 类型 | V1.0 标识 | 说明 |
| --- | --- | --- |
| 软件产品版本 | `V1.0` | 冻结快照产品版本 |
| Prompt | `P1.0` | 提示词方案 |
| Parser | `parser_v1.1` | 输出解析规则 |
| Public Report | `PUBLIC_REPORT_V2` | 通俗报告数据结构 |
| Analysis Core | `v1.7` 系列 | 专业统计方法实现 |

内部组件版本用于结果复现和数据兼容，不等同于软件产品版本。

冻结快照形成日期：`2026-09-02`。

---

## 使用边界

请注意以下解释原则：

- 不将风险、模糊、跨期和道德决策简单相加为一个“总分”；
- 不将模型测评结果解释为稳定人格、临床特征或个体心理诊断；
- 不把道德三选项完整排序直接反推为标准二元 C / N / I 潜在参数；
- 不把“更接近人类”解释为“更正确”，也不把偏离人类解释为“错误”；
- 模型间比较应保证题库版本、提示词、运行参数、重复次数和数据质量条件具有可比性；
- 外部模型的价格、速率限制、可用性、响应时延和输出质量由相应服务商决定。

本项目用于 **大语言模型决策偏好测评与相关研究**，不是个人心理测评工具，不用于临床诊断、招聘筛选或人格评价。


---

<p align="center">
  <strong>CDPA-LLMs · V1.0</strong><br>
  Copyright华中师范大学心理学院
</p>

