/**
 * 提取准确率评分函数单测（纯函数，零密钥）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { scoreExtraction, toNameSet } = require('../eval/score');

test('完全命中 → 各类 F1 与整体 F1 均为 1', () => {
  const gold = { properties: [{ name: 'size' }, { name: 'type' }], events: [{ name: 'click' }], slots: [{ name: 'default' }] };
  const s = scoreExtraction(gold, gold);
  assert.strictEqual(s.byCategory.properties.f1, 1);
  assert.strictEqual(s.overall.f1, 1);
});

test('漏提 + 多提 → 反映在 missing / extra 与 P/R', () => {
  const gold = { properties: [{ name: 'size' }, { name: 'type' }, { name: 'disabled' }], events: [{ name: 'click' }], slots: [] };
  const actual = { properties: [{ name: 'size' }, { name: 'wrongProp' }], events: [{ name: 'click' }], slots: [] };
  const s = scoreExtraction(gold, actual);
  const p = s.byCategory.properties;
  assert.deepStrictEqual(p.missing.sort(), ['disabled', 'type']);
  assert.deepStrictEqual(p.extra, ['wrongProp']);
  assert.strictEqual(p.tp, 1);
  assert.strictEqual(p.precision, 1 / 2); // 1 命中 / 2 提取
  assert.strictEqual(p.recall, 1 / 3); // 1 命中 / 3 期望
});

test('期望与实际都为空的类别 → 视为完全正确(1)', () => {
  const s = scoreExtraction({ slots: [] }, { slots: [] });
  assert.strictEqual(s.byCategory.slots.f1, 1);
});

test('整体使用 micro 平均（按 tp/expected/actual 汇总）', () => {
  const gold = { properties: [{ name: 'a' }, { name: 'b' }], events: [{ name: 'x' }], slots: [] };
  const actual = { properties: [{ name: 'a' }], events: [{ name: 'x' }, { name: 'y' }], slots: [] };
  const s = scoreExtraction(gold, actual);
  // tp = props(a)=1 + events(x)=1 = 2; expected = 2+1 = 3; actual = 1+2 = 3
  assert.strictEqual(s.overall.tp, 2);
  assert.strictEqual(s.overall.expected, 3);
  assert.strictEqual(s.overall.actual, 3);
  assert.strictEqual(s.overall.precision, 2 / 3);
  assert.strictEqual(s.overall.recall, 2 / 3);
});

test('toNameSet 兼容 [{name}] 与 [string]，并去重去空', () => {
  assert.deepStrictEqual([...toNameSet([{ name: 'a' }, 'b', { name: '' }, null, 'a'])].sort(), ['a', 'b']);
});
