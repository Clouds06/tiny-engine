/**
 * checkFileWithLLM 迁移后集成测试：通过注入 mock client，验证文件筛选在
 * 不调用真实 LLM 的情况下能正确解析结果，并在 LLM 输出始终不可用时优雅兜底为 false。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkFileWithLLM } = require('../src/file-collection/component-code-file-filter');

function mockClient(responses) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const r = responses[i++] ?? responses[responses.length - 1];
          return { choices: [{ message: { content: r } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
      },
    },
  };
}

function withTempFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfwl-'));
  const file = path.join(dir, 'Button.vue');
  fs.writeFileSync(file, contents);
  return Promise.resolve(fn(dir, file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('正常：mock 返回 hasApiInfo=true → 结果正确', async () => {
  await withTempFile('<script>defineProps({ size: String })</script>', async (dir, file) => {
    const res = await checkFileWithLLM(file, dir, { client: mockClient(['{"hasApiInfo": true}']) });
    assert.strictEqual(res.hasApiInfo, true);
    assert.strictEqual(res.fileName, 'Button.vue');
    assert.strictEqual(res.filePath, 'Button.vue'); // 相对 baseDir
    assert.ok(res.fileLength > 0);
  });
});

test('兜底：LLM 始终输出非法 JSON → 重试耗尽 → hasApiInfo=false（不抛）', async () => {
  await withTempFile('export const x = 1', async (dir, file) => {
    const res = await checkFileWithLLM(file, dir, { client: mockClient(['garbage not json']) });
    assert.strictEqual(res.hasApiInfo, false);
    assert.strictEqual(res.fileLength, 0); // 错误分支返回 fileLength 0
  });
});
