/**
 * 全链路 e2e 探针：file-filter → api-extract → schema-convert，
 * 记录每阶段的 token 用量（按 llm-client 的 label 分桶）+ 墙钟耗时。
 * 不写 MySQL、不依赖 Chromium。需要 backend/.env 配好 OPENAI_* 即可。
 *
 *   node eval/run-pipeline.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });

const {
  filterAndConcatApiCodeFiles,
} = require('../src/file-collection/component-code-file-filter');
const { generateApiJsonWithLLM } = require('../src/api-generation/file-based-api-generator');
const { batchConvertToTinyEngineSchema } = require('../src/schema-conversion/convertor');
const { getUsageTotals, resetUsageTotals } = require('../src/llm/llm-client');

const SAMPLE_VUE = `<script setup lang="ts">
const props = defineProps<{
  size?: 'large' | 'default' | 'small'
  type?: string
  disabled?: boolean
  loading?: boolean
}>()
const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>()
</script>

<template>
  <button :disabled="disabled">
    <slot name="icon" />
    <slot />
  </button>
</template>
`;

function ms(start) {
  return ((Date.now() - start) / 1000).toFixed(2);
}

function printBucket(label, b) {
  if (!b) return console.log(`  ${label.padEnd(20)} 无调用`);
  console.log(`  ${label.padEnd(20)} calls=${b.calls}  prompt=${b.prompt_tokens}  completion=${b.completion_tokens}  total=${b.total_tokens}`);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('需要配置 OPENAI_API_KEY');
    process.exit(1);
  }

  resetUsageTotals();
  const startedAt = Date.now();

  // 写入临时组件目录（一个入口 + 一个 SFC，让 file-filter 走 AST 命中路径）
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pipeline-'));
  fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export { default } from "./Button.vue";\n');
  fs.writeFileSync(path.join(tempDir, 'Button.vue'), SAMPLE_VUE);

  console.log(`\n=== Stage 1: file-collection (AST + 必要时 LLM 筛选) ===`);
  let t = Date.now();
  const filtered = await filterAndConcatApiCodeFiles(tempDir);
  const filterMs = ms(t);
  console.log(`耗时 ${filterMs}s | 命中 ${filtered.filteredFiles.length} 个文件：`);
  for (const f of filtered.filteredFiles) {
    const tag = f.detectedBy === 'ast' ? `AST[${(f.signals || []).join(',')}]` : 'LLM';
    console.log(`  · ${f.filePath}  ← ${tag}`);
  }

  console.log(`\n=== Stage 2: api-extract (1 次 LLM) ===`);
  t = Date.now();
  const apiData = await generateApiJsonWithLLM(filtered.combinedContent);
  const extractMs = ms(t);
  const compName = apiData?.components ? Object.keys(apiData.components)[0] : '(unknown)';
  const extracted = apiData?.components?.[compName] || {};
  console.log(`耗时 ${extractMs}s | 提取出组件 "${compName}"，props=${(extracted.properties || []).length} events=${(extracted.events || []).length} slots=${(extracted.slots || []).length}`);

  console.log(`\n=== Stage 3: schema-convert (每子组件 1 次 LLM) ===`);
  t = Date.now();
  const results = await batchConvertToTinyEngineSchema(
    [apiData],
    process.env.OPENAI_MODEL,
    false, // save=false，不写 schema-log
    5,
    path.join(__dirname, '../schema-log'),
    { retries: 0 },
  );
  const convertMs = ms(t);
  const ok = results.filter((r) => r.success !== false).length;
  console.log(`耗时 ${convertMs}s | 成功 ${ok}/${results.length}`);

  const totalSec = ms(startedAt);
  const u = getUsageTotals();

  console.log(`\n=== 总览 ===`);
  console.log(`端到端墙钟耗时: ${totalSec}s（含 ${filterMs}s + ${extractMs}s + ${convertMs}s）`);
  console.log(`LLM 调用合计: ${u.calls} 次，total_tokens=${u.total_tokens}`);
  console.log(`按阶段 (label) 分桶:`);
  printBucket('file-filter', u.byLabel['file-filter']);
  printBucket('api-extract', u.byLabel['api-extract']);
  printBucket('schema-convert', u.byLabel['schema-convert']);

  // 清理 temp
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('e2e 失败：', e.message);
  process.exit(1);
});
