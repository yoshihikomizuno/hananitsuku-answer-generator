/* ==========================================================
   handler.js — ルーティング・CORS・入力検証
   cloudflare:workers を import しないので、node --test で直接検証できる。
   AI と Durable Object は deps で差し替え可能。
   ========================================================== */

import { normalizeInput, buildPrompt } from '../../js/prompt.js';
import {
  generateReply,
  parseModelList,
  createMockAI,
  QuotaExceededError,
  RateLimitedError,
} from './ai.js';

const DEFAULTS = { DAILY_LIMIT: 500, PER_IP_MINUTE: 6, PER_IP_DAY: 40 };
const MAX_BODY_CHARS = 8000;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const readConfig = (env) => ({
  limit: toInt(env.DAILY_LIMIT, DEFAULTS.DAILY_LIMIT),
  perIpMinute: toInt(env.PER_IP_MINUTE, DEFAULTS.PER_IP_MINUTE),
  perIpDay: toInt(env.PER_IP_DAY, DEFAULTS.PER_IP_DAY),
  models: parseModelList(env.AI_MODELS),
  allowedOrigins: String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});

export const isAllowedOrigin = (origin, allowedOrigins) => {
  if (!origin) return true; // curl などブラウザ以外。守りは IP 制限側
  if (LOCAL_ORIGIN.test(origin)) return true;
  return allowedOrigins.includes(origin);
};

const corsHeaders = (origin) => {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
};

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });

/** IP を保存しないため、短いハッシュに変換して鍵にする */
export const hashIp = async (ip) => {
  const data = new TextEncoder().encode(`hananitsuku:${ip || 'unknown'}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const getQuotaStub = (env) => {
  const id = env.QUOTA.idFromName('global');
  return env.QUOTA.get(id);
};

const getAI = (env) => {
  if (env.MOCK_AI) return createMockAI(env.MOCK_AI);
  return env.AI;
};

export const handleRequest = async (request, env, deps = {}) => {
  const config = readConfig(env);
  const origin = request.headers.get('Origin') || '';
  const url = new URL(request.url);

  if (!isAllowedOrigin(origin, config.allowedOrigins)) {
    return json({ error: 'forbidden_origin' }, 403, '');
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const quota = deps.quota || getQuotaStub(env);

  if (request.method === 'GET' && url.pathname === '/status') {
    const status = await quota.status(config.limit);
    return json({ ok: true, remaining: status.remaining, limit: config.limit, resetAt: status.resetAt }, 200, origin);
  }

  if (request.method === 'POST' && url.pathname === '/generate') {
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_CHARS) return json({ error: 'payload_too_large' }, 413, origin);
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'bad_request', detail: 'invalid_json' }, 400, origin);
    }

    const normalized = normalizeInput(body);
    if (!normalized.ok) return json({ error: 'bad_request', detail: normalized.error }, 400, origin);

    const ipKey = await hashIp(request.headers.get('CF-Connecting-IP'));
    const ticket = await quota.take({
      limit: config.limit,
      perIpDay: config.perIpDay,
      perIpMinute: config.perIpMinute,
      ipKey,
    });
    if (!ticket.ok) {
      return json({ error: ticket.reason, remaining: ticket.remaining, scope: ticket.scope || null }, 429, origin);
    }

    const prompt = buildPrompt(normalized.value);
    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ];

    try {
      const ai = deps.ai || getAI(env);
      const { text, model } = await generateReply(ai, messages, config.models);
      return json({ reply: text, model, remaining: ticket.remaining }, 200, origin);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        await quota.exhaust(config.limit);
        return json({ error: 'quota_exceeded', remaining: 0 }, 429, origin);
      }
      if (err instanceof RateLimitedError) {
        return json({ error: 'rate_limited', remaining: ticket.remaining, scope: 'upstream' }, 429, origin);
      }
      console.error('generate failed', err && err.attempts ? JSON.stringify(err.attempts) : String(err));
      return json({ error: 'upstream', remaining: ticket.remaining }, 502, origin);
    }
  }

  return json({ error: 'not_found' }, 404, origin);
};
