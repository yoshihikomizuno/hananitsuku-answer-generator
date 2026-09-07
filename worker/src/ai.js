/* ==========================================================
   ai.js — Workers AI の呼び出し
   - モデルは候補列を先頭から順に試す（教訓067: モデルは予告なく廃止される）
   - 応答形式の違い（response / choices / output）を extractText() が吸収する
   - 「枠切れ」系のエラーは即座に打ち切って上へ返す（教訓005: 枠切れ後のリトライは無意味）
   ========================================================== */

export const DEFAULT_MODELS = [
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
];

const MAX_OUTPUT_TOKENS = 900;
const TEMPERATURE = 0.9;
/** 1モデルあたりの待ち上限。Playground 実測（2026-09-07）で gemma-4 は推論込みで約30秒かかることがある */
export const PER_MODEL_TIMEOUT_MS = 40000;

/** OpenAI 互換の入力スキーマ（max_completion_tokens）を使うモデルの接頭辞 */
const OPENAI_STYLE_PREFIXES = ['@cf/google/gemma-4'];

export class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export class UpstreamError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'UpstreamError';
    this.attempts = attempts;
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export const parseModelList = (value) => {
  const list = String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_MODELS;
};

export const buildParams = (model, messages) => {
  if (OPENAI_STYLE_PREFIXES.some((p) => model.startsWith(p))) {
    return {
      messages,
      // 推論トークンも出力枠を消費するため、本文が空にならないよう広めに取る（使った分だけ課金）
      max_completion_tokens: MAX_OUTPUT_TOKENS * 3,
      temperature: TEMPERATURE,
      reasoning_effort: 'low',
    };
  }
  return { messages, max_tokens: MAX_OUTPUT_TOKENS, temperature: TEMPERATURE };
};

const contentToString = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
};

/** Workers AI の各種応答形式から本文を取り出す（見つからなければ空文字） */
export const extractText = (result) => {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  if (result.result && typeof result.result.response === 'string') return result.result.response;
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  if (choice) {
    if (choice.message) {
      const text = contentToString(choice.message.content);
      if (text) return text;
    }
    if (typeof choice.text === 'string') return choice.text;
  }
  if (Array.isArray(result.output)) {
    const parts = [];
    for (const item of result.output) {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
            parts.push(c.text);
          }
        }
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  if (typeof result.output_text === 'string') return result.output_text;
  return '';
};

/** 思考タグ・ラベル・コードフェンスなど、本文以外の飾りを落とす */
export const cleanReply = (raw) => {
  let text = String(raw || '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 閉じ忘れの思考ブロック（先頭が <think> で </think> が無い）は丸ごと落とす
  if (/^\s*<think>/i.test(text) && !/<\/think>/i.test(text)) return '';
  text = text.replace(/<\|channel\|>[\s\S]*?<\|message\|>/g, '');
  text = text.replace(/<\|[^|]*\|>/g, '');
  text = text.trim();
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(?:返事|返信|回答|本文|reply|answer)\s*[:：]\s*/i, '');
  text = text.replace(/^【(?:返事|返信|回答|本文)】\s*/, '');
  return text.trim();
};

/** 空応答の診断用。本文は含めず、キー名・長さ・終了理由・トークン数だけを返す */
export const describeShape = (result) => {
  if (result == null || typeof result !== 'object') return { type: typeof result };
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = message ? message.content : undefined;
  const rawText = typeof result.response === 'string' ? result.response : '';
  return {
    keys: Object.keys(result).join(','),
    choiceKeys: choice ? Object.keys(choice).join(',') : null,
    messageKeys: message ? Object.keys(message).join(',') : null,
    contentType: Array.isArray(content) ? 'array' : typeof content,
    contentLength: typeof content === 'string' ? content.length : Array.isArray(content) ? content.length : null,
    contentHead: typeof content === 'string' ? content.slice(0, 12) : null,
    reasoningLength: message && typeof message.reasoning_content === 'string' ? message.reasoning_content.length : null,
    responseLength: rawText.length,
    finishReason: choice ? choice.finish_reason : null,
    usage: result.usage || null,
  };
};

const QUOTA_PATTERN =/neuron|daily|per day|quota|allocation|budget|3040|2003|insufficient/i;
const RATE_PATTERN = /429|rate.?limit|too many|capacity|overloaded/i;

export const classifyError = (err) => {
  const message = err && err.message ? String(err.message) : String(err);
  if (QUOTA_PATTERN.test(message)) return 'quota';
  if (RATE_PATTERN.test(message)) return 'rate';
  return 'other';
};

const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timeout after ${ms}ms (${label})`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/**
 * 候補モデルを順に試し、最初に本文が得られたものを返す。
 * - 未提供・入力不正・空応答 → 次のモデルへ
 * - 枠切れ／レート制限 → 即座に上へ（次を試しても同じ枠で失敗する）
 * - タイムアウト → 即座に上へ（系統的な遅延の可能性が高く、待ち時間を重ねない）
 * @param {{ run: Function }} ai  env.AI 相当
 * @param {Array} messages        [{role, content}]
 * @param {string[]} models       候補列
 * @param {{ timeoutMs?: number }} options
 * @returns {Promise<{ text: string, model: string }>}
 */
export const generateReply = async (ai, messages, models = DEFAULT_MODELS, options = {}) => {
  const timeoutMs = options.timeoutMs || PER_MODEL_TIMEOUT_MS;
  const attempts = [];
  for (const model of models) {
    try {
      const result = await withTimeout(ai.run(model, buildParams(model, messages)), timeoutMs, model);
      const text = cleanReply(extractText(result));
      if (text) return { text, model, attempts };
      attempts.push({ model, error: 'empty response', shape: describeShape(result) });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      attempts.push({ model, error: message });
      if (err instanceof TimeoutError) throw new UpstreamError('timeout', attempts);
      const kind = classifyError(err);
      if (kind === 'quota') throw new QuotaExceededError(message);
      if (kind === 'rate') throw new RateLimitedError(message);
    }
  }
  throw new UpstreamError('all models failed', attempts);
};

/** ローカル開発用のダミー（MOCK_AI=1 / fail / quota / rate） */
export const createMockAI = (mode) => ({
  async run(model, params) {
    if (mode === 'fail') throw new Error('mock: upstream failure');
    if (mode === 'quota') throw new Error('mock: account has exceeded its daily neuron allocation');
    if (mode === 'rate') throw new Error('mock: 429 rate limit exceeded');
    const user = (params.messages || []).find((m) => m.role === 'user');
    const quoted = user ? (user.content.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || '' : '';
    const head = quoted.replace(/\s+/g, ' ').slice(0, 24);
    return {
      response:
        `【ダミー応答／${model}】\n全然大丈夫ですよ。「${head}」の件、3秒で読みました。\n` +
        '僕も昔は同じことをしていたので、お気持ちはよく分かります。次回のためにお伝えしておくと、前日に準備しておくと楽ですよ。参考までに。',
    };
  },
});
