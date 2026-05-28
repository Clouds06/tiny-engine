/**
 * URL 路径端到端探针：Puppeteer 爬文档表格 → LLM 分类为 props/events/slots。
 * 记录墙钟 + LLM token 用量。需 Chromium（puppeteer 缓存）+ OPENAI_*。
 *
 *   node eval/run-url-e2e.js [url] [tableSelector]
 * 默认：element-plus button 文档页 + 'table' 选择器。
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });

const { extractApiFromUrl } = require('../src/api-generation/web-table-based-api-generator');
const { getUsageTotals, resetUsageTotals } = require('../src/llm/llm-client');

const DEFAULT_URL = 'https://element-plus.org/zh-CN/component/button.html';
const DEFAULT_SELECTOR = 'table';

function ms(start) {
  return ((Date.now() - start) / 1000).toFixed(2);
}

function summarize(api) {
  if (!Array.isArray(api) || api.length === 0) return '(空)';
  const first = api[0] || {};
  const name = first.name || first.component || '(unknown)';
  const comp = first.components ? first.components[Object.keys(first.components)[0]] : first;
  const ps = (comp && comp.properties && comp.properties.length) || 0;
  const es = (comp && comp.events && comp.events.length) || 0;
  const ss = (comp && comp.slots && comp.slots.length) || 0;
  return `组件 "${name}" props=${ps} events=${es} slots=${ss}（共 ${api.length} 个 component 条目）`;
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const selector = process.argv[3] || DEFAULT_SELECTOR;

  if (!process.env.OPENAI_API_KEY) {
    console.error('需要配置 OPENAI_API_KEY');
    process.exit(1);
  }

  resetUsageTotals();
  console.log(`URL: ${url}`);
  console.log(`选择器: ${selector}`);

  const t = Date.now();
  const api = await extractApiFromUrl(url, selector);
  const total = ms(t);

  console.log(`\n=== 结果 ===`);
  console.log(`端到端墙钟: ${total}s`);
  console.log(`提取: ${summarize(api)}`);

  const u = getUsageTotals();
  console.log(`\n=== LLM 用量 ===`);
  console.log(`调用次数: ${u.calls}  total_tokens=${u.total_tokens}`);
  for (const [label, b] of Object.entries(u.byLabel)) {
    console.log(`  ${label.padEnd(20)} calls=${b.calls}  prompt=${b.prompt_tokens}  completion=${b.completion_tokens}  total=${b.total_tokens}`);
  }
}

main().catch((e) => {
  console.error('URL e2e 失败：', e.message);
  process.exit(1);
});
