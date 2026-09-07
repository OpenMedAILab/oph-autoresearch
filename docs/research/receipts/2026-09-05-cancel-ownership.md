# 工作流取消与子会话归属收据

日期：2026-09-05

## 结论

- 编排收到中断后停止派发尚未启动的节点，等待已启动节点结束，并以 `failed` 返回。
- 子会话在创建时写入 `parentConversationId`，续接时必须同时匹配父会话、工作区、`workflow` 来源和角色。
- 删除父会话会通过 `parent_conversation_id` 的外键级联删除成员子会话。

## 续接入口

`TeamOrchestrator` 只通过 `existingConversationId` 请求续接。该参数的唯一生产调用在
`delegate.ts` 的 `runGraph()`；它在调用 `runBuiltinMember()` 前校验子会话的全部归属字段。
`runBuiltinMember()` 仅由 `delegate.ts` 的单件派活和工作流派活调用。单件派活不会提供
`existingConversationId`。其余 `Session.ask(existing)` 调用是顶层用户会话续接，不进入成员会话路径。

## 验证

```text
.tmp/bun-shim/bun.exe run test packages/team/src/orchestrator.test.ts
20 pass, 0 fail

.tmp/bun-shim/bun.exe run test packages/server/src/delegate.test.ts
12 pass, 0 fail

.tmp/bun-shim/bun.exe run test packages/store/src/schema.test.ts packages/store/src/repos.test.ts
24 pass, 0 fail

.tmp/bun-shim/bun.exe x biome check <7 changed source/test files>
通过
```

另以 `:memory:` SQLite 存储创建父子会话、删除父会话并读取子会话，结果为
`parent conversation deletion cascades to child`。

## 边界

全量 TypeScript 检查当前被未完成的 research 变更阻断：`packages/core/src/domain/research.ts`
存在重复 `kind` 声明，且 `packages/store/src/research.ts` 与
`packages/server/src/api/research.ts` 引用尚未导出的研究账本接口。本收据覆盖的定向测试均通过。
