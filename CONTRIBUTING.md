# 贡献指南 / Contributing

感谢你帮助改进 CDPA-LLMs。优先欢迎可复现、范围清晰并保持数据边界的改动。

## 开始之前

1. 从 `main` 创建短生命周期分支。
2. 使用 Python 3.11+；运行时不要新增依赖，除非改动确有必要并在 PR 中解释。
3. 复现问题时使用 `question_banks/` 中的合成样例。
4. 不要提交真实 API Key、`.env`、运行结果、受限题库或参与者数据。
5. 修改行为时增加测试，并同步更新中英文 README 或相关文档。

## 本地检查

```bash
python -m compileall -q app server.py tests
python -m unittest discover -s tests -v
find web -type f -name '*.js' -print0 | xargs -0 -n 1 node --check
```

PR 描述应说明问题、方案、验证结果、隐私/兼容性影响和界面截图（如适用）。统计方法改动还应给出公式、聚合单位、边界条件与对既有结果的影响。

## English

Create a focused branch from `main`, reproduce issues with the synthetic banks, add tests for behavior changes, and update both language entry points when user-facing behavior changes. Do not commit secrets, environments, runtime artifacts, restricted stimuli, or participant data. A pull request should state the problem, approach, verification, privacy/compatibility impact, and screenshots when relevant. Statistical changes must document formulas, aggregation units, edge cases, and impact on previous outputs.
