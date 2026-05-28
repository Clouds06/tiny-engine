/**
 * 真实开源组件库源码 e2e：从 element-plus 仓库（GitHub sparse clone）拉
 * 指定组件的真实源码 → 走源码管线 → 报告 props/events/slots + token + 耗时。
 * 与 run-url-batch.js 同样的组件集，便于跨路径对照。
 *
 *   node eval/run-source-real.js              # 默认 5 个组件
 *   node eval/run-source-real.js button input # 指定子集
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });

const { filterAndConcatApiCodeFiles } = require('../src/file-collection/component-code-file-filter');
const { generateApiJsonWithLLM } = require('../src/api-generation/file-based-api-generator');
const { getUsageTotals, resetUsageTotals } = require('../src/llm/llm-client');

const REPO_URL = 'https://github.com/element-plus/element-plus.git';
const BRANCH = 'dev';
const CLONE_DIR = path.join(os.tmpdir(), 'ep-clone');
const DEFAULT_COMPONENTS = ['button', 'input', 'select', 'form', 'table'];

function sparseClone(components) {
  const paths = components.map((c) => `packages/components/${c}`);
  if (!fs.existsSync(path.join(CLONE_DIR, '.git'))) {
    console.log(`[clone] sparse-cloning ${REPO_URL} → ${CLONE_DIR}`);
    fs.rmSync(CLONE_DIR, { recursive: true, force: true });
    execSync(
      `git clone --filter=blob:none --depth 1 --no-checkout --branch ${BRANCH} ${REPO_URL} ${CLONE_DIR}`,
      { stdio: 'inherit' },
    );
    execSync(`git -C ${CLONE_DIR} sparse-checkout init --cone`);
  }
  execSync(`git -C ${CLONE_DIR} sparse-checkout set ${paths.join(' ')}`);
  execSync(`git -C ${CLONE_DIR} checkout ${BRANCH}`);
  console.log(`[clone] ready: ${paths.join(', ')}\n`);
}

function compDir(name) {
  return path.join(CLONE_DIR, 'packages', 'components', name);
}

function ms(start) { return ((Date.now() - start) / 1000).toFixed(2); }

async function runOne(name) {
  resetUsageTotals();
  const t0 = Date.now();
  let stage1, stage2, api;
  try {
    let t = Date.now();
    const f = await filterAndConcatApiCodeFiles(compDir(name));
    stage1 = { sec: +ms(t), filtered: f.filteredFiles.length, files: f.filteredFiles.map((x) => ({ p: x.filePath, by: x.detectedBy, sig: x.signals })) };

    t = Date.now();
    api = await generateApiJsonWithLLM(f.combinedContent);
    stage2 = { sec: +ms(t) };
  } catch (e) {
    return { name, err: e.message, totalSec: +ms(t0), usage: getUsageTotals() };
  }
  const compName = api?.components ? Object.keys(api.components)[0] : '(unknown)';
  const c = api?.components?.[compName] || {};
  const usage = getUsageTotals();
  return {
    name,
    totalSec: +ms(t0),
    stage1, stage2,
    extracted: {
      main: compName,
      props: (c.properties || []).map((x) => x.name),
      events: (c.events || []).map((x) => x.name),
      slots: (c.slots || []).map((x) => x.name),
    },
    usage,
  };
}

async function main() {
  const list = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_COMPONENTS;
  sparseClone(list);
  const rows = [];
  for (const name of list) {
    console.log(`\n[${name}] 开始...`);
    const r = await runOne(name);
    if (r.err) {
      console.log(`  FAIL: ${r.err}`);
    } else {
      console.log(`  AST/LLM 筛选: ${r.stage1.filtered} 文件 (${r.stage1.sec}s)`);
      r.stage1.files.forEach((f) => console.log(`    · ${f.p}  ${f.by === 'ast' ? `AST[${(f.sig||[]).join(',')}]` : 'LLM'}`));
      console.log(`  api-extract: ${r.stage2.sec}s`);
      console.log(`  组件 "${r.extracted.main}": props=${r.extracted.props.length} events=${r.extracted.events.length} slots=${r.extracted.slots.length}`);
      console.log(`  LLM ${r.usage.calls} 次  tokens=${r.usage.total_tokens}  e2e=${r.totalSec}s`);
    }
    rows.push(r);
  }

  console.log(`\n=== 源码路径 真实组件 提取结果 ===`);
  console.log('name'.padEnd(8) + 'sec'.padStart(7) + 'tokens'.padStart(9) + 'LLM'.padStart(5) + 'P'.padStart(5) + 'E'.padStart(4) + 'S'.padStart(4) + '  main');
  for (const r of rows) {
    if (r.err) { console.log(r.name.padEnd(8) + 'FAIL  ' + r.err); continue; }
    console.log(
      r.name.padEnd(8)
      + String(r.totalSec).padStart(7)
      + String(r.usage.total_tokens).padStart(9)
      + String(r.usage.calls).padStart(5)
      + String(r.extracted.props.length).padStart(5)
      + String(r.extracted.events.length).padStart(4)
      + String(r.extracted.slots.length).padStart(4)
      + '  ' + r.extracted.main,
    );
  }
  const outFile = path.join(__dirname, 'last-source-real.json');
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
  console.log(`\n详情存到: ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
