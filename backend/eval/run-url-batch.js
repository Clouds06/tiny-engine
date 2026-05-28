/**
 * URL 批量 e2e 探针：跑 url-fixtures.json 里的多个组件页，
 * 报告每页的耗时 / token / 抽取出的组件数 / 主组件 props·events·slots 数，
 * 以及合计 / 平均 / token 分布。需要 Chromium + OPENAI_*。
 *
 *   node eval/run-url-batch.js [path/to/fixtures.json]
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });

const { extractApiFromUrl } = require('../src/api-generation/web-table-based-api-generator');
const { getUsageTotals, resetUsageTotals } = require('../src/llm/llm-client');

function summarize(api) {
  if (!Array.isArray(api) || api.length === 0) return { entries: 0, props: 0, events: 0, slots: 0, mainName: '' };
  const first = api[0] || {};
  const comp = first.components ? first.components[Object.keys(first.components)[0]] : first;
  return {
    entries: api.length,
    mainName: first.name || first.component || '(unknown)',
    props: (comp && comp.properties && comp.properties.length) || 0,
    events: (comp && comp.events && comp.events.length) || 0,
    slots: (comp && comp.slots && comp.slots.length) || 0,
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('需要配置 OPENAI_API_KEY');
    process.exit(1);
  }

  const fixturesPath = process.argv[2] || path.resolve(__dirname, 'url-fixtures.json');
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  const selector = fixtures.selector || 'table';

  console.log(`共 ${fixtures.items.length} 个 URL，选择器: ${selector}\n`);
  const rows = [];
  const batchStart = Date.now();

  for (const item of fixtures.items) {
    resetUsageTotals();
    const t = Date.now();
    let summary;
    let err;
    try {
      const api = await extractApiFromUrl(item.url, selector);
      summary = summarize(api);
    } catch (e) {
      err = e.message;
    }
    const sec = ((Date.now() - t) / 1000).toFixed(2);
    const u = getUsageTotals();
    rows.push({
      id: item.id,
      url: item.url,
      ok: !err,
      sec,
      calls: u.calls,
      total_tokens: u.total_tokens,
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      ...(summary || {}),
      err,
    });
    if (err) console.log(`[${item.id}] FAIL  ${sec}s  err=${err}`);
    else console.log(`[${item.id}] OK  ${sec}s  tokens=${u.total_tokens}  组件×${summary.entries}  主"${summary.mainName}" props=${summary.props}/events=${summary.events}/slots=${summary.slots}`);
  }

  const total = ((Date.now() - batchStart) / 1000).toFixed(2);

  console.log(`\n=== 分布 ===`);
  const ok = rows.filter((r) => r.ok);
  const secs = ok.map((r) => +r.sec);
  const toks = ok.map((r) => r.total_tokens);
  const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const min = (arr) => Math.min(...arr);
  const max = (arr) => Math.max(...arr);
  console.log(`成功率: ${ok.length}/${rows.length}`);
  console.log(`墙钟 (s) min/avg/max: ${min(secs)} / ${avg(secs)} / ${max(secs)}  | 批次合计: ${total}s`);
  console.log(`tokens   min/avg/max: ${min(toks)} / ${avg(toks)} / ${max(toks)}  | 累计: ${ok.reduce((a, b) => a + b.total_tokens, 0)}`);

  console.log(`\n=== 明细表 ===`);
  console.log('id'.padEnd(8) + 'sec'.padStart(7) + 'tokens'.padStart(9) + 'comp'.padStart(6) + 'props'.padStart(7) + 'events'.padStart(8) + 'slots'.padStart(7) + '  main');
  for (const r of rows) {
    if (!r.ok) {
      console.log(r.id.padEnd(8) + 'FAIL'.padStart(7) + ' '.repeat(30) + r.err);
      continue;
    }
    console.log(
      r.id.padEnd(8)
      + String(r.sec).padStart(7)
      + String(r.total_tokens).padStart(9)
      + String(r.entries).padStart(6)
      + String(r.props).padStart(7)
      + String(r.events).padStart(8)
      + String(r.slots).padStart(7)
      + '  ' + r.mainName,
    );
  }
}

main().catch((e) => {
  console.error('批量失败：', e.message);
  process.exit(1);
});
