/**
 * 提取准确率评分：把"提取出的组件 API"与"金标准"按 properties/events/slots 三类
 * 做基于名称集合的 precision / recall / F1 比对，给出每类与整体（micro 平均）指标，
 * 以及 missing（漏提）/ extra（多提）明细。
 *
 * 纯函数，无副作用，可脱离 LLM 单测。
 */

const CATEGORIES = ['properties', 'events', 'slots'];

// 从 [{name}] 或 ['name'] 提取去重后的名称集合
function toNameSet(arr) {
  return new Set(
    (Array.isArray(arr) ? arr : [])
      .map((x) => (typeof x === 'string' ? x : x && x.name))
      .filter((n) => typeof n === 'string' && n !== ''),
  );
}

function prf(expectedSet, actualSet) {
  let tp = 0;
  for (const n of actualSet) if (expectedSet.has(n)) tp += 1;
  // 约定：期望与实际都为空 → 视为完全正确（1）；只有一边为空时按定义取 0。
  const precision = actualSet.size ? tp / actualSet.size : (expectedSet.size ? 0 : 1);
  const recall = expectedSet.size ? tp / expectedSet.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision,
    recall,
    f1,
    tp,
    expected: expectedSet.size,
    actual: actualSet.size,
    missing: [...expectedSet].filter((n) => !actualSet.has(n)),
    extra: [...actualSet].filter((n) => !expectedSet.has(n)),
  };
}

/**
 * @param {{properties?:any[],events?:any[],slots?:any[]}} expected 金标准
 * @param {{properties?:any[],events?:any[],slots?:any[]}} actual   提取结果
 */
function scoreExtraction(expected, actual) {
  const byCategory = {};
  let tpSum = 0;
  let expSum = 0;
  let actSum = 0;
  for (const cat of CATEGORIES) {
    const r = prf(toNameSet(expected && expected[cat]), toNameSet(actual && actual[cat]));
    byCategory[cat] = r;
    tpSum += r.tp;
    expSum += r.expected;
    actSum += r.actual;
  }
  const precision = actSum ? tpSum / actSum : (expSum ? 0 : 1);
  const recall = expSum ? tpSum / expSum : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { byCategory, overall: { precision, recall, f1, tp: tpSum, expected: expSum, actual: actSum } };
}

module.exports = { scoreExtraction, toNameSet, CATEGORIES };
