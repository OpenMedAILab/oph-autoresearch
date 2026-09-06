# Pro 复审后的实施与验收记录

> 本文件记录截至 `e3503e5` 的上一轮交付；下文“尚未实现”是当时状态。后续有界主控、费用、双目录与正式计划接线的当前状态见 [最新实施记录](bounded-formal-execution-2026-09-06.md)。真实 OCI 环境尚未准入。

基线 `2f37f36`，依据 [Pro 完整首答及 Anneal 聚焦追问](https://chatgpt.com/c/6a9d3518-1260-83e9-9bdb-1b35be4417d2)。Astra 已读取完整首答，另以实际代码核对风险；Pro 未运行项目，其判断不代替本地与外部验收。Anneal 聚焦增量完整回复也已读取并纳入本记录，参考事实见同目录对照文档。

Pro 建议的后续完整路线：Web 原准备提案可恢复→实际候选可读与独立代码审阅→单独冻结正式计划→经准入的单 Linux rootless OCI CPU 后端→真实预测与受信复算→另行科学复核→可追溯结果包。本次交付到准备恢复、候选只读检查、流程观察与手动暂停；候选独立代码审阅和正式计划冻结入口尚未提供，任意候选仍不能正式执行。只开发 Web，普通界面不显示内部 ID/hash；远端 CLI 只作为服务器执行能力。

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
| 0 部署执行禁用 | Astra：server、deployment-governance 测试 | allowDaemon=false 且仅配置CLI准备，两种authority/SSH注入均启动拒绝 | 已合并：两种注入路径均在启动前拒绝 |
| 1 W1 原子v3与持续观察 | Terra：cli-preparation-controller/tests，必要store测试 | claim后bind前失败回滚；丢响应同意图同Attempt；恢复后running→completed无需重复点击；不重投 | 已合并并通过相关恢复/进程清理测试 |
| 1 W2a 持久清理 | Terra：job-daemon/worker/tests | 先cancel_requested或completion_requested再crash，重启自动恢复清理；宽限不重置；PID错配不杀 | 已合并并通过相关恢复/进程清理测试 |
| 1后半 控制收尾 | W1/Astra | 取消与完成竞态可终结且晚到产物隔离；撤销已消费批准持久请求停止；旧无spec记录保守恢复；墓碑epoch | 取消/撤销晚到结果隔离已合并；authority墓碑/epoch已实现，但Attempt尚未绑定epoch，不用于自动释放unknown |
| 1后半 费用/科学hash/发布 | W1/Astra | 结算精确绑定原对象，超支与并发预留；加预算不污染新科学来源；非Pattern同样要求supported | 所有release的supported精确证据门槛已实现；费用结算、已知超支占用与科学hash分离尚未实现 |
| 2 W3a Web原动作恢复/候选审阅 | Terra Web/controller窄API | 弹窗关闭、刷新、已批准待提交、响应丢失均继续原对象；候选内容与diff可读；单独审阅/冻结与拒绝理由 | 原提案继续审批/已审批提交、候选代码与patch只读核验已接Web；独立代码审阅/正式冻结仍待实现 |
| 2 W2b 单Linux v4 | Terra authority/packager/OCI/collector/evaluator；Astra公共契约 | 独立物化synthetic快照，完整entry.py、拒绝非空patch，digest镜像无联网安装；有界预测，受信真值复算 | 待正式契约与Linux验收环境；不准入 |
| 3 W3b 科学review/结果包/来源/通知 | Terra + Astra装配 | 独立reviewer配置与输入；结构化表图/主张/局限；真实来源快照；可选飞书服务受理回执，不宣称已读 | 待前置证据；外部调用仍未授权执行 |
| 横向 目标循环/主控预算 | Astra commands/run-control/Session | controller-only不得进入无模型完成出口的无限goal；独立暂停、次数/预算、隐式摘要纳入范围 | controller-only禁无界goal；goal.pause覆盖轮间隙；manual hold已接Store/API/Web及主控启动；真正bounded模式仍未实现 |
| 横向 Web文件版本保护 | Astra：files/API/Web契约 | 必需expectedContentHash；同mtime外部变更拒绝；应用内保存串行；冲突保留，不宣称对任意外部进程原子CAS | 已实现并通过同mtime/并发保存测试；真实Web冲突与刷新保留草稿验收通过 |
| 横向 原6测试诊断 | root独立分支/Astra review | Python正确解释器且字节断言保留；probe_url真实HTTP/清理；Git HEAD.lock/worktree；DNS确定性resolver；缺git独立定位 | 六项均修复或以确定性fixture覆盖，保留实际Git/HTTP/进程/UTF-8字节断言；最终整合回归见下文 |

## 本次明确交付与剩余边界

已实现并做本机验证：

- v3 claim/spec/bind 同事务；启动持续观察原Attempt，不重投unknown；持久取消与完成清理，崩溃后沿原宽限升级；晚到完成回执验证后隔离，保留实际完成事实及未知费用预留。
- authority DB持久epoch及同key墓碑，SSH协议精确验证epoch/key/spec/authority；**尚未将epoch写入旧Attempt派发契约**，因此不能据此自动证明旧unknown未运行或释放费用。
- 文件保存必须携带内容版本，应用内串行核对及原子替换；同mtime外部改动拒绝，脏草稿刷新保留。此机制不是对任意外部写进程的文件系统CAS。
- Web原准备提案恢复、已签署待提交与丢响应后同对象重试；保存后的完整候选代码/补丁只读查看，重新核对路径、字节与原spec，不调用CLI。关闭弹窗不再要求新建提案。
- 所有发布入口统一要求当前、精确产物绑定的supported结构化主张映射及独立人工批准；旧Pattern状态与新投影使用同一账本门槛。模型done、任意正文和CLI候选不构成科学支持。
- GET下一步投影已接Web，读取文档真实验证结果且不生成事件、审批请求或执行；现有固定回执可映射展示。新白名单`research-pattern-v2`只提供**计划结构**，validator明确未实现，尚无stageContractHash/inputSetHash对应新TaskRevision执行入口，不能当成已能运行的新流程。
- 手动hold先持久generation，再暂停目标循环并中断同会话的本机主控（多个研究项目共用此主控范围）（包括尚未发布runId的启动阶段）；阻止新主控run与新执行/准备/review claim。恢复仅允许手动动作，不自动起模型或实验。旧hold重放不能中断恢复后新主控。已批准远端租约、观察、清理和完成仍继续。

工程验证已完成但新浏览器验收受本机锁屏影响：审批恢复路径有3个DOM/API契约测试，覆盖同提案继续、已签署无重新quote、切换项目时作用域捕获；候选读取、新下一步与暂停UI目前以服务/API/组件测试及构建验证为准。此前文件冲突和刷新保留草稿是实际浏览器验证，不能混为新UI都已实测。

**尚未实现，不作为本次完成项**：正式候选代码审阅记录→冻结执行计划→单独批准→Linux OCI v4；持久dispatch阶段/observer lease-fence和Attempt epoch全接线；费用证据与结算、已知实际超支占用、科学/财务hash版本分离；有界自动推进的maxAdvances/maxModelRequests/deadline/reservation及事件计数；持久人工Inbox；受信预测独立复算的正式结果包、真实全文/飞书适配、Skill行为准入和多设备调度。下一批先完成这些前置契约与本地负例，再单独做R准入，不能通过修改配置跳过。

## L/R 验收与准入

**L 本机工程验收**：旧快照/签名/哈希、原子账本、API/独立签署、Web可恢复动作、已知安全fixture进程、预测契约与复算负例、无合格后端的服务端拒绝。仅 L 通过不能启用正式实验。

**R 指定环境准入**：Linux rootless OCI + 实际 cgroup v2/systemd委派；真实镜像/挂载替换、越界文件/网络、CPU/内存/pids/tmpfs/日志压力、daemon停机跨期限、容器身份与清理、实际计算成功超过600000ms。准入证据绑定配置与实现版本，单独提交开启。实际SSH、外部CLI、独立review模型、飞书每项分别记录未测/通过，不拿fixture替代。

首轮正式能力限制为单设备单槽CPU、管理员固定镜像、合成数据、完整Python入口、有界结构化预测；无患者数据、自动patch、宿主shell、任意Dockerfile、联网pip、GPU、多机改投和无限迭代。标签/划分从受信冻结快照取得，evaluator不import候选或反序列化可执行对象。runtime上限完整贯穿计划、批准、spec和authority；sleep、65秒计算、被超时杀死均不是>10分钟成功耐久。

后续 P1 全文适配/有界自动迭代/完整期刊稿件和 P2 行为评测、人审晋级回滚、多设备调度依赖真实正式运行与科学证据；文档候选保存不构成晋级。

## 本次最终检查记录

- 全量：2487通过、1跳过、0失败；2488项、204文件、50.65秒。六个原失败均已收敛。最后仅补“代码准备尚非正式实验”的投影提示和断言后，相关10项再次通过。
- 完整TypeScript检查、Web生产构建、改动文件Biome及git diff空白检查通过；未打包桌面App。
- 本地真实浏览器文件编辑冲突与刷新保留草稿通过。后续审批恢复用3项DOM/API测试、候选读取用原spec/字节核验测试覆盖；新流程/暂停用纯读和暂停代际API负例覆盖。Mac锁屏后没有声称完成新的真实浏览器验收。
- 仅本地确定性fixture。没有运行用户SSH实验、付费模型推理、真实科学评审或对外通知；Linux v4未准入。
