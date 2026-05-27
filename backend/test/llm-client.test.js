/**
 * llm-client 单元测试（node:test，无需安装依赖）
 * 运行：node --test    或    npm test
 *
 * 通过注入 mock client 验证：JSON 提取 / schema 校验 / 失败重试 / token 计量 /
 * json_mode 降级 / 取消信号，全程不调用真实 LLM、不需要 API key。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  callLLM,
  parseJson,
  getUsageTotals,
  resetUsageTotals,
  LLMOutputError,
} = require('../src/llm/llm-client');

// 队列式 mock client：按顺序返回预设响应，或抛出预设错误。
function mockClient(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          const r = responses[i++];
          if (!r) throw new Error('mock client: 响应队列已耗尽');
          if (r.throw) throw r.throw;
          return {
            choices: [{ message: { content: r.content } }],
            usage: r.usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
}

const baseMessages = [{ role: 'user', content: 'hi' }];

test('happy path：解析 JSON 并返回 data + usage', async () => {
  resetUsageTotals();
  const client = mockClient([{ content: '{"hasApiInfo": true}', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]);
  const res = await callLLM({ messages: baseMessages, client, label: 'file-filter' });
  assert.deepStrictEqual(res.data, { hasApiInfo: true });
  assert.strictEqual(res.attempts, 1);
  assert.strictEqual(res.usage.total_tokens, 120);
  assert.strictEqual(getUsageTotals().total_tokens, 120);
  assert.strictEqual(getUsageTotals().byLabel['file-filter'].calls, 1);
});

test('去除 ```json 代码块围栏', async () => {
  const client = mockClient([{ content: '```json\n{"a": 1}\n```' }]);
  const res = await callLLM({ messages: baseMessages, client });
  assert.deepStrictEqual(res.data, { a: 1 });
});

test('JSON 解析失败 → 带纠错反馈重试 → 第二次成功', async () => {
  const client = mockClient([
    { content: 'not json at all' },
    { content: '{"ok": true}' },
  ]);
  const res = await callLLM({ messages: baseMessages, client, retries: 2 });
  assert.deepStrictEqual(res.data, { ok: true });
  assert.strictEqual(res.attempts, 2);
  // 第二次请求应携带纠错对话（assistant + user 反馈），消息数增加。
  assert.ok(client.calls[1].messages.length > client.calls[0].messages.length);
});

test('schema 校验失败 → 重试 → 最终成功', async () => {
  const client = mockClient([
    { content: '{"hasApiInfo": "yes"}' }, // 类型不对
    { content: '{"hasApiInfo": false}' },
  ]);
  const validate = (d) => typeof d.hasApiInfo === 'boolean';
  const res = await callLLM({ messages: baseMessages, client, validate, retries: 2 });
  assert.deepStrictEqual(res.data, { hasApiInfo: false });
  assert.strictEqual(res.attempts, 2);
});

test('重试耗尽 → 抛 LLMOutputError', async () => {
  const client = mockClient([
    { content: 'nope' },
    { content: 'still nope' },
  ]);
  await assert.rejects(
    () => callLLM({ messages: baseMessages, client, retries: 1 }),
    (err) => {
      assert.ok(err instanceof LLMOutputError);
      assert.strictEqual(err.attempts, 2);
      return true;
    },
  );
});

test('zod 风格 safeParse 校验器也被支持', async () => {
  const client = mockClient([{ content: '{"n": 42}' }]);
  const zodLike = {
    safeParse: (d) => (typeof d.n === 'number' ? { success: true, data: { n: d.n, normalized: true } } : { success: false, error: { message: 'n 必须是数字' } }),
  };
  const res = await callLLM({ messages: baseMessages, client, validate: zodLike });
  assert.deepStrictEqual(res.data, { n: 42, normalized: true });
});

test('供应商不支持 response_format → 自动降级并重试（不消耗重试名额）', async () => {
  const client = mockClient([
    { throw: new Error("This model does not support 'response_format'.") },
    { content: '{"ok": 1}' },
  ]);
  const res = await callLLM({ messages: baseMessages, client, jsonMode: true, retries: 0 });
  assert.deepStrictEqual(res.data, { ok: 1 });
  // 第一次请求带 response_format，降级后第二次不带。
  assert.ok(client.calls[0].response_format);
  assert.strictEqual(client.calls[1].response_format, undefined);
});

test('已取消的 signal → 立即抛取消错误，不调用模型', async () => {
  const client = mockClient([{ content: '{"x":1}' }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => callLLM({ messages: baseMessages, client, signal: controller.signal }),
    /取消/,
  );
  assert.strictEqual(client.calls.length, 0);
});

test('parseJson 工具函数：直接解析与去围栏', () => {
  assert.deepStrictEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(parseJson('```json\n[1,2,3]\n```'), [1, 2, 3]);
  assert.throws(() => parseJson('garbage'));
});
