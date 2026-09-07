/* ==========================================================
   鼻につくアンサージェネレーター — app.js
   画面制御。返事は Worker（Cloudflare Workers AI）に頼み、
   無料枠切れ・連打・接続失敗のときは同じプロンプトを表示して
   お手持ちのAIに貼れるようにする。
   ========================================================== */

import { TARGETS, LEVELS, TECHNIQUES, MAX_TEXT_LENGTH, findById } from './data.js';
import { normalizeInput, buildPrompt, pickTechniques } from './prompt.js';
import { resolveApiBase, AI_LINKS, GENERATE_TIMEOUT_MS, STATUS_TIMEOUT_MS } from './config.js';

const API_BASE = resolveApiBase();

const SAMPLES = {
  iiwake:
    '遅れてすみません。家を出た瞬間、部屋にハトが入ったんです。ハトを出すまで、家を閉められないじゃないですか。あと10分で着きます。',
  hana:
    'お送りいただいたURLを拝見したのですが、こちら、もしかして私が見ているものが古いのでしょうか……？ 私の環境の問題でしたら申し訳ないのですが、念のため最新のリンクをお送りいただけますと幸いです。',
};

const FALLBACK_COPY = {
  quota_exceeded: {
    title: '本日のAI無料枠を、使い切りました。',
    text: '明日の朝9時ごろに復活します。それまでは、下の「呪文」（AIへの指示文）をお手持ちのAIに貼ってください。同じ返事が、無料で作れます。',
  },
  rate_minute: {
    title: '少し、早すぎます。',
    text: '1分ほど深呼吸してから、もう一度どうぞ。お急ぎなら、下の「呪文」（AIへの指示文）をお手持ちのAIに貼ればすぐ作れます。',
  },
  rate_day: {
    title: '今日はもう、十分お使いです。',
    text: 'おひとり様の1日ぶんを使い切りました。続きは、下の「呪文」（AIへの指示文）をお手持ちのAIに貼ってどうぞ。',
  },
  rate_upstream: {
    title: 'AIが、混み合っています。',
    text: 'しばらく待ってから、もう一度どうぞ。お急ぎなら、下の「呪文」（AIへの指示文）をお手持ちのAIに貼ればすぐ作れます。',
  },
  upstream: {
    title: 'AIに、つながりませんでした。',
    text: 'こちら側の都合です。下の「呪文」（AIへの指示文）をお手持ちのAIに貼れば、同じ返事が作れます。',
  },
  manual: {
    title: 'この「呪文」で、返事を作っています。',
    text: 'お手持ちのAI（ChatGPT・Gemini・Claude など）に貼れば、同じ返事を自分でも作れます。中身を変えて遊ぶのも自由です。',
  },
};

// ---------- 要素 ----------

const $ = (id) => document.getElementById(id);
const form = $('genForm');
const textInput = $('receivedText');
const charCount = $('charCount');
const targetPills = $('targetPills');
const levelPills = $('levelPills');
const levelHint = $('levelHint');
const nameInput = $('targetName');
const submitBtn = $('submitBtn');
const formError = $('formError');
const quotaNote = $('quotaNote');

const result = $('result');
const techniqueName = $('techniqueName');
const techniqueDesc = $('techniqueDesc');
const techniqueUsed = $('techniqueUsed');
const damageText = $('damageText');
const replyText = $('replyText');
const copyBtn = $('copyBtn');
const regenBtn = $('regenBtn');
const promptBtn = $('promptBtn');

const fallback = $('fallback');
const fallbackTitle = $('fallbackTitle');
const fallbackText = $('fallbackText');
const promptText = $('promptText');
const copyPromptBtn = $('copyPromptBtn');
const openChatgpt = $('openChatgpt');
const openClaude = $('openClaude');
const openGemini = $('openGemini');
const fallbackNote = $('fallbackNote');
const fallbackClose = $('fallbackClose');

/** 貼り付け済みリンク（?q=）の上限。これを超えると開けないサービスがある */
const MAX_PREFILL_URL_LENGTH = 12000;

// ---------- 状態 ----------

const state = {
  lastTechniques: [],
  currentPrompt: null,
  busy: false,
};

// ---------- 描画ユーティリティ ----------

