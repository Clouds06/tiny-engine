/**
 * Schema 自我修复测试：callOpenAIModel 用机器可读物料 schema 校验输出，
 * 不合规则把错误反馈回模型重试，直到产出合规 schema。注入 mock client，无需 key。
 */

const test = require('node:test');
const assert = require('node:assert');
const { callOpenAIModel } = require('../src/schema-conversion/convertor');

function mockClient(contents) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          const c = contents[i++];
          if (c === undefined) throw new Error('mock 响应耗尽');
          return { choices: [{ message: { content: c } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
      },
    },
  };
}

const messages = [{ role: 'user', content: 'convert' }];
const validSchema = JSON.stringify({ component: 'ElButton', name: { zh_CN: '按钮' }, schema: { properties: [] } });

test('首次输出缺 component → 反馈重试 → 第二次合规', async () => {
  const client = mockClient([
    JSON.stringify({ name: { zh_CN: '按钮' }, schema: {} }), // 不合规：缺 component
    validSchema,
  ]);
  const { schemaText } = await callOpenAIModel(messages, 'm', 'ElButton', { client });
  assert.deepStrictEqual(JSON.parse(schemaText), JSON.parse(validSchema));
  assert.strictEqual(client.calls.length, 2); // 重试了一次
  // 第二次请求带上了纠错反馈（消息更多）
  assert.ok(client.calls[1].messages.length > client.calls[0].messages.length);
});

test('一次合规 → 不重试', async () => {
  const client = mockClient([validSchema]);
  const { schemaText } = await callOpenAIModel(messages, 'm', 'ElButton', { client });
  assert.deepStrictEqual(JSON.parse(schemaText), JSON.parse(validSchema));
  assert.strictEqual(client.calls.length, 1);
});
