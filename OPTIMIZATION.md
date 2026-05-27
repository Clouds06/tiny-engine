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

### [2026-05] AST 预筛 —— `src/file-collection/ast-api-detector.js`
对应提交：`feat(file-collection): AST prefilter to skip LLM for obvious API files`

**动机**：源码筛选阶段对**每个文件**都发一次 LLM 判断是否含 API，大组件库调用数爆炸。

**改动**：新增确定性探测器，用 `@vue/compiler-sfc` 解析 SFC，扫描 script/template 中的
props/emits/slots 信号（`defineProps`/`defineEmits`/`defineSlots`/`withDefaults`、
Options `props`/`emits`、`<slot>`），并保留入口文件（`index.*`）启发式。`checkFileWithLLM`
先走探测器：确定命中（或入口文件）就直接返回、**跳过 LLM**；只有 AST 无法确定的文件才回退
LLM —— **高召回设计**：正信号短路为 true，无信号视为"不确定"而非"无 API"，仍交 LLM 兜底。
关键修正：扫**原始** `<script>` 文本而非 `compileScript` 输出（后者会把 `defineProps` 等宏编译掉，
反而扫不到信号）。

**测试**：新增 AST 探测器用例 + 「AST 命中时 LLM 客户端绝不被调用」的反证测试，全套 20 例、零密钥。

---

### [2026-05] Prompt 缓存友好化 —— `convertor.js`
对应提交：`feat(schema-conversion): make conversion prompt cache-friendly`

**动机**：schema 转换 prompt ~1100 行（含完整 DatePicker 示例），每个组件重发一遍；
更糟的是原本有一个变量（`relatedSubComponents`）插在 prompt **中间**，导致其后的全部内容
（含大示例）每次都不同，无法命中前缀缓存。

**改动**：把两处 per-component 变量（关联子组件列表、组件 API 数据）全部挪到末尾**单独一条
「输入数据」user 消息**，使前面的 system + 巨型指令成为**逐字节稳定的前缀**，命中模型侧
prefix / context caching（DeepSeek 等自动按前缀缓存），单组件输入 token 显著下降。

**测试**：新增前缀稳定性测试 —— 断言不同输入下 system + 巨型指令逐字节相同、前缀不含任何
per-component 数据、变量只落在末尾消息。全套 23 例、零密钥。

### [2026-05] 提取准确率评估（金标准集 + 评分器）—— `eval/`
对应提交：`feat(eval): add extraction accuracy golden set and scorer`

**动机**：Q7 暴露的硬伤 —— 全仓无任何 eval，提取准确率全靠人工看日志。

**改动**：新增 `eval/score.js`（按 properties/events/slots 三类做名称集合的
precision/recall/F1 + missing/extra 明细 + micro 平均整体分）、`eval/golden/*.json`
金标准样例、`eval/run-eval.js` 运行器（配 key 后 `node eval/run-eval.js` 跑真实提取并打分）。
评分器为纯函数，由 `test/eval-score.test.js` 覆盖（5 例，零密钥）。

> 说明：自动评分逻辑已可用；**自我修复（校验回灌让模型 self-correct）** 仍在 backlog。

### [2026-05] Stage C 批量容错（allSettled + 单组件重试）—— `convertor.js`
对应提交：`fix(schema-conversion): allSettled + per-component retry in batch convert`

**动机**：schema 转换批次用 `Promise.all`，任一子组件抛错会让整批 reject、丢掉同批其他
已成功的结果（且与下游"按 success:false 统计"的设计自相矛盾）。

**改动**：单组件转换包一层 `convertSubComponentWithRetry`（失败带退避重试，重试耗尽返回
`{success:false}` 软失败而非抛出，取消错误照常向上抛）；批次内改用 `Promise.allSettled`，
成功/软失败都进结果集，仅"取消"以 rejected 向上传播。`batchConvertToTinyEngineSchema`
新增可注入的 `convertFn` / `retries` 选项，便于单测。

