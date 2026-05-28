/**
 * 提取准确率评估运行器。
 *
 * 用法：
 *   配好 .env（OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）后：
 *     node eval/run-eval.js
 *
 * 流程：读取 eval/golden/*.json → 把 inputSource 喂给真实提取器 → 用 score.js
 * 评分 → 打印每个样例与整体 F1。需要真实 LLM，故未纳入零密钥单测；评分逻辑本身
 * 由 test/eval-score.test.js 覆盖。
 */

const fs = require('fs');
const path = require('path');
// 先加载 .env，再做 key 检查（否则会在惰性 require 之前判空）。
// override:true 让 .env 的值覆盖 shell 里可能存在的旧 OPENAI_* 变量，避免被同名 key 盖住。
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });
const { scoreExtraction } = require('./score');

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('需要配置 OPENAI_API_KEY 才能运行真实评估。评分逻辑可单独测试：npm test');
    process.exit(1);
  }
  // 延迟加载，避免无 key 时单测/加载受影响
  const { generateApiJsonWithLLM } = require('../src/api-generation/file-based-api-generator');

  const goldenDir = path.resolve(__dirname, 'golden');
  const files = fs.readdirSync(goldenDir).filter((f) => f.endsWith('.json'));

  // 模型按 apiJson 规范返回 { name, components:{ <Name>:{ properties, events, slots, ... } } }，
  // 真实字段嵌套在 components.<name>，需要先 unwrap 再喂给 scorer。
  const unwrap = (raw) => {
    let r = Array.isArray(raw) ? raw[0] : raw;
    if (r && r.components && typeof r.components === 'object') {
      const k = Object.keys(r.components)[0];
      if (k) r = r.components[k] || {};
    }
    return r || {};
  };

  const rows = [];
  for (const f of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(goldenDir, f), 'utf-8'));
    const result = await generateApiJsonWithLLM(fixture.inputSource);
    const actual = unwrap(result);
    const s = scoreExtraction(fixture.expected, actual);
    rows.push({ component: fixture.component, f1: s.overall.f1, detail: s });
    console.log(`\n[${fixture.component}] overall F1=${s.overall.f1.toFixed(3)} (P=${s.overall.precision.toFixed(3)} R=${s.overall.recall.toFixed(3)})`);
    for (const cat of ['properties', 'events', 'slots']) {
      const c = s.byCategory[cat];
      console.log(`  ${cat}: F1=${c.f1.toFixed(3)} missing=[${c.missing}] extra=[${c.extra}]`);
    }
  }

  const avg = rows.length ? rows.reduce((a, r) => a + r.f1, 0) / rows.length : 0;
  console.log(`\n=== 金标准集平均 F1: ${avg.toFixed(3)}（${rows.length} 个样例）===`);
}

main().catch((e) => {
  console.error('评估失败：', e.message);
  process.exit(1);
});
