# 科研 Skill 候选来源核验

## 执行进度看板

- 日期：2026-09-05；来源字节与许可证已核验，候选未启用、未执行。
- 固定来源：[K-Dense scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills/tree/1e5eeffbdad3749125afe7ab48a39694e27f181c)，commit `1e5eeffbdad3749125afe7ab48a39694e27f181c`。
- 当前进度：已用项目 `source-candidates.ts` 将三项来源映射为不可执行的 SourceSnapshot，并对真实来源字节运行生产校验函数；三项通过，仍为候选。
- 下一步：完成引用脚本、依赖和权限评测后再决定接入；不能从来源文件自行取得权限。

本轮增加静态准入前评测：`curated-skill-evaluation.ts` 在生产代码中先核验实际 SHA256、Git blob SHA1 和字节长度，再检查声明工具、外部凭据、安装命令、远端 shell 管道与引用脚本/支持文件。三份真实来源共生成 32、13、17 项定位记录（含未审查依赖闭包这一基础拒绝项），每项只保留行号和行 hash，不把来源脚本或全文下发产品。结果保存在 `fixtures/curated-skill-evaluations.json`，不在 Skill 自动加载目录；三项均拒绝启用。

这属于静态接入评估，不是执行或行为安全证明。未匹配可疑文本也不能通过：依赖闭包未审查始终保持拒绝。生产只读消费者 `curatedSkillEvaluations()` 验证固定报告 hash 后返回摘要，不给 registry/Runner 授权。自包含惰性文本测试 3 项、15 个断言通过；实际来源评测已运行，独立 Astra 与只读 API 装配待复验。

三份固定报告 hash 按上表来源顺序为 `sha256:84296e32bd1aedd79bda26f318c876c30779a8af9038c8b39bea222b5553d427`、`sha256:e8795c48253ea9f36612b995393834f989e16e7a5f7f151806d9324046622f9d`、`sha256:27f838f7acea52a1711bdbb483bce505f930e4478d14c96e05a6d9e232e50133`。原文引用的脚本未安装、未执行；许可证原文沿用此前已核验记录。

## 已核验的来源

GitHub 连接器读取固定版本文件；将返回文本编码为 UTF-8 后，逐一核对长度和 Git blob SHA1（含 blob 长度头），全部与固定目录元数据一致，然后计算 SHA256。完整来源文本保存在本地 `.tmp/research-candidates/kdense-1e5eeffb/`，使用 `.source.txt` 后缀，不在 `.agents/skills` 自动加载目录。

| 来源路径 | 字节 | SHA256 |
|---|---:|---|
| `skills/hypothesis-generation/SKILL.md` | 15725 | `sha256:8153fdc33e0a4cd012109931c6a822c0e0afe206769e1af3e7a3d07ea37e1137` |
| `skills/statistical-analysis/SKILL.md` | 20915 | `sha256:1b1d63fd667ef454a8e0cadf32457a511883d3308dcc79c47c48bc565d9a23f7` |
| `skills/literature-review/SKILL.md` | 13659 | `sha256:950a6d0863ef657523813b985fe86599ac6bb99b695eee5953612d7e20c78011` |
| `LICENSE.md` | 1068 | `sha256:09b02a3c9df3053c55531d503357a9c7cde275970e6c3ceaa1ddf5f0e90b40c1` |

根 `LICENSE.md` 已读取并保留，MIT，Copyright (c) 2025 K-Dense Inc.。许可证核验不等于依赖/脚本审查完成。候选 manifest 每项均为 `candidate-not-admitted`、`executionEnabled:false`、`dependenciesReviewed:false`，不是正式执行许可。

## 项目合同验证回执

本地脚本 `.tmp/research-candidates/verify-candidates.ts` 实际调用 `snapshotUnadmittedCandidate` 和 `verifyCandidateSourceBytes`，读取上述三份完整来源文件；回执为 `.tmp/research-candidates/kdense-1e5eeffb/source-verification-receipt.json`。三项均返回 `verifiedSourceBytes:true`，同时保留 `candidate-not-admitted` 和 `executionEnabled:false`。这验证了项目合同对这批实际来源的字节匹配，未将候选加入自动加载目录。

Git blob SHA1 与固定提交目录元数据的交叉核验先由来源获取步骤完成。本轮继续实现后，生产函数也独立重算含 `blob <长度>\0` 头的 Git blob SHA1，并核对 SHA256、长度及固定来源结构；随后已重新执行上述脚本，三份真实来源仍全部通过。候选的空依赖、空工具和禁止网络是有效权限声明，不是“来源没有依赖或脚本”的结论。

执行进度：✅ 自测通过 · 主控来源核验 · `e4d3322f19b33c545819b4b5e15a50eaee4c5d33` 加本地增量 · 三项真实来源字节通过，零项启用 · 2026-09-05。

## 真实接入差异

- `literature-review/SKILL.md:4,10-12` 声明 Bash 和 OpenRouter；第224行包含远端安装脚本管道。这些是待审查文本，本任务没有安装或执行，也不能由项目直接继承为运行权限。
- `statistical-analysis/SKILL.md:35-38` 要求额外Python包，第59行允许根据假设检查改换检验；确认性研究需与冻结方案/变更记录对应，不能将探索建议直接作为临床统计执行规范。
- `hypothesis-generation/SKILL.md:241-247` 引用了多个脚本与assets。目前只核验主文档，不能宣称这些依赖已锁定或可执行。
- 三份文件都带额外引用要求；项目输出必须仍按实际研究用途和证据引用，来源文档不能强制注入无关引用。

这是来源快照与接入审计，不是对第三方项目临床效果的评价，也不是已经完成正式Skills供应链的声明。
