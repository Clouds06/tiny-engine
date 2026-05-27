# 优化方向与改进记录

> 本文档记录本项目（TinyEngine 低代码物料导入工具）在「结合最新 AI 技术」视角下的优化方向，
> 以及已经落地的改进。与简历中「项目复盘 & 后续优化方向」一节同步维护。

## 时代背景

本项目完成于 **2025 年 7–10 月**。当时 LLM 的结构化输出（json_schema strict mode）、
prompt caching、廉价长上下文、成熟的 browser-use / computer-use agent 都还不成熟或不可用，
因此部分实现（正则抠 JSON、每文件一次 LLM 筛选、内嵌超长 few-shot、内存任务队列）是
**当时技术条件下的合理取舍**。本文档按 2026 年的技术栈重新审视，记录可落地的优化方向。

---

## 已落地（Changelog）

### [2026-05] 统一 LLM 调用层 — `src/llm/llm-client.js`
对应提交：`refactor(llm): unify LLM calls into a shared client layer`

**动机**：原先 5 处调用点各自 `new OpenAI()` + `chat.completions.create` + 手工抠
` ```json ` 围栏 + `JSON.parse`，解析失败即丢弃整个组件，且无任何成本计量。

**改动**：收敛为单一调用层，提供
- 结构化输出：可选 `response_format=json_object`，并对解析结果做 schema 校验
  （谓词函数 / zod 风格 `safeParse` 双兼容）；
- 失败重试：解析或校验失败时带**纠错反馈**重试，而非静默丢组件；
- token 计量：按 label（file-filter / npm-file-filter / api-extract /
  url-table-extract / schema-convert）分桶累加 usage，供成本分析；
- 供应商不支持 `response_format` 时**自动降级**重试；
- `AbortSignal` 透传；
- `openai` 懒加载 —— 注入 mock client 的单元测试无需 API key。

**迁移的 5 个调用点**：
| 文件 | 函数 | label |
| --- | --- | --- |
| `component-code-file-filter.js` | `checkFileWithLLM` | `file-filter` |
| `component-npm-file-filter.js` | `analyzeFileForComponentApi` | `npm-file-filter` |
| `file-based-api-generator.js` | `generateApiJsonWithLLM` | `api-extract` |
| `web-table-based-api-generator.js` | `convertTablesToApiJson` | `url-table-extract` |
| `convertor.js` | `callOpenAIModel` | `schema-convert` |

**测试**：`backend/test/` 下新增 11 个 `node:test` 用例（mock client、零密钥），
覆盖解析 / 校验 / 重试 / 降级 / 取消 / 计量与迁移后的 file-filter。运行：`cd backend && npm test`。

---

## 待办 Backlog

### 第一梯队（小改动、高收益）
- [x] **结构化输出 + token 计量 + 失败重试** —— 已由统一调用层一次性落地。
- [ ] **Prompt Caching**：`convertor.js` 的转换 prompt ~1100 行（含完整 DatePicker 示例）
  每个组件重发一遍。缓存固定协议说明 + few-shot，单组件输入 token 降一个数量级。

### 第二梯队（架构级）
- [ ] **AST / embeddings 预筛**：现状对每个文件发一次 LLM 判断是否含 API（大组件库调用数爆炸）。
  用 `@vue/compiler-sfc` / `ts-morph` 做确定性 AST 抽取 props/emits/slots，LLM 只补语义；
  或 embeddings 粗筛候选。成本从 O(文件数) 降下来。
- [ ] **校验回灌自我修复 + Eval**：schema 输出后用 zod/ajv 对照 TinyEngine 协议校验，
  错误回灌让模型 self-correct；建金标准组件集自动算提取准确率（当前全仓无 eval）。
- [ ] **机器可读 schema**：TinyEngine 物料协议形态散在 prompt 里，协议升级要手改 prompt。
  抽成 JSON Schema / zod 单一定义，prompt 引用它。
- [ ] **任务持久化 + 队列**：现状内存 `Map`，进程重启即丢、无多实例。改 BullMQ + Redis / DB。

### 第三梯队（前沿 / 未来规划）
- [ ] **多模态兜底**：文档站除表格还有截图/示例，用 vision 模型（Qwen-VL / GPT-4o）
  直接看文档页截图提取 API，作为 Puppeteer 表格解析失败时的兜底。
- [ ] **Browser-use agent**：URL 爬取现靠用户手填 `tableSelector`，很脆。
  用浏览器 agent 自主定位文档表格，免手填选择器。

### 其它已知待加固项
- [ ] ZIP 解压（`adm-zip` `extractAllTo`）未做 Zip Slip 路径穿越防护（单文件上传已校验）。
- [ ] `convertor.js` 的 schema 转换批次用 `Promise.all`，单组件失败会拖垮整批；
  可改 `Promise.allSettled` + 单组件重试/降级。
- [ ] 依赖冗余：`langchain` / `sequelize` / `sql.js` 装了未用或半用。