const renderPills = (container, items, groupName, checkedId) => {
  container.innerHTML = items
    .map(
      (item) => `
      <span class="pills__item">
        <input class="pills__input" type="radio" name="${groupName}" id="${groupName}-${item.id}"
          value="${item.id}" ${item.id === checkedId ? 'checked' : ''}>
        <label class="pills__label" for="${groupName}-${item.id}">${item.label}</label>
      </span>`
    )
    .join('');
};

const getChecked = (groupName) => {
  const el = form.querySelector(`input[name="${groupName}"]:checked`);
  return el ? el.value : null;
};

const updateLevelHint = () => {
  const level = findById(LEVELS, getChecked('level')) || LEVELS[0];
  levelHint.textContent = level.hint;
};

const updateCharCount = () => {
  const len = textInput.value.length;
  charCount.textContent = `${len} / ${MAX_TEXT_LENGTH}`;
  charCount.classList.toggle('is-over', len > MAX_TEXT_LENGTH);
};

const showError = (message) => {
  formError.textContent = message;
  formError.hidden = !message;
};

const setBusy = (busy) => {
  state.busy = busy;
  submitBtn.disabled = busy;
  regenBtn.disabled = busy;
  submitBtn.textContent = busy ? '返事を考え中……' : '鼻につく返事を生成する';
  form.classList.toggle('is-busy', busy);
  form.setAttribute('aria-busy', busy ? 'true' : 'false');
};

const copyText = async (text, button, defaultLabel) => {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'コピーしました';
  } catch {
    button.textContent = 'コピーできませんでした（長押しで選択してください）';
  }
  window.setTimeout(() => {
    button.textContent = defaultLabel;
  }, 2200);
};

const setQuotaNote = (remaining, limit) => {
  if (typeof remaining !== 'number') {
    quotaNote.textContent = '';
    quotaNote.hidden = true;
    return;
  }
  quotaNote.hidden = false;
  if (remaining <= 0) {
    quotaNote.textContent = '本日のAI無料枠は使い切りました（毎朝9時に復活）。いまは「呪文」の表示でお使いいただけます。';
  } else if (typeof limit === 'number') {
    quotaNote.textContent = `本日のAI無料枠：残り ${remaining} 回（全員ぶん・毎朝9時に復活）`;
  } else {
    quotaNote.textContent = `本日のAI無料枠：残り ${remaining} 回`;
  }
};

// ---------- 通信 ----------

const fetchWithTimeout = (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timer));
};

