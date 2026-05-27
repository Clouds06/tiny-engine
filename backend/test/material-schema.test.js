/**
 * TinyEngine 物料 schema 校验器单测（纯函数，零密钥）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateMaterialSchema } = require('../src/schema-conversion/material-schema');

const valid = {
  component: 'ElButton',
  name: { zh_CN: '按钮' },
  schema: { properties: [], events: {}, slots: {} },
};

test('合法单个物料 → success', () => {
  const r = validateMaterialSchema(valid);
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.data, valid);
});

test('合法物料数组 → success', () => {
  const r = validateMaterialSchema([valid, { component: 'ElButtonGroup', name: { zh_CN: '按钮组' }, schema: {} }]);
  assert.strictEqual(r.success, true);
});

test('缺 component → 失败并指出', () => {
  const r = validateMaterialSchema({ name: { zh_CN: '按钮' }, schema: {} });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /component/);
});

test('缺 name.zh_CN → 失败并指出', () => {
  const r = validateMaterialSchema({ component: 'ElButton', schema: {} });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /name\.zh_CN/);
});

test('schema.properties 类型错误（对象而非数组）→ 失败', () => {
  const r = validateMaterialSchema({ component: 'X', name: { zh_CN: 'x' }, schema: { properties: {} } });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /properties 应为数组/);
});

test('空数组 → 失败', () => {
  const r = validateMaterialSchema([]);
  assert.strictEqual(r.success, false);
});

test('数组中某项非法 → 失败并带下标', () => {
  const r = validateMaterialSchema([valid, { component: '', name: { zh_CN: 'y' }, schema: {} }]);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /#1/);
});

test('多项错误合并到一条 error', () => {
  const r = validateMaterialSchema({});
  assert.strictEqual(r.success, false);
  assert.match(r.error, /component/);
  assert.match(r.error, /name\.zh_CN/);
  assert.match(r.error, /schema/);
});
