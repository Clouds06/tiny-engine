/**
 * Prompt 前缀稳定性测试：验证 schema 转换的巨型指令是逐字节稳定的前缀，
 * per-component 变量只出现在末尾的「输入数据」消息里 —— 这是命中模型侧
 * prefix / context caching 的前提。无需 LLM / key。
 */

const test = require('node:test');
const assert = require('node:assert');
const { initContextAndBuildPrompt } = require('../src/schema-conversion/convertor');

// 用绝不会出现在指令/示例文案里的 sentinel，避免与 prompt 内置示例（如 ElTabs/ElOption）撞名
const apiA = { name: 'Button', url: 'https://a', components: { Zzcomp_A: { properties: [{ name: 'propsentinel_aaa', type: 'string' }] } } };
const apiB = { name: 'Input', components: { Zzcomp_B: { properties: [{ name: 'propsentinel_bbb', type: 'string' }] } } };

test('系统消息与巨型指令在不同输入下逐字节相同（稳定前缀）', () => {
  const a = initContextAndBuildPrompt(apiA, ['relsentinel_aaa']);
  const b = initContextAndBuildPrompt(apiB, ['relsentinel_bbb', 'relsentinel_ccc']);

  assert.strictEqual(a.messages.length, 3);
  assert.strictEqual(a.messages[0].role, 'system');
  assert.strictEqual(a.messages[1].role, 'user'); // 巨型静态指令
  assert.strictEqual(a.messages[2].role, 'user'); // per-component 变量

  // 前缀（system + 巨型指令）必须完全一致
  assert.strictEqual(a.messages[0].content, b.messages[0].content);
  assert.strictEqual(a.messages[1].content, b.messages[1].content);
});

test('巨型指令前缀不含任何 per-component 数据', () => {
  const a = initContextAndBuildPrompt(apiA, ['relsentinel_aaa']);
  const prefix = a.messages[0].content + a.messages[1].content;
  assert.ok(!prefix.includes('propsentinel_aaa'), '前缀不应含组件属性数据');
  assert.ok(!prefix.includes('relsentinel_aaa'), '前缀不应含关联子组件名');
  assert.ok(!prefix.includes('Zzcomp_A'), '前缀不应含子组件名');
});

test('变量只落在末尾「输入数据」消息，且随输入变化', () => {
  const a = initContextAndBuildPrompt(apiA, ['relsentinel_aaa']);
  const b = initContextAndBuildPrompt(apiB, ['relsentinel_bbb', 'relsentinel_ccc']);

  assert.ok(a.messages[2].content.includes('propsentinel_aaa'));
  assert.ok(a.messages[2].content.includes('relsentinel_aaa'));
  assert.notStrictEqual(a.messages[2].content, b.messages[2].content);
  assert.ok(b.messages[2].content.includes('propsentinel_bbb'));
  assert.ok(b.messages[2].content.includes('relsentinel_ccc'));
});
