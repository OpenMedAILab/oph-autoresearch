# 公开文献元数据接入

## 执行进度

2026-09-05：生产收集器与引用准备消费者完成，真实 loopback HTTP 测试 3 项、30 个断言通过，TypeScript 与文件 Biome 检查通过。已使用相同生产函数访问 Crossref 和 NCBI 两个官方接口，均成功；独立 Astra 对收集器未发现新缺陷。Campaign HTTP 与 EvidencePack 已装配，并通过真实 HTTP → 官方 Crossref → 引用落账 → EvidencePack → local SSE 模型请求的完整 source 验证。最终 compiled 验证与整合审查尚待完成。

实现为 `packages/server/src/research/literature-evidence.ts`。`createLiteratureCollector` 在启动时捕获固定官方 endpoint，仅另准许 loopback 测试地址；每次调用只接受一个规范 DOI 或纯数字 PMID，不接受自由文本查询、任意 URL 或附加字段。请求禁止重定向，10 秒超时，响应最多 1,000,000 bytes。返回标识必须与请求相同。

## 官方真实接口验证

同一论文的两个来源用于交叉核验，不代表两项独立研究：

- Crossref：[`10.1038/s41591-018-0107-6`](https://doi.org/10.1038/s41591-018-0107-6)，实际请求 [works endpoint](https://api.crossref.org/works/10.1038%2Fs41591-018-0107-6)。题名 “Clinically applicable deep learning for diagnosis and referral in retinal disease”，published date `2018-08-13`，定位 `/message`；实际响应 SHA256 `82cf6423e7ce15f201a311bf587b1ea7257e1e4a0e5c1b6304f5542390e86a51`。
- PubMed：[`30104768`](https://pubmed.ncbi.nlm.nih.gov/30104768/)，实际请求 [NCBI esummary](https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=30104768)。同题名，pubdate `2018 Sep`，定位 `/result/30104768`；实际响应 SHA256 `46656fe000ca1b384f5bec9a877de5192ec4a7198a9ddbb60b54318ed73f88c2`。

不同出版日期字段保留各来源口径，不强行改写为同一天。元数据可随提供方更新；contentHash 标识该次响应，不声称官方内容永不变化。测试回执在 `.tmp/pro-review-2026-09-05/full-plan/literature-live-receipt.json`。真实请求使用本机已配置代理，未将代理写入产品或用户全局配置。

## 引用消费与边界

返回字段仅为不透明引用 id、DOI/PMID、由标识生成的公开 URL、title、publishedAt、检索时间、原响应 hash 与 JSON pointer。缺失日期保留 null；不会回传原响应的 abstract、debug、任意链接或本地路径。题名是外部不可信证据文本，不能当执行指令。

`prepareEvidenceCitations` 仅接受本进程生产收集器核验并冻结的对象，最多 32 个来源；从请求 JSON 反序列化或自行复制对象不能冒充已核验来源。它生成安全引用投影及 projectionHash，标记 `verification: retrieved-public-metadata`、`fullText: false`。持久化引用应进入同一 Campaign 权威，并由 EvidencePack hash/审批范围消费；不能在 HTTP 层直接信任客户端提供的这些字段。

这是公开元数据检索与引用定位，不是全文检索、句级科学主张支持证据或全文质量评价。两种标识可能指向同一论文，不能将记录数量当独立研究数量。后续全文准入或主张关联需要另外验证对应来源字节、精确定位和适用范围。

## 测试形状

真实 loopback 服务检验两类请求路径与标识、实际字节 hash、缺失日期，以及无 abstract/debug/任意 URI 回传。另验证：克隆伪造来源拒绝、重复同标识拒绝、患者自由文本/附加 query/任意 URL 在发请求前拒绝，重定向不会触达目标，超大响应、标识不匹配与不存在日期被拒绝。
