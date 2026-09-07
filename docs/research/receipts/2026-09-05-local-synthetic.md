# 本地合成验证流程整合回执

## 执行进度看板

- 最后更新：2026-09-05。
- 状态：功能、真实 HTTP smoke 和最终 gate/build 自测通过；未标记用户亲测验收。
- 实施目录：`D:/PROJECT/Autosearch/oph-autoresearch-repo`，与第一批相同的增量工作树，无提交/推送。
- 输入：[Pro 任务包](../pro-task-package-2026-09-05.md) 与 [第一批基础账本](2026-09-05-research-foundation.md)。

## 实际完成

固定 `synthetic-summary-v1` 内置 fixture → HTTP 请求 → 原子 claim TaskRevision/Attempt → 独立输出目录 → 真实文件 → 重读字节 SHA256 和合同核验 → Task verified → ResearchEvent/outbox → EventBus 通知 → UI 刷新。

这是确定性合成统计和系统闭环验证，不是 ML 训练、影像模型评估或临床有效性验证。输入是 8 个合成数值，输出 count=8、mean=39.375、min=12、max=73。

- 不接受用户 command/path/model/SSH 参数。模板只使用打包 fixture，数据类固定 synthetic，不开放临床数据通道。
- TaskRevision 的模板、输入哈希、输出合同固定；状态由 Attempt 派生。重复 dispatch 不产生第二 Attempt。旧快照缺少新增数组时规范化读取，不改写旧事件或静默改变已绑定审批 hash。
- 取消先写请求再收尾；失败/取消目录保留。仅死 owner PID 的悬挂 Attempt 恢复为 interrupted/cancelled，不自动重跑。PID 存活保守保留，尚无跨主机 lease/fencing。
- 输出分段拒绝软链，共享目录并发 EEXIST 后重新核验，文件用 `wx` 原子拒绝覆盖。通知回调失败保留未投递 outbox，不能把已 claim 的执行留成孤儿。
- Outbox 同科研事实原子写入，发布后标记，允许重投；客户端以 campaignSeq 去重，通知触发当前作用域的 REST 真源读取。WebSocket 全局 seq 不代替科研序号。
- UI 创建/执行中切换会话不串反馈。HTTP 响应丢失后，即使通知已推进版本，重试仍使用原 dispatchKey，直到明确成功才清除。

## HTTP 与真实文件证据

新增 `POST /api/research/campaigns/:id/synthetic`，正文仅 `{expectedVersion,dispatchKey}`；`POST /api/research/campaigns/:id/synthetic/cancel`，正文仅 `{attemptId}`。旧人类批准/撤销端点保持 403。

复现命令：

```powershell
.tmp/bun-shim/bun.exe run scripts/research-local-smoke.ts
```

脚本在 `.tmp/research-smoke/run-*` 下创建独立 home、workspace、SQLite，启动真实 localhost serve 随机端口并使用现有鉴权；不读取用户真实数据库、保存的 SSH 配置或全局扩展。测试无令牌 401、HTTP 新建会话与 Campaign、固定模板执行、重复 dispatch、真实文件 hash、事件与快照序号、outbox 已投递、数据库物理重开。失败保留隔离目录供核查。

本次 JSON 回执：`.tmp/research-smoke/run-cbnMF9/receipt.json`。

| 事实 | 结果 |
|---|---|
| Campaign | `rc_c2588ec1-0387-493a-979c-ce10113a069b` |
| Attempt | `rat_72c476b0-da7f-4dd2-a928-afd5574584d3` |
| campaignSeq / snapshot.version | `3 / 3` |
| 实际文件字节 | `217` |
| SHA256 | `1d6e92562b56cc52ffd94449a76197f2738a20d0210938a7b870ef1bb9c3cd9b` |
| 重复 dispatch | `replayed=true`，仍一个 Attempt |
| Task / Attempt | `verified / completed` |

产物 URI 和完整绝对路径保存在 JSON 回执。主任务还用独立 PowerShell Get-FileHash 复核了同内容的前次 smoke 产物，得到相同字节数、哈希与统计值。

## 两批最终范围矩阵

| Pro 项 | 当前实际结果 |
|---|---|
| A00/A01 | 两批接口、文件所有权、共享整合、真实运行和回归已实施 |
| T01/T02 | Campaign/ArtifactVersion/Approval/ResearchEvent、原子投影/outbox、CAS/幂等、固定合成 TaskRevision/Attempt 与恢复 |
| T03 | 全平台数据出口策略未完成；可以继续本地 canary 验证 |
| T04 | 内部版本绑定/撤销/失效完成；可信人类身份、审批UI、任务图精确返工未完成 |
| T05/T07 | 固定合成本地 Runner 完成；通用资源调度、lease/fencing、SSH Runner 未完成 |
| T06/T09 | 真实 REST 提案/执行/取消/查询、科研事件通知、状态UI和旧聊天未核验区分完成；完整六阶段科研执行未完成 |
| T08 | 正式 Skill 来源锁、许可证/权限/依赖/评测审核和文献 SourceSnapshot 未完成 |
| T10/T12 | 合成统计、取消/失败/重启/覆盖竞态与实际 HTTP 验证完成；ML/临床评估与真实 SSH 纵切片未验证 |
| T11 | 取消、父归属原地修复；完整上游固定 SHA 移植审计未完成 |
| A02 | 当前两批可运行；不宣称整体优化、完整 P0 或真实科研平台已经完成 |

## 保全与验证

对 42 个基线已修改文件重新计算 SHA256：36 个字节不变；6 个已有文件仅做必要接线：ResearchWorkspace.tsx、connection.ts、panel.css、core/index.ts、store/index.ts、store/repos.ts。第一批的 37/5 是当时快照；第二批增加了 connection.ts。最终对照：`.tmp/pro-review-2026-09-05/research-local-preservation.json`。

最终 `.tmp/bun-shim/bun.exe run gate` 返回 0：2230 通过、1 跳过、0 失败，11122 断言，144 个文件；TypeScript、全仓 Biome、Rust cargo check 均通过。唯一跳过项是当前平台写路径软链边界测试。

最终 `.tmp/bun-shim/bun.exe run build` 返回 0：Vite web（5.19 秒）、99.3 MB Windows sidecar（489 模块）和 `oph 0.1.8` 自检通过。既有 FileView 混合静态/动态导入提示不阻断构建。

真实 HTTP smoke 返回 0；核心/存储17项、Runner6项、UI3项及 outbox/序号去重测试均包含在上述全量结果中。全量已绿后未重复扩大验证。

最终日志为 `.tmp/pro-review-2026-09-05/research-local-gate.log`、`research-local-build.log`、`research-local-http-smoke.log`。未启动用户真实数据库迁移或重启用户正在运行的应用；生成的代码与构建产物待正常启动使用。