const loadStatus = async () => {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/status`, { method: 'GET' }, STATUS_TIMEOUT_MS);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    setQuotaNote(data.remaining, data.limit);
  } catch {
    setQuotaNote(undefined);
  }
};

// ---------- 生成 ----------

const readPayload = (reuseTechniques) => {
  const levelId = getChecked('level');
  const techniques = reuseTechniques || pickTechniques(levelId, state.lastTechniques);
  return {
    text: textInput.value,
    target: getChecked('target'),
    level: levelId,
    techniques,
    name: nameInput.value,
  };
};

const ERROR_MESSAGES = {
  text_required: 'まず、届いた文章を貼ってください。',
  text_too_long: `文章が長すぎます。${MAX_TEXT_LENGTH}字までに切り詰めてください。`,
  name_too_long: 'お名前は20字までにしてください。',
};

const showResult = ({ reply, level, techniques }) => {
  techniqueName.textContent = level.technique;
  techniqueDesc.textContent = level.techniqueDesc;
  techniqueUsed.textContent = `使った技法：${techniques
    .map((t) => `${t.name}（${t.desc}）`)
    .join('／')}`;
  damageText.textContent = level.damage;
  replyText.textContent = reply;
  copyBtn.textContent = '返事をコピー';
  result.hidden = false;
  fallback.hidden = true;
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const showFallback = (reasonKey) => {
  const copy = FALLBACK_COPY[reasonKey] || FALLBACK_COPY.upstream;
  const prompt = state.currentPrompt ? state.currentPrompt.combined : '';
  fallbackTitle.textContent = copy.title;
  fallbackText.textContent = copy.text;
  promptText.value = prompt;
  // 貼り付け済みリンクはURLが長くなりすぎると開けない（目安 12,000 字）ので、その場合は素のリンクにする
  const chatgptUrl = AI_LINKS.chatgpt(prompt);
  const prefillOk = chatgptUrl.length <= MAX_PREFILL_URL_LENGTH;
  openChatgpt.href = prefillOk ? chatgptUrl : 'https://chatgpt.com/';
  openClaude.href = prefillOk ? AI_LINKS.claude(prompt) : 'https://claude.ai/new';
  openGemini.href = AI_LINKS.gemini();
  fallbackNote.textContent = prefillOk
    ? '※ ChatGPT と Claude は、指示文が貼り付け済みの状態で開きます（開いた先で送信してください）。Gemini は開いてから貼り付けてください。'
    : '※ 文章が長いため、貼り付け済みでは開けません。「呪文をコピー」してから、開いた先に貼り付けてください。';
  copyPromptBtn.textContent = '呪文をコピー';
  fallback.hidden = false;
  fallback.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const reasonFromResponse = (status, body) => {
  if (status === 429) {
    if (body && body.error === 'quota_exceeded') return 'quota_exceeded';
    if (body && body.scope === 'day') return 'rate_day';
    if (body && body.scope === 'upstream') return 'rate_upstream';
    return 'rate_minute';
  }
  return 'upstream';
};

const generate = async (reuseTechniques = null) => {
  if (state.busy) return;
  showError('');
  const payload = readPayload(reuseTechniques);
  const normalized = normalizeInput(payload);
  if (!normalized.ok) {
    showError(ERROR_MESSAGES[normalized.error] || '入力を見直してください。');
    textInput.focus();
    return;
  }
  const { level, techniques } = normalized.value;
  state.lastTechniques = techniques.map((t) => t.id);
  state.currentPrompt = buildPrompt(normalized.value);

  setBusy(true);
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      GENERATE_TIMEOUT_MS
    );
    const body = await res.json().catch(() => ({}));
    if (res.ok && typeof body.reply === 'string' && body.reply.trim()) {
      showResult({ reply: body.reply.trim(), level, techniques });
      if (typeof body.remaining === 'number') setQuotaNote(body.remaining, null);
    } else {
      if (typeof body.remaining === 'number') setQuotaNote(body.remaining, null);
      showFallback(reasonFromResponse(res.status, body));
    }
  } catch {
    showFallback('upstream');
  } finally {
    setBusy(false);
  }
};

// ---------- 初期化 ----------

renderPills(targetPills, TARGETS, 'target', 'peer');
renderPills(levelPills, LEVELS, 'level', 'ussura');
updateLevelHint();
updateCharCount();
loadStatus();

levelPills.addEventListener('change', updateLevelHint);
textInput.addEventListener('input', updateCharCount);

textInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    generate();
  }
});

document.querySelectorAll('[data-sample]').forEach((button) => {
  button.addEventListener('click', () => {
    textInput.value = SAMPLES[button.dataset.sample] || '';
    updateCharCount();
    showError('');
    textInput.focus();
  });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  generate();
});

regenBtn.addEventListener('click', () => generate());

copyBtn.addEventListener('click', () => {
  copyText(replyText.textContent, copyBtn, '返事をコピー');
});

promptBtn.addEventListener('click', () => {
  if (!state.currentPrompt) {
    const normalized = normalizeInput(readPayload());
    if (!normalized.ok) {
      showError(ERROR_MESSAGES[normalized.error] || '入力を見直してください。');
      return;
    }
    state.currentPrompt = buildPrompt(normalized.value);
  }
  showFallback('manual');
});

copyPromptBtn.addEventListener('click', () => {
  copyText(promptText.value, copyPromptBtn, '呪文をコピー');
});

fallbackClose.addEventListener('click', () => {
  fallback.hidden = true;
});

document.querySelectorAll('.phrase__copy').forEach((button) => {
  button.setAttribute('aria-label', `「${button.dataset.phrase}」をコピー`);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.phrase);
      button.classList.add('is-copied');
      window.setTimeout(() => button.classList.remove('is-copied'), 2000);
    } catch {
      /* クリップボード非対応環境では何もしない */
    }
  });
});

// 技法一覧（画面の説明用）を data.js から出す（textContent で組み立て・innerHTML は使わない）
const techniqueList = $('techniqueList');
if (techniqueList) {
  TECHNIQUES.forEach((t) => {
    const item = document.createElement('li');
    item.className = 'technique';
    const name = document.createElement('span');
    name.className = 'technique__name';
    name.textContent = t.name;
    const desc = document.createElement('span');
    desc.className = 'technique__desc';
    desc.textContent = t.desc;
    item.append(name, desc);
    techniqueList.appendChild(item);
  });
}
