# MLflow / DVC 只读跟踪接口取证

## 进度看板

- 2026-09-05：固定源码取证完成；Runner 侧适配器通过独立 Astra 审查。实际 worker → 同一 Attempt/JobSpec → 产物/收据 → EvidencePack 已通过源代码测试，整条消费链独立审查通过。
- 实现：`packages/server/src/research/tracking-adapters.ts`。真实 loopback HTTP 与隔离 Git 测试 3 项、19 个断言通过。审查复现的继承 `GIT_DIR` 替换配置仓库问题已修复：子进程过滤继承的 `GIT_*` 配置并核验真实仓库根，原探针现被拒绝。
- 外部未验证：没有连接实际机构 MLflow 服务或患者数据仓库，没有安装 MLflow/DVC 或下载其数据。

## 固定来源与接口

MLflow 固定提交为 [`30c859dfa15d0454f98f100c2ad6ea5cf6f86ad5`](https://github.com/mlflow/mlflow/commit/30c859dfa15d0454f98f100c2ad6ea5cf6f86ad5)。`mlflow/protos/service.proto` 第 461 行定义 `/mlflow/runs/get`，第 3616–3628 行定义 GetRun 的 `run_id` 和 `run` 响应；`mlflow/utils/rest_utils.py` 第 71 行定义 `/api/2.0` 前缀。实际查询为 `GET /api/2.0/mlflow/runs/get?run_id=...`。

同一 proto 第 3120–3149 行显示 params 的值是字符串，RunData 还含 metrics 和 tags；第 3215 行含 `artifact_uri`。这些字段不是天然安全的聚合结果。因此适配器仅按启动时固定的名称和数值范围提取 metrics 与数值 params，不回传原始 run 名称、tags、storage URI、原始响应或 run_id，也不提供 artifact 下载入口。缺失数值为 null，供应商报告值标为 `provider-reported`，不能当作独立复算结论。

原 `iterative/dvc` 仓库已重定向到 `treeverse/dvc`；固定提交为 [`56e59829512ff134aa269099a2099587b810b4dd`](https://github.com/treeverse/dvc/commit/56e59829512ff134aa269099a2099587b810b4dd)。`dvc/api/data.py` 第 28–58 行说明 `get_url` 返回存储地址、默认 HEAD 且接受可变 branch/tag；它不证明远端文件存在。第 102、305 行的 open/read 会读取数据，不能用作本地安全摘要接口。`dvc/stage/serialize.py` 第 195 行定义 lockfile 序列化。

本项目采用更窄的元数据动作：在已配置的 Runner 仓库中，验证完整 Git commit，并读取该 commit 的 `dvc.lock` 原始字节计算 SHA256。工作区的未提交 lock 修改不进入该引用。结果只包含不透明应用引用、commit、锁文件 hash/长度和 `git-lock-bytes` 校验类型；不调用 DVC 数据下载，不返回锁文件中的路径。这个校验不证明 DVC 数据对象存在、其内容完整或科研结论正确。

## 部署与信任边界

读取 MLflow 完整响应的过程必须发生在可信远端 Runner 内，再把筛选后的聚合交给本地。不能将本模块直接装配为本地临床 MLflow 代理，否则就是先把原始元数据带回本地再过滤。只读、白名单和数值范围也不等于匿名化证明；准许的指标应来自机构批准的输出合同。

source URL、认证信息、runId、仓库路径和字段规则由可信启动/已批准作业装配，不能由模型任意替换。工厂捕获配置后只暴露无参数 collect 调用。`--research-tracking` 目前只允许 synthetic 配置；子进程经 stdin 接收配置，不把凭证写入 JobSpec、命令参数或产物。执行审批、Attempt 和 JobSpec 绑定相同 trackingPolicyHash；需要审批时，不含该 hash 的旧批准在任何来源访问前被拒绝。

`runner-tracking.test.ts` 的真实 worker/HTTP/Git 验证共 3 项测试、30 个断言通过。`scripts/research-evaluation-smoke.ts --training --tracking` 的实际 HTTP 链通过：MLflow 只请求一次，DVC 读取固定提交，重放不重查，返回同一产物且策略失效/篡改被拒绝。回执 `.tmp/research-evaluation-smoke/run-qUFvqd/receipt.json` 的 SHA256 为 `4315351bbf1c2a13c789266dab8cf07f0213589254319d303111b17773611859`。这些是本机合成环境的跨进程证据；compiled 图像+tracking 验证已通过，见最终交付回执；机构部署仍须外部验收。

取证原文保存在 `.tmp/pro-review-2026-09-05/full-plan/tracking-evidence/`，`source-manifest.json` 记录固定 URL、字节长度与 SHA256；文件使用 `.source.txt` 后缀，未执行第三方源码。适配器是本项目的实现，没有把所读第三方实现复制到产品中。
