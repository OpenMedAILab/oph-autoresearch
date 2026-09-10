---
name: oph-experiment-iteration
description: 用独立模型解读已复核的实验结果，对照文献与方案预期，给出继续迭代或停止的建议、下一步实验增量与失败路线登记；用于 results 阶段的分析节点。
---

# 结果解读与迭代决策

## 输入边界

只读取：冻结方案与实验规格、独立复核员的 claim_evidence_map、run_receipt、脱敏指标与图表、已登记文献与 pitfall_registry。不读取执行者的推理过程；不改动任何已接受的数字。

## 解读顺序

1. 对照预期：每个主要指标与方案里的预期区间、停止规则、文献基线比较，写明差距与方向。
2. 区分来源：真实效应、随机噪声（种子间方差、置信区间宽度）、实现问题（数据加载、标签对齐、拆分泄漏迹象）。证据不足写 unknown。
3. 亚组与失败模式：哪些中心、设备、亚组明显偏离；失败病例的共同特征只用聚合描述。
4. 与已登记失败路线比对：本轮是否重复了 pitfall_registry 里的路线；是则指出并建议停止该方向。

## 迭代决定建议

只输出三种之一，并给依据：

- `accept`：主要假设有证据支持且复核接受，建议进入写作。
- `iterate`：给出「下一步增量」，相对当前方案只改最少的冻结项（如一个消融、一个亚组、一次重复种子），预估资源与时间；每一项写清触发它的证据。
- `stop`：主要假设被证伪或资源已到停止规则，说明哪些负结果值得写进论文。

建议不是决定；人类在检查点裁决。

## 失败路线登记

把本轮验证失败或被推翻的路线追加进 `research/pitfall_registry.yaml`，每条含 `pitfall_id`、`stage`、`trigger`、`evidence`（claim_id 或 run_id）、`impact`、`mitigation`、`status`、`related_artifacts`。已有条目只更新 status，不删除。

## 输出契约

返回一个对象：`decision`（accept | iterate | stop）、`summary`、`findings`（数组：`metric`、`expected`、`observed`、`interpretation`、`confidence`）、`next_experiment`（`iterate` 时必填：`changes`、`rationale`、`estimated_cost`）、`pitfalls_added`、`limitations`。
