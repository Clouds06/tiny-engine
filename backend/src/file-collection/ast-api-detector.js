/**
 * 确定性组件 API 探测（AST / 正则），用于在调用 LLM 前先做一轮"白名单"判定。
 *
 * 设计原则——高召回优先：
 *   - 命中 props/emits/slots 信号或入口文件 → decided=true 直接判 hasApiInfo，跳过 LLM；
 *   - 没命中任何信号 → decided=false，交回调用方用 LLM 兜底（不武断判 false）。
 * 这样确定有 API 的文件免去一次 LLM 调用，又不会因为静态分析的盲区漏掉文件。
 */

const path = require('path');
const { parse } = require('@vue/compiler-sfc');

const SCRIPT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function isEntryFile(filePath) {
  const name = path.basename(filePath).replace(/\.(vue|tsx?|jsx?|mjs|cjs)$/i, '').toLowerCase();
  return name === 'index';
}

// 在脚本文本中扫描组件 API 信号（同时覆盖 <script setup> 宏与 Options API）
function scanScriptSignals(code) {
  if (typeof code !== 'string' || code === '') return [];
  const signals = [];
  if (/\bdefineProps\s*[<(]/.test(code)) signals.push('defineProps');
  if (/\bdefineEmits\s*[<(]/.test(code)) signals.push('defineEmits');
  if (/\bdefineSlots\s*[<(]/.test(code)) signals.push('defineSlots');
  if (/\bwithDefaults\s*\(/.test(code)) signals.push('withDefaults');
  if (/\bprops\s*:\s*[{[]/.test(code)) signals.push('props-option');
  if (/\bemits\s*:\s*[[{]/.test(code)) signals.push('emits-option');
  return signals;
}

function detectVue(content) {
  let descriptor;
  try {
    const parsed = parse(content);
    if (parsed.errors && parsed.errors.length) {
      return { decided: false, signals: [], reason: 'sfc-parse-error' };
    }
    descriptor = parsed.descriptor;
  } catch (e) {
    return { decided: false, signals: [], reason: 'sfc-parse-throw' };
  }

  const signals = new Set();

  // 扫原始 script 内容：compileScript 会把 defineProps 等宏编译掉，
  // 编译后文本不含宏名，反而扫不到信号，所以直接看原始 <script> / <script setup>。
  const scriptCode = `${descriptor.scriptSetup?.content || ''}\n${descriptor.script?.content || ''}`;
  scanScriptSignals(scriptCode).forEach((s) => signals.add(s));

  // 模板中出现 <slot> 即代表对外暴露插槽
  if (descriptor.template && /<slot[\s/>]/.test(descriptor.template.content)) {
    signals.add('template-slot');
  }

  return { decided: signals.size > 0, signals: [...signals], reason: 'vue-sfc' };
}

function detectScript(content) {
  const signals = scanScriptSignals(content);
  return { decided: signals.length > 0, signals, reason: 'script' };
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {{ hasApiInfo: boolean, decided: boolean, signals: string[], reason: string }}
 */
function detectComponentApi(filePath, content) {
  if (isEntryFile(filePath)) {
    return { hasApiInfo: true, decided: true, signals: ['entry-file'], reason: 'entry' };
  }

  const ext = path.extname(filePath).toLowerCase();
  let r;
  if (ext === '.vue') {
    r = detectVue(content);
  } else if (SCRIPT_EXTS.has(ext)) {
    r = detectScript(content);
  } else {
    return { hasApiInfo: false, decided: false, signals: [], reason: 'unsupported-ext' };
  }

  if (r.decided) {
    return { hasApiInfo: true, decided: true, signals: r.signals, reason: r.reason };
  }
  return { hasApiInfo: false, decided: false, signals: [], reason: r.reason };
}

module.exports = { detectComponentApi, scanScriptSignals, isEntryFile };
