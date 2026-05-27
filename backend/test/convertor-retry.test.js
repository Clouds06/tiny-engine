/**
 * Stage C 批量转换的容错测试：单组件重试 + 软失败 + allSettled（一个组件失败不拖垮整批）。
 * 通过注入 mock convertFn，无需真实 LLM / key。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  convertSubComponentWithRetry,
  batchConvertToTinyEngineSchema,
} = require('../src/schema-conversion/convertor');

const apiObj = (name) => ({ name, components: { [name]: { properties: [] } } });

test('单组件：失败一次后重试成功 → 返回成功结果', async () => {
  let calls = 0;
  const convertFn = async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return { subComponentName: 'X', success: true };
  };
  const r = await convertSubComponentWithRetry(apiObj('X'), 'm', [], false, '/tmp', { retries: 1, convertFn });
  assert.strictEqual(r.success, true);
  assert.strictEqual(calls, 2);
});

test('单组件：重试耗尽 → 软失败（success:false，不抛）', async () => {
  const convertFn = async () => { throw new Error('boom'); };
  const r = await convertSubComponentWithRetry(apiObj('Y'), 'm', [], false, '/tmp', { retries: 1, convertFn });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.subComponentName, 'Y');
  assert.match(r.error, /boom/);
});

test('单组件：取消错误向上抛，不软化', async () => {
  const convertFn = async () => { throw new Error('任务被用户取消'); };
  await assert.rejects(
    () => convertSubComponentWithRetry(apiObj('Z'), 'm', [], false, '/tmp', { retries: 2, convertFn }),
    /取消/,
  );
});

test('批量：一个组件失败不拖垮整批，其余正常返回', async () => {
  const convertFn = async (obj) => {
    const name = Object.keys(obj.components)[0];
    if (name === 'B') throw new Error('B 挂了');
    return { subComponentName: name, success: true };
  };
  const results = await batchConvertToTinyEngineSchema(
    [apiObj('A'), apiObj('B'), apiObj('C')],
    'm',
    false, // save
    5, // concurrentLimit
    '/tmp',
    { retries: 0, convertFn },
  );
  assert.strictEqual(results.length, 3);
  const byName = Object.fromEntries(results.map((r) => [r.subComponentName, r]));
  assert.strictEqual(byName.A.success, true);
  assert.strictEqual(byName.C.success, true);
  assert.strictEqual(byName.B.success, false);
  assert.match(byName.B.error, /B 挂了/);
});
