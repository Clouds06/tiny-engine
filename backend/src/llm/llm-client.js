/**
 * 统一 LLM 调用层
 *
 * 把原本散落在 5 个文件里的 `new OpenAI()` + `chat.completions.create` + 手工抠 JSON
 * 收敛到一处，统一提供：
 *   1. 结构化输出：可选开启 response_format=json_object，并对解析结果做 schema 校验
 *   2. 失败重试：解析/校验失败时带纠错反馈重试，而不是直接丢弃整个组件
 *   3. token 计量：累加每次调用的 usage，供成本统计
 *
 * openai 采用懒加载：只有真正需要默认 client 时才 require('openai')，
 * 这样注入 mock client 的单元测试无需安装依赖即可运行。
 */

let _OpenAI = null;
let _defaultClient = null;

function getDefaultClient() {
  if (_defaultClient) return _defaultClient;
  if (!_OpenAI) {
    _OpenAI = require('openai').OpenAI;
  }
  _defaultClient = new _OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    timeout: 600000,
  });
  return _defaultClient;
}

// 进程级 token 累计。按调用标签分桶，便于分析各阶段（筛选/提取/转换）的成本占比。
const usageTotals = {
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  byLabel: {},
};

function recordUsage(label, usage) {
  if (!usage) return;
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  const total = usage.total_tokens || prompt + completion;
  usageTotals.calls += 1;
  usageTotals.prompt_tokens += prompt;
  usageTotals.completion_tokens += completion;
  usageTotals.total_tokens += total;
  const key = label || 'unlabeled';
  const bucket = usageTotals.byLabel[key] || { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  bucket.calls += 1;
  bucket.prompt_tokens += prompt;
  bucket.completion_tokens += completion;
  bucket.total_tokens += total;
  usageTotals.byLabel[key] = bucket;
}

function getUsageTotals() {
  return JSON.parse(JSON.stringify(usageTotals));
}

function resetUsageTotals() {
  usageTotals.calls = 0;
  usageTotals.prompt_tokens = 0;
  usageTotals.completion_tokens = 0;
  usageTotals.total_tokens = 0;
  usageTotals.byLabel = {};
}

/**
 * 从模型返回文本中提取 JSON 字符串：去掉 ```json / ``` 代码块围栏，再做一次裁剪。
 * 不直接 JSON.parse，由调用方决定如何解析，便于复用。
 */
function stripJsonFences(text) {
  if (typeof text !== 'string') {
    throw new Error('模型返回内容非字符串');
  }
  let content = text.trim();
  if (content === '') {
    throw new Error('模型返回内容为空');
  }
  const fenced = content.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && fenced[1]) {
    content = fenced[1].trim();
  }
  return content;
}

function parseJson(text) {
  const cleaned = stripJsonFences(text);
  return JSON.parse(cleaned);
}

/**
 * 统一校验入口：
 * - 传 zod schema（含 safeParse）→ 走 zod
 * - 传 (data) => boolean | { success, data?, error? } 的谓词函数 → 走函数
 * - 不传 → 不校验，原样返回
 */
function runValidate(validate, data) {
  if (!validate) return { success: true, data };
  if (typeof validate.safeParse === 'function') {
    const r = validate.safeParse(data);
    return r.success ? { success: true, data: r.data } : { success: false, error: r.error?.message || 'schema 校验失败' };
  }
  if (typeof validate === 'function') {
    const r = validate(data);
    if (r === true) return { success: true, data };
    if (r === false) return { success: false, error: '校验未通过' };
    return r; // 已是 { success, data?, error? }
  }
  return { success: true, data };
}

class LLMOutputError extends Error {
  constructor(message, { raw, attempts } = {}) {
    super(message);
    this.name = 'LLMOutputError';
    this.raw = raw;
    this.attempts = attempts;
  }
}

/**
 * 调用 LLM 并返回经解析 + 校验的结构化结果。
 *
 * @param {Object} opts
 * @param {Array} opts.messages           chat messages
 * @param {string} [opts.model]           默认取 env OPENAI_MODEL
 * @param {number} [opts.temperature=0.2]
 * @param {number} [opts.maxTokens=65536]
 * @param {boolean} [opts.jsonMode=true]  是否开启 response_format=json_object
 * @param {*} [opts.validate]             zod schema 或谓词函数
 * @param {number} [opts.retries=2]       解析/校验失败的额外重试次数
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.label]           用于 token 分桶（如 'file-filter'）
 * @param {Object} [opts.client]          注入的 client（测试用），默认懒加载真实 client
 * @returns {Promise<{ data:any, raw:string, usage:object, attempts:number }>}
 */
async function callLLM(opts) {
  const {
    messages,
    model = process.env.OPENAI_MODEL || 'Qwen/Qwen3-32B',
    temperature = 0.2,
    maxTokens = 65536,
    jsonMode = true,
    validate,
    retries = 2,
    signal,
    label,
    client = getDefaultClient(),
  } = opts;

  let useJsonMode = jsonMode;
  let lastError = null;
  let lastRaw = '';
  const convo = [...messages];

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new Error('任务被用户取消');

    const request = { model, messages: [...convo], temperature, max_tokens: maxTokens, signal };
    if (useJsonMode) request.response_format = { type: 'json_object' };

    let completion;
    try {
      completion = await client.chat.completions.create(request);
    } catch (err) {
      // 部分 OpenAI 兼容供应商不支持 response_format，识别到就降级后重试，不消耗重试名额。
      if (useJsonMode && /response_format|json/i.test(err?.message || '')) {
        useJsonMode = false;
        attempt -= 1;
        continue;
      }
      throw err;
    }

    recordUsage(label, completion.usage);

    if (!completion.choices?.length || !completion.choices[0].message?.content) {
      lastError = '模型返回内容为空或无 choices';
      continue;
    }

    const raw = completion.choices[0].message.content.trim();
    lastRaw = raw;

    let parsed;
    try {
      parsed = parseJson(raw);
    } catch (e) {
      lastError = `JSON 解析失败：${e.message}`;
      convo.push({ role: 'assistant', content: raw });
      convo.push({ role: 'user', content: `上面的输出不是合法 JSON（${e.message}）。请只返回严格合法的 JSON，不要包含任何解释或代码块标记。` });
      continue;
    }

    const checked = runValidate(validate, parsed);
    if (!checked.success) {
      lastError = `输出不符合预期结构：${checked.error}`;
      convo.push({ role: 'assistant', content: raw });
      convo.push({ role: 'user', content: `上面的输出不符合要求（${checked.error}）。请修正后只返回严格合法、符合约定结构的 JSON。` });
      continue;
    }

    return {
      data: checked.data !== undefined ? checked.data : parsed,
      raw,
      usage: completion.usage || null,
      attempts: attempt + 1,
    };
  }

  throw new LLMOutputError(`LLM 输出在 ${retries + 1} 次尝试后仍不可用：${lastError}`, { raw: lastRaw, attempts: retries + 1 });
}

module.exports = {
  callLLM,
  parseJson,
  stripJsonFences,
  runValidate,
  recordUsage,
  getUsageTotals,
  resetUsageTotals,
  getDefaultClient,
  LLMOutputError,
};
