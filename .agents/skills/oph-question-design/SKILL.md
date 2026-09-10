---
name: oph-question-design
description: 检索文献、找出证据缺口，并把眼科临床科研意图转成可检验、可证伪的研究问题；用于候选课题、PICO/PECO、文献底稿和研究问题冻结。
---

# 眼科研究问题与证据缺口

## 工作顺序

1. 明确预期用途、目标人群、就诊场景、输入模态、比较对象与决策点。
2. 分层检索：系统综述与指南、外部验证研究、代表性方法、近两年同题工作。每条记录 DOI/PMID/URL、年份、队列规模、模态、主要指标、适用边界；只有摘要时 readingDepth 写 abstract。
3. 建证据缺口表。每一行：缺口描述 · 已有工作为什么没填上 · 填上它需要的数据/标签/方法 · 现有数据能否支持（对照数据清单）· 与目标刊会的匹配度。
4. 从缺口表提出 2-3 个候选课题，每个用 PICO/PECO 写出主要问题，区分诊断、预后、筛查、分割、质量控制或生成任务；预先定义主要假设、主要终点、失败条件和不可回答的问题。
5. 输出 `research/research_question.yaml` 与文献证据表，供方案统计员综合。搜索摘要只能用于导航，不能替代原文证据。

## 常见跑偏

- 把「没搜到」写成「没有人做过」：缺口必须写明检索式与检索日期。
- 用引用数代替相关性：高引用但人群、模态或终点不同的工作只作背景。
- 候选课题的主要终点在现有数据里没有标签：这一条要在缺口表里写明，不能留到方案阶段才发现。

## 最小字段

`intended_use`、`population`、`setting`、`index_test`、`comparator`、`outcomes`、`primary_hypothesis`、`exclusions`、`evidence_gaps`（数组，每项含 `gap`、`why_open`、`requires`、`data_support`）、`candidates`（数组，每项含 `title`、`pico`、`primary_endpoint`、`falsifier`）、`decision_log`。
