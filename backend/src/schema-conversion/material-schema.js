/**
 * TinyEngine 物料协议的机器可读校验器。
 *
 * 把原本只散落在 ~1100 行 prompt 文案里的"输出形态"固化为一个可程序化校验的函数，
 * 既能在转换后做结构校验，也能作为统一调用层（llm-client）的 validate 直接驱动
 * "校验失败→带错误反馈重试"的自我修复闭环。
 *
 * 返回 zod 风格的结果：{ success: true, data } | { success: false, error }。
 *
 * 校验范围（务实，不强求覆盖整份协议）：
 *   - 必需：component(非空字符串)、name.zh_CN(字符串)、schema(对象)
 *   - 类型约束（出现才校验）：schema.properties 为数组；schema.events / schema.slots 为对象
 *   - 接受单个物料对象，或非空的物料对象数组（多组件场景）
 */

function validateOne(m, idx) {
  const at = idx === undefined ? '' : `[#${idx}] `;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [`${at}物料应为对象`];

  const errors = [];
  if (typeof m.component !== 'string' || m.component.trim() === '') {
    errors.push(`${at}缺少或非法 component（应为非空字符串）`);
  }
  if (!m.name || typeof m.name !== 'object' || Array.isArray(m.name) || typeof m.name.zh_CN !== 'string') {
    errors.push(`${at}缺少 name.zh_CN（应为 { "zh_CN": string }）`);
  }
  if (!m.schema || typeof m.schema !== 'object' || Array.isArray(m.schema)) {
    errors.push(`${at}缺少或非法 schema（应为对象）`);
  } else {
    const s = m.schema;
    if (s.properties !== undefined && !Array.isArray(s.properties)) {
      errors.push(`${at}schema.properties 应为数组`);
    }
    if (s.events !== undefined && (typeof s.events !== 'object' || Array.isArray(s.events))) {
      errors.push(`${at}schema.events 应为对象`);
    }
    if (s.slots !== undefined && (typeof s.slots !== 'object' || Array.isArray(s.slots))) {
      errors.push(`${at}schema.slots 应为对象`);
    }
  }
  return errors;
}

function validateMaterialSchema(input) {
  let errors = [];
  if (Array.isArray(input)) {
    if (input.length === 0) {
      errors.push('物料 schema 数组为空');
    } else {
      input.forEach((m, i) => {
        errors = errors.concat(validateOne(m, i));
      });
    }
  } else {
    errors = validateOne(input);
  }

  if (errors.length) {
    return { success: false, error: errors.join('；') };
  }
  return { success: true, data: input };
}

module.exports = { validateMaterialSchema };
