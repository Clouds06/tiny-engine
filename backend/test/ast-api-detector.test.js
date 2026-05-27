/**
 * ast-api-detector 单元测试：纯静态解析，无需 LLM / key。
 */

const test = require('node:test');
const assert = require('node:assert');
const { detectComponentApi, scanScriptSignals, isEntryFile } = require('../src/file-collection/ast-api-detector');

test('Vue <script setup> defineProps → 命中', () => {
  const vue = `<script setup>\nconst props = defineProps({ size: String })\nconst emit = defineEmits(['change'])\n</script>\n<template><div/></template>`;
  const r = detectComponentApi('/x/Button.vue', vue);
  assert.strictEqual(r.decided, true);
  assert.strictEqual(r.hasApiInfo, true);
  assert.ok(r.signals.includes('defineProps'));
  assert.ok(r.signals.includes('defineEmits'));
});

test('Vue 仅模板含 <slot> → 命中 template-slot', () => {
  const vue = `<template><div><slot name="header" /></div></template>`;
  const r = detectComponentApi('/x/Card.vue', vue);
  assert.strictEqual(r.decided, true);
  assert.ok(r.signals.includes('template-slot'));
});

test('Options API props 选项 (.ts) → 命中 props-option', () => {
  const ts = `export default defineComponent({ name: 'Foo', props: { value: { type: Number } } })`;
  const r = detectComponentApi('/x/foo.ts', ts);
  assert.strictEqual(r.decided, true);
  assert.ok(r.signals.includes('props-option'));
});

test('入口文件 index.ts → 直接命中 entry-file', () => {
  const r = detectComponentApi('/x/components/form/index.ts', 'export { default } from "./Form.vue"');
  assert.strictEqual(r.decided, true);
  assert.strictEqual(r.reason, 'entry');
  assert.ok(r.signals.includes('entry-file'));
});

test('无 API 信号的工具文件 → decided=false（交给 LLM 兜底）', () => {
  const r = detectComponentApi('/x/utils/format.ts', 'export const fmt = (n) => n.toFixed(2)');
  assert.strictEqual(r.decided, false);
  assert.strictEqual(r.hasApiInfo, false);
});

test('不支持的扩展名（.css）→ decided=false', () => {
  const r = detectComponentApi('/x/style.css', '.a{color:red}');
  assert.strictEqual(r.decided, false);
});

test('解析失败的 .vue → decided=false（不武断判定）', () => {
  const r = detectComponentApi('/x/Broken.vue', '<script setup>const a = </script');
  assert.strictEqual(r.decided, false);
});

test('scanScriptSignals / isEntryFile 基础行为', () => {
  assert.deepStrictEqual(scanScriptSignals('withDefaults(defineProps())'), ['defineProps', 'withDefaults']);
  assert.strictEqual(isEntryFile('/a/b/index.vue'), true);
  assert.strictEqual(isEntryFile('/a/b/Button.vue'), false);
});
