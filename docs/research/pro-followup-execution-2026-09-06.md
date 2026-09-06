# Pro 复审后的实施与验收记录

基线 `2f37f36`，依据 [Pro 完整首答及 Anneal 聚焦追问](https://chatgpt.com/c/6a9d3518-1260-83e9-9bdb-1b35be4417d2)。Astra 已读取完整首答，另以实际代码核对风险；Pro 未运行项目，其判断不代替本地与外部验收。Anneal 的待办/阶段增量尚待完整回复，参考事实见同目录对照文档。

本轮产品切片：Web 原准备提案可恢复→实际候选可读与独立代码审阅→单独冻结正式计划→经准入的单 Linux rootless OCI CPU 后端→真实预测与受信复算→另行科学复核→可追溯结果包。无合格后端时仍可准备、审阅、冻结，正式 submit 在服务端拒绝。只开发 Web，普通界面不显示内部 ID/hash；远端 CLI 只作为服务器执行能力。

## 协作与共享契约

Astra 独占 core 公共类型/exports、规范化版本、server/API 装配、human auth、主控 Session/预算、CLI 启动入口与最终 review/合并。两个 GPT-5.6 Terra 在独立 `codex/` 分支 worktree 实现有界工作包，不能共享未提交代码或运行库。root 独立核对与浏览器验收；小范围原测试失败修复另有独立 worktree，不触碰研究域。

第一波不改变 v1/v2/v3 的冻结字节或签名含义：v3 claim、产生 spec、bind 在同一 Store.tx 提交；事务不执行网络，提交后广播。观察仅查询原 Attempt 对应 key，unknown 不重新 submit。authority 清理持久化原因、起始/升级时刻与阶段，重启从原时刻恢复，不因重复 pump 延后 KILL。身份不明保留待核对，不能假报停止或误杀 PID。

后续新增契约先经 Astra 冻结，再派实现：

- `CandidateExecutionPlan`：候选回执/代码 manifest、packager、入口 argv/cwd、固定镜像 digest/依赖锁、冻结科学方案和数据快照、输出/评价器、实际资源/时限、目标 authority/epoch/准入策略；状态和租约不进 planHash。
- 不可变 `CodeReviewRecord` 与独立 `candidate_execution` 批准：代码审阅不等于执行批准，不复用准备审批；展示名称/修订绑定真实对象。
- 派发 `not_sent → sending → acknowledged/observation_unknown`；只有从未进入发送的持久状态可首次发送。unknown 仅查询；同 key 取消墓碑及 authority epoch 防迟到提交和空库误证。
- 观察身份使用 instance/lease/fence，不能只凭 PID；执行期限由独立 authority 管理。
- 同一本账增加费用证据/人工结算批准/结算，准入占用为已结算支出加未结算项的 max(预留,已知实际)。未知不能归零；已知超支阻止新增支出；科学上下文与财务额度版本分离，历史哈希不重写。
- 统一科学发布门槛：明确 supported 的当前结果及精确主张映射，不以模型调用 done 代替支持；自由正文保持草稿，结构化结果包与科学/人类决定分开。

## 工作包与顺序

| 波次/工作 | 所有者与文件边界 | 必要交付/负例 | 当前状态 |
|---|---|---|---|
| 0 部署执行禁用 | Astra：server、deployment-governance 测试 | allowDaemon=false 且仅配置CLI准备，两种authority/SSH注入均启动拒绝 | 已修改，相关测试通过，待提交 |
| 1 W1 原子v3与持续观察 | Terra：cli-preparation-controller/tests，必要store测试 | claim后bind前失败回滚；丢响应同意图同Attempt；恢复后running→completed无需重复点击；不重投 | 独立分支实现中 |
| 1 W2a 持久清理 | Terra：job-daemon/worker/tests | 先cancel_requested或completion_requested再crash，重启自动恢复清理；宽限不重置；PID错配不杀 | 独立分支实现中 |
| 1后半 控制收尾 | W1/Astra | 取消与完成竞态可终结且晚到产物隔离；撤销已消费批准持久请求停止；旧无spec记录保守恢复；墓碑epoch | 待首批接口合并后实施 |
| 1后半 费用/科学hash/发布 | W1/Astra | 结算精确绑定原对象，超支与并发预留；加预算不污染新科学来源；非Pattern同样要求supported | 待冻结兼容契约 |
| 2 W3a Web原动作恢复/候选审阅 | Terra Web/controller窄API | 弹窗关闭、刷新、已批准待提交、响应丢失均继续原对象；候选内容与diff可读；单独审阅/冻结与拒绝理由 | 待恢复投影稳定，吸收Anneal增量 |
| 2 W2b 单Linux v4 | Terra authority/packager/OCI/collector/evaluator；Astra公共契约 | 独立物化synthetic快照，完整entry.py、拒绝非空patch，digest镜像无联网安装；有界预测，受信真值复算 | 待正式契约与Linux验收环境；不准入 |
| 3 W3b 科学review/结果包/来源/通知 | Terra + Astra装配 | 独立reviewer配置与输入；结构化表图/主张/局限；真实来源快照；可选飞书服务受理回执，不宣称已读 | 待前置证据；外部调用仍未授权执行 |
| 横向 目标循环/主控预算 | Astra commands/run-control/Session | controller-only不得进入无模型完成出口的无限goal；独立暂停、次数/预算、隐式摘要纳入范围 | 待窄契约裁决 |
| 横向 Web文件版本保护 | 后续Terra：files/API/Web契约 | 必需expectedContentHash；同mtime外部变更拒绝；应用内保存串行；冲突保留，不宣称对任意外部进程原子CAS | root已复现数据丢失，待实施 |
| 横向 原6测试诊断 | root独立分支/Astra review | Python正确解释器且字节断言保留；probe_url真实HTTP/清理；Git HEAD.lock/worktree；DNS确定性resolver；缺git独立定位 | root处理已确认的小范围项目，其余保留诊断 |

## L/R 验收与准入

**L 本机工程验收**：旧快照/签名/哈希、原子账本、API/独立签署、Web可恢复动作、已知安全fixture进程、预测契约与复算负例、无合格后端的服务端拒绝。仅 L 通过不能启用正式实验。

**R 指定环境准入**：Linux rootless OCI + 实际 cgroup v2/systemd委派；真实镜像/挂载替换、越界文件/网络、CPU/内存/pids/tmpfs/日志压力、daemon停机跨期限、容器身份与清理、实际计算成功超过600000ms。准入证据绑定配置与实现版本，单独提交开启。实际SSH、外部CLI、独立review模型、飞书每项分别记录未测/通过，不拿fixture替代。

首轮正式能力限制为单设备单槽CPU、管理员固定镜像、合成数据、完整Python入口、有界结构化预测；无患者数据、自动patch、宿主shell、任意Dockerfile、联网pip、GPU、多机改投和无限迭代。标签/划分从受信冻结快照取得，evaluator不import候选或反序列化可执行对象。runtime上限完整贯穿计划、批准、spec和authority；sleep、65秒计算、被超时杀死均不是>10分钟成功耐久。

后续 P1 全文适配/有界自动迭代/完整期刊稿件和 P2 行为评测、人审晋级回滚、多设备调度依赖真实正式运行与科学证据；文档候选保存不构成晋级。
