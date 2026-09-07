import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, isAllowedOrigin, readConfig, hashIp } from '../worker/src/handler.js';

const ORIGIN = 'https://yoshihikomizuno.github.io';
const env = {
  DAILY_LIMIT: '10',
  PER_IP_MINUTE: '3',
  PER_IP_DAY: '5',
  ALLOWED_ORIGINS: `${ORIGIN},https://mazareal.co.jp`,
  AI_MODELS: 'm1,m2',
};

const makeQuota = (overrides = {}) => {
  const calls = { take: [], exhaust: [] };
  return {
    calls,
    async status(limit) {
      return { total: 2, remaining: limit - 2, resetAt: '2026-09-08T00:00:00.000Z' };
    },
    async take(args) {
      calls.take.push(args);
      return overrides.take || { ok: true, remaining: 7 };
    },
    async exhaust(limit) {
      calls.exhaust.push(limit);
      return { remaining: 0 };
    },
  };
};

const okAI = { async run() { return { response: '本文です' }; } };

const post = (body, headers = {}) =>
  new Request('https://api.example/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.5', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const validBody = { text: 'ハトが入りました', target: 'peer', level: 'yoyu', techniques: ['yurushi'], name: '' };

test('readConfig parses vars with defaults', () => {
  const c = readConfig(env);
  assert.equal(c.limit, 10);
  assert.equal(c.perIpMinute, 3);
  assert.equal(c.perIpDay, 5);
  assert.deepEqual(c.models, ['m1', 'm2']);
  assert.deepEqual(c.allowedOrigins, [ORIGIN, 'https://mazareal.co.jp']);
  assert.equal(readConfig({}).limit, 500);
});

test('isAllowedOrigin allows listed origins, localhost and no-origin', () => {
  assert.equal(isAllowedOrigin(ORIGIN, [ORIGIN]), true);
  assert.equal(isAllowedOrigin('http://localhost:8788', []), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5500', []), true);
  assert.equal(isAllowedOrigin('', []), true);
  assert.equal(isAllowedOrigin('https://evil.example', [ORIGIN]), false);
});

test('hashIp is stable and short', async () => {
  const a = await hashIp('1.2.3.4');
  assert.equal(a, await hashIp('1.2.3.4'));
  assert.equal(a.length, 24);
  assert.notEqual(a, await hashIp('1.2.3.5'));
});

test('OPTIONS preflight returns CORS headers', async () => {
  const res = await handleRequest(new Request('https://api.example/generate', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, { quota: makeQuota(), ai: okAI });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.ok(res.headers.get('Access-Control-Allow-Methods').includes('POST'));
});

test('disallowed origin gets 403', async () => {
  const res = await handleRequest(post(validBody, { Origin: 'https://evil.example' }), env, { quota: makeQuota(), ai: okAI });
  assert.equal(res.status, 403);
});

test('GET /status returns remaining and limit', async () => {
  const res = await handleRequest(new Request('https://api.example/status', { headers: { Origin: ORIGIN } }), env, { quota: makeQuota(), ai: okAI });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, remaining: 8, limit: 10, resetAt: '2026-09-08T00:00:00.000Z' });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('POST /generate returns a reply and consumes one ticket', async () => {
  const quota = makeQuota();
  const res = await handleRequest(post(validBody), env, { quota, ai: okAI });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reply, '本文です');
  assert.equal(body.model, 'm1');
  assert.equal(body.remaining, 7);
  assert.equal(quota.calls.take.length, 1);
  assert.equal(quota.calls.take[0].limit, 10);
  assert.equal(quota.calls.take[0].perIpDay, 5);
  assert.equal(quota.calls.take[0].ipKey.length, 24);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('POST /generate validates input before touching the quota', async () => {
  const quota = makeQuota();
  const bad = await handleRequest(post({ ...validBody, text: '' }), env, { quota, ai: okAI });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).detail, 'text_required');
  const notJson = await handleRequest(post('{oops'), env, { quota, ai: okAI });
  assert.equal(notJson.status, 400);
  const huge = await handleRequest(post({ ...validBody, text: 'あ'.repeat(9000) }), env, { quota, ai: okAI });
  assert.equal(huge.status, 413);
  assert.equal(quota.calls.take.length, 0);
});

test('quota exhausted or rate limited by the counter returns 429 without calling AI', async () => {
  let aiCalls = 0;
  const ai = { async run() { aiCalls += 1; return { response: 'x' }; } };
  const q1 = makeQuota({ take: { ok: false, reason: 'quota_exceeded', remaining: 0 } });
  const r1 = await handleRequest(post(validBody), env, { quota: q1, ai });
  assert.equal(r1.status, 429);
  assert.equal((await r1.json()).error, 'quota_exceeded');
  const q2 = makeQuota({ take: { ok: false, reason: 'rate_limited', remaining: 4, scope: 'minute' } });
  const r2 = await handleRequest(post(validBody), env, { quota: q2, ai });
  assert.equal(r2.status, 429);
  const b2 = await r2.json();
  assert.equal(b2.error, 'rate_limited');
  assert.equal(b2.scope, 'minute');
  assert.equal(aiCalls, 0);
});

test('AI quota error trips the breaker (exhaust) and returns 429', async () => {
  const quota = makeQuota();
  const ai = { async run() { throw new Error('exceeded daily neuron allocation'); } };
  const res = await handleRequest(post(validBody), env, { quota, ai });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'quota_exceeded');
  assert.deepEqual(quota.calls.exhaust, [10]);
});

test('all models failing returns 502 upstream', async () => {
  const quota = makeQuota();
  const ai = { async run() { throw new Error('model unavailable'); } };
  const res = await handleRequest(post(validBody), env, { quota, ai });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream');
  assert.equal(quota.calls.exhaust.length, 0);
});

test('unknown routes return 404', async () => {
  const res = await handleRequest(new Request('https://api.example/nope', { headers: { Origin: ORIGIN } }), env, { quota: makeQuota(), ai: okAI });
  assert.equal(res.status, 404);
});

test('MOCK_AI env is used when no ai dep is given', async () => {
  const res = await handleRequest(post(validBody), { ...env, MOCK_AI: '1' }, { quota: makeQuota() });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).reply.includes('ハトが入りました'));
});
