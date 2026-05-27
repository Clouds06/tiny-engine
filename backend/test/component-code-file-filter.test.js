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

test('LLM 路径：AST 不命中时回退 LLM，解析 hasApiInfo', async () => {
  // 无 props/emits/slots 信号的 SFC → AST decided=false → 走 LLM
  await withTempFile('<template><div>plain content, no api macros</div></template>', async (dir, file) => {
    const res = await checkFileWithLLM(file, dir, { client: mockClient(['{"hasApiInfo": true}']) });
    assert.strictEqual(res.hasApiInfo, true);
    assert.strictEqual(res.detectedBy, 'llm');
    assert.strictEqual(res.fileName, 'Button.vue');
    assert.strictEqual(res.filePath, 'Button.vue'); // 相对 baseDir
    assert.ok(res.fileLength > 0);
  });
});

test('兜底：LLM 始终输出非法 JSON → 重试耗尽 → hasApiInfo=false（不抛）', async () => {
  // 用纯工具文件，确保 AST 不命中、走到 LLM 兜底分支
  await withTempFile('export const x = 1', async (dir, file) => {
    const res = await checkFileWithLLM(file, dir, { client: mockClient(['garbage not json']) });
    assert.strictEqual(res.hasApiInfo, false);
    assert.strictEqual(res.fileLength, 0); // 错误分支返回 fileLength 0
  });
});

test('AST 命中 → 完全跳过 LLM（client 被调用即失败）', async () => {
  const throwingClient = {
    chat: { completions: { create: async () => { throw new Error('LLM 不应被调用'); } } },
  };
  const vue = '<script setup>\ndefineProps({ size: String })\n</script>\n<template><div/></template>';
  await withTempFile(vue, async (dir, file) => {
    const res = await checkFileWithLLM(file, dir, { client: throwingClient });
    assert.strictEqual(res.hasApiInfo, true);
    assert.strictEqual(res.detectedBy, 'ast');
    assert.ok(res.signals.includes('defineProps'));
  });
});
