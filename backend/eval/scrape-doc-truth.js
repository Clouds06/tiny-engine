/**
 * 从 element-plus 官方文档抓取每个组件的 props/events/slots 真实名称作为 ground truth。
 * 直接读 DOM 表格、不调 LLM —— 与源码路径、URL（LLM 分类）路径做三方对照。
 *
 *   node eval/scrape-doc-truth.js
 *
 * 写到 eval/ground-truth.json。
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });
const puppeteer = require('puppeteer');

const TARGETS = [
  { id: 'button', main: 'Button', url: 'https://element-plus.org/zh-CN/component/button.html' },
  { id: 'input',  main: 'Input',  url: 'https://element-plus.org/zh-CN/component/input.html' },
  { id: 'select', main: 'Select', url: 'https://element-plus.org/zh-CN/component/select.html' },
  { id: 'form',   main: 'Form',   url: 'https://element-plus.org/zh-CN/component/form.html' },
  { id: 'table',  main: 'Table',  url: 'https://element-plus.org/zh-CN/component/table.html' },
];

async function scrape(page, target) {
  await page.goto(target.url, { waitUntil: 'networkidle2', timeout: 60000 });
  // 给文档异步加载留点时间
  await new Promise((r) => setTimeout(r, 1500));
  return await page.evaluate((mainName) => {
    const content = document.querySelector('.vp-doc') || document.querySelector('main') || document.body;
    const all = content.querySelectorAll('h2, h3, table');
    const sections = [];
    let h2 = null;
    let h3 = null;
    for (const el of all) {
      if (el.tagName === 'H2') { h2 = el.textContent.trim(); h3 = null; }
      else if (el.tagName === 'H3') { h3 = el.textContent.trim(); }
      else if (el.tagName === 'TABLE') {
        const rows = Array.from(el.querySelectorAll('tbody tr')).map((tr) =>
          Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.replace(/\s+/g, ' ').trim()),
        );
        sections.push({ h2, h3, rows });
      }
    }

    // element-plus 实际结构：h3 = "<Component> <Category>"（如 "Button Attributes"）。
    // 用 h3 做主组件 + 类目匹配，避免抓到 ButtonGroup/Option 等同页子组件。
    const props = new Set();
    const events = new Set();
    const slots = new Set();
    const debug = [];
    const lowerMain = mainName.toLowerCase();

    const BARE = new Set(['attributes', '属性', 'props', 'events', '事件', 'slots', '插槽']);
    for (const s of sections) {
      const raw = (s.h3 || '').replace(/[\s​#]+$/g, '').trim();
      const lower = raw.toLowerCase();
      // 接受两种风格：① "Button Attributes"（带主组件前缀，避免 ButtonGroup 误收）
      //               ② "Attributes"（裸命名，整页只一套时常见）
      const isPrefixed = lower === lowerMain || lower.startsWith(lowerMain + ' ');
      const isBare = BARE.has(lower);
      if (!isPrefixed && !isBare) continue;
      const rest = isPrefixed ? lower.slice(lowerMain.length).trim() : lower;
      let cat = null;
      if (rest.includes('attribute') || rest.includes('属性') || rest.includes('prop')) cat = 'props';
      else if (rest.includes('event') || rest.includes('事件')) cat = 'events';
      else if (rest.includes('slot') || rest.includes('插槽')) cat = 'slots';
      if (!cat) { debug.push({ h2: s.h2, h3: s.h3, note: 'unclassified-but-main' }); continue; }
      const target = { props, events, slots }[cat];
      for (const r of s.rows) {
        const name = (r[0] || '').trim();
        if (name) target.add(name);
      }
      debug.push({ h2: s.h2, h3: s.h3, cat, n: s.rows.length });
    }

    return {
      props: [...props],
      events: [...events],
      slots: [...slots],
      debug,
    };
  }, target.main);
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const out = {};
  try {
    for (const t of TARGETS) {
      const page = await browser.newPage();
      console.log(`[${t.id}] 抓取 ${t.url}`);
      const r = await scrape(page, t);
      out[t.id] = r;
      console.log(`  props=${r.props.length}  events=${r.events.length}  slots=${r.slots.length}`);
      for (const d of r.debug) {
        if (d.note) console.log(`    (未归类) h2="${d.h2}" h3="${d.h3}"`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const outPath = path.join(__dirname, 'ground-truth.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n写入: ${outPath}`);
})().catch((e) => { console.error(e); process.exit(1); });
