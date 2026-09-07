---
name: oph-question-design
description: 将眼科临床科研意图转成可检验、可证伪并可检索证据的研究问题；用于问题建模、PICO/PECO、文献底稿和研究问题冻结。
---

# 眼科研究问题与证据检索

## 工作顺序

1. 明确预期用途、目标人群、就诊场景、输入模态、比较对象与决策点。
2. 用 PICO/PECO 写出主要问题，区分诊断、预后、筛查、分割、质量控制或生成任务。
3. 预先定义主要假设、主要终点、失败条件和不可回答的问题，避免看过结果后改题。
4. 分层检索系统综述、指南、外部验证研究和代表性方法；每条结论记录 DOI/PMID/URL、年份、队列与适用边界。
5. 输出 `research/research_question.yaml` 和文献证据表。搜索摘要只能用于导航，不能替代原文证据。

## 最小字段

`intended_use`、`population`、`setting`、`index_test`、`comparator`、`outcomes`、`primary_hypothesis`、`exclusions`、`evidence_gaps`、`decision_log`。
