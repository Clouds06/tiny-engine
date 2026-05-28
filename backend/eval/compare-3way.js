/**
 * 三方对照 + F1：用 element-plus 官方文档抓的 ground truth 作为基线，
 * 同时跑/读 URL 路径 和 源码路径 的抽取结果，对每条路径在 properties/events/slots
 * 三类上算 precision/recall/F1（用 eval/score.js），打印对照表。
 *
 *   node eval/compare-3way.js
 *
 * 前置：先跑过 scrape-doc-truth.js 生成 ground-truth.json 与 run-source-real.js
 * 生成 last-source-real.json。URL 抽取会现场跑（每组件一次 LLM）。
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });

const { scoreExtraction } = require('./score');
const { extractApiFromUrl } = require('../src/api-generation/web-table-based-api-generator');

// 把名字归一到 kebab-case + 剥掉版本号/状态徽章，消除"命名规范差异"伪错配。
// camelCase / PascalCase → kebab-case；trailing " 2.x.y" / " a11y" / " deprecated" 等剥掉。
function normalizeName(name) {
  if (typeof name !== 'string') return '';
  let n = name.replace(/\s+(a11y|deprecated|beta|alpha|new|\d+\.[\d.]+)(\s.*)?$/i, '').trim();
  n = n.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase();
  return n;
}
function normalizeBag(bag) {
  if (!bag) return {};
  const out = {};
  for (const k of ['properties', 'events', 'slots']) {
    out[k] = (bag[k] || []).map((x) => ({ name: normalizeName(typeof x === 'string' ? x : x.name) }))
      .filter((x) => x.name);
  }
  return out;
}

const COMPONENTS = [
  { id: 'button', main: 'Button', url: 'https://element-plus.org/zh-CN/component/button.html' },
  { id: 'input',  main: 'Input',  url: 'https://element-plus.org/zh-CN/component/input.html' },
  { id: 'select', main: 'Select', url: 'https://element-plus.org/zh-CN/component/select.html' },
  { id: 'form',   main: 'Form',   url: 'https://element-plus.org/zh-CN/component/form.html' },
  { id: 'table',  main: 'Table',  url: 'https://element-plus.org/zh-CN/component/table.html' },
];

// 把 URL 抽取的 apiJson 拍平为 { properties, events, slots }，只取主组件（按 main 名匹配）
function unwrapUrlApi(api, mainName) {
  if (!Array.isArray(api)) api = [api];
  // 找到主组件条目
  for (const item of api) {
    const cands = item && item.components ? Object.entries(item.components) : [['_', item]];
    for (const [k, v] of cands) {
      const candKey = (k || '').toLowerCase();
      if (candKey.includes(mainName.toLowerCase()) || (v && v.name && String(v.name).toLowerCase().includes(mainName.toLowerCase()))) {
        return { properties: v.properties || [], events: v.events || [], slots: v.slots || [] };
      }
    }
  }
  // 兜底取第一个
  const first = api[0];
  if (!first) return {};
  if (first.components) {
    const v = first.components[Object.keys(first.components)[0]] || {};
    return { properties: v.properties || [], events: v.events || [], slots: v.slots || [] };
  }
  return { properties: first.properties || [], events: first.events || [], slots: first.slots || [] };
}

function flatSource(sourceRow) {
  // run-source-real 已经把 extracted.props/events/slots 拍成 string 数组
  const e = sourceRow.extracted || {};
  return {
    properties: (e.props || []).map((n) => ({ name: n })),
    events: (e.events || []).map((n) => ({ name: n })),
    slots: (e.slots || []).map((n) => ({ name: n })),
  };
}

function fmt(f1) { return f1.toFixed(3); }

async function main() {
  const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground-truth.json'), 'utf8'));
  const sourceRows = JSON.parse(fs.readFileSync(path.join(__dirname, 'last-source-real.json'), 'utf8'));
  const sourceById = Object.fromEntries(sourceRows.map((r) => [r.name, r]));

  // URL 路径需要现场跑：之前 url-batch 没保存详细 names。这里一次性跑 + 存档。
  const urlOutFile = path.join(__dirname, 'last-url-real.json');
  let urlById = {};
  if (fs.existsSync(urlOutFile)) {
    const cached = JSON.parse(fs.readFileSync(urlOutFile, 'utf8'));
    urlById = Object.fromEntries(cached.map((r) => [r.id, r]));
    console.log(`(命中缓存 ${urlOutFile})`);
  }
  for (const c of COMPONENTS) {
    if (urlById[c.id]) continue;
    console.log(`[url:${c.id}] 跑...`);
    try {
      const api = await extractApiFromUrl(c.url, 'table');
      urlById[c.id] = { id: c.id, api };
    } catch (e) {
      urlById[c.id] = { id: c.id, err: e.message };
      console.log(`  FAIL: ${e.message}`);
    }
  }
  fs.writeFileSync(urlOutFile, JSON.stringify(COMPONENTS.map((c) => urlById[c.id]), null, 2));

  // 算分（用归一化后的名字消除 camelCase vs kebab-case 等命名规范差异）
  console.log(`\n=== 三方对照 + 归一化 F1（micro 整体；kebab-case + 剥版本号）===`);
  console.log('comp'.padEnd(8) + 'truth'.padStart(8) + ' | ' + 'src P/E/S'.padStart(11) + ' src F1'.padStart(9) + ' | ' + 'url P/E/S'.padStart(11) + ' url F1'.padStart(9));
  const rawRows = [];
  for (const c of COMPONENTS) {
    const t = truth[c.id];
    const truthExpectedRaw = {
      properties: (t.props || []).map((n) => ({ name: n })),
      events: (t.events || []).map((n) => ({ name: n })),
      slots: (t.slots || []).map((n) => ({ name: n })),
    };
    const truthExpected = normalizeBag(truthExpectedRaw);

    const srcRow = sourceById[c.id];
    const urlRow = urlById[c.id];

    const srcActual = normalizeBag(srcRow ? flatSource(srcRow) : {});
    const urlActual = normalizeBag((urlRow && !urlRow.err) ? unwrapUrlApi(urlRow.api, c.main) : {});

    const sSrc = scoreExtraction(truthExpected, srcActual);
    const sUrl = scoreExtraction(truthExpected, urlActual);
    rawRows.push({ id: c.id, src: sSrc, url: sUrl, truth: truthExpected, srcActual, urlActual });
    const truthSum = `${(t.props||[]).length}/${(t.events||[]).length}/${(t.slots||[]).length}`;
    const srcSum = `${srcActual.properties.length}/${srcActual.events.length}/${srcActual.slots.length}`;
    const urlSum = urlRow && !urlRow.err ? `${urlActual.properties.length}/${urlActual.events.length}/${urlActual.slots.length}` : 'FAIL';
    console.log(
      c.id.padEnd(8)
      + truthSum.padStart(8)
      + ' | '
      + srcSum.padStart(11) + fmt(sSrc.overall.f1).padStart(9)
      + ' | '
      + urlSum.padStart(11) + fmt(sUrl.overall.f1).padStart(9),
    );
  }

  console.log(`\n=== 细分（归一化后；仅列残余 miss/extra）===`);
  for (const row of rawRows) {
    console.log(`\n[${row.id}]`);
    for (const cat of ['properties', 'events', 'slots']) {
      const a = row.src.byCategory[cat];
      const b = row.url.byCategory[cat];
      console.log(`  ${cat.padEnd(10)} src F1=${fmt(a.f1)}  |  url F1=${fmt(b.f1)}`);
      if (a.missing.length) console.log(`    src missing: [${a.missing.join(', ')}]`);
      if (a.extra.length)   console.log(`    src extra:   [${a.extra.join(', ')}]`);
      if (b.missing.length) console.log(`    url missing: [${b.missing.join(', ')}]`);
      if (b.extra.length)   console.log(`    url extra:   [${b.extra.join(', ')}]`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
