/* ==========================================================
   鼻につくアンサージェネレーター — config.js
   API（Cloudflare Worker）の接続先。
   ローカル開発では ?api=http://localhost:8787 で差し替えられる（localhost 限定）。
   ========================================================== */

export const API_BASE_DEFAULT = 'https://hananitsuku-answer.mazareal.workers.dev';

const LOCAL_API = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export const resolveApiBase = (search = window.location.search) => {
  const override = new URLSearchParams(search).get('api');
  if (override) {
    const trimmed = override.replace(/\/+$/, '');
    if (LOCAL_API.test(trimmed)) return trimmed;
  }
  return API_BASE_DEFAULT;
};

/** 「自分のAIで作る」導線。ChatGPT と Claude は ?q= で貼り付け済みの状態で開ける */
export const AI_LINKS = {
  chatgpt: (prompt) => `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`,
  claude: (prompt) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`,
  gemini: () => 'https://gemini.google.com/app',
};

/** 1回の生成を待つ上限（ミリ秒）。Worker 側の1モデル上限 40 秒＋余裕。教訓006: 待ちには必ず上限を置く */
export const GENERATE_TIMEOUT_MS = 60000;
export const STATUS_TIMEOUT_MS = 6000;