**测试**：新增 4 例（重试成功 / 重试耗尽软失败 / 取消传播 / 一个组件失败不拖垮整批），
注入 mock convertFn，全套 32 例、零密钥。

### [2026-05] 机器可读物料 schema + 自我修复闭环 —— `src/schema-conversion/material-schema.js`
对应提交：`feat(schema-conversion): machine-readable material schema + self-correction`

**动机**：TinyEngine 物料协议的"输出形态"只散落在 ~1100 行 prompt 文案里，无法程序化校验；
LLM 产出不合规时也没有自动纠错，只能靠下游报错。

**改动**：
- `material-schema.js` 把协议核心固化为可程序化校验的 `validateMaterialSchema(input)`
  （必需 component / name.zh_CN / schema；类型约束 properties 为数组、events/slots 为对象；
  接受单对象或多组件数组），返回 zod 风格 `{success,error|data}`。
- 把它接到 `callOpenAIModel` 的统一调用层 `validate` 参数 —— 复用 llm-client 既有的
  "校验失败→把错误反馈回模型→重试"机制，形成**自我修复闭环**：产出不合规时自动带着具体
  错误重试，而非直接失败。`callOpenAIModel` 增加可注入 client（测试用）。

**测试**：material-schema 校验器 8 例 + 自我修复（首次不合规→反馈重试→第二次合规）2 例，
注入 mock client，零密钥。

### [2026-05] Zip Slip 路径穿越防护 —— `extractZipToTempDir`
对应提交：`fix(security): guard ZIP extraction against Zip Slip`

**动机**：ZIP 上传解压用 `zip.extractAllTo(tempDir, true)`，未校验条目路径，
恶意压缩包可用 `../` 把文件写到目录外（单文件上传此前已校验，ZIP 没有）。

**改动**：解压前遍历所有条目，校验每个条目 `path.resolve(tempDir, entryName)` 必须落在
tempDir 内，任一条目逃逸（`../` / 绝对路径）则拒绝整个压缩包。

**测试**：构造带 `../` 穿越条目的压缩包断言被拒、正常压缩包正常解压；2 例，零密钥。

---

## 待办 Backlog

### 第一梯队（小改动、高收益）
- [x] **结构化输出 + token 计量 + 失败重试** —— 已由统一调用层一次性落地。
- [x] **Prompt Caching** —— 已落地（见上方 Changelog）。

### 第二梯队（架构级）
- [x] **AST / embeddings 预筛**：已落地 SFC 的 AST 预筛（见上方 Changelog）。后续可扩展：
  `.ts`/`.tsx` 用 `ts-morph` 做更精确的 AST（当前 .ts/.js 仍是正则信号）；或 embeddings 粗筛候选。
- [x] **Eval 金标准集 + 评分器**：已落地（见上方 Changelog）。
- [x] **校验回灌自我修复**：已落地（见 Changelog）。
- [x] **机器可读 schema**：已落地 `validateMaterialSchema`（见 Changelog）。后续可扩展为完整 JSON Schema / zod。
  抽成 JSON Schema / zod 单一定义，prompt 引用它。
- [ ] **任务持久化 + 队列**：现状内存 `Map`，进程重启即丢、无多实例。改 BullMQ + Redis / DB。

### 第三梯队（前沿 / 未来规划）
- [ ] **多模态兜底**：文档站除表格还有截图/示例，用 vision 模型（Qwen-VL / GPT-4o）
  直接看文档页截图提取 API，作为 Puppeteer 表格解析失败时的兜底。
- [ ] **Browser-use agent**：URL 爬取现靠用户手填 `tableSelector`，很脆。
  用浏览器 agent 自主定位文档表格，免手填选择器。

### 其它已知待加固项
- [x] ZIP 解压 Zip Slip 路径穿越防护：已落地（见 Changelog）。
- [x] `convertor.js` 的 schema 转换批次 `Promise.all` → `allSettled` + 单组件重试/软失败：已落地（见 Changelog）。
- [ ] 依赖冗余：`langchain` / `sequelize` / `sql.js` 装了未用或半用。
