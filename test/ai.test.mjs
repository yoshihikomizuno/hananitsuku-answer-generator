import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractText,
  cleanReply,
  classifyError,
  generateReply,
  buildParams,
  parseModelList,
  createMockAI,
  DEFAULT_MODELS,
  QuotaExceededError,
  RateLimitedError,
  UpstreamError,
} from '../worker/src/ai.js';

const messages = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '【届いた文章】\n"""\nハトが入りました\n"""\n' },
];

test('extractText handles the response shapes Workers AI uses', () => {
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText({ response: 'r' }), 'r');
  assert.equal(extractText({ result: { response: 'wrapped' } }), 'wrapped');
  assert.equal(extractText({ choices: [{ message: { content: 'c' } }] }), 'c');
  assert.equal(extractText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
  assert.equal(extractText({ choices: [{ text: 'legacy' }] }), 'legacy');
  assert.equal(
    extractText({
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'think' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'final' }] },
      ],
    }),
    'final'
  );
  assert.equal(extractText({ output_text: 'ot' }), 'ot');
  assert.equal(extractText({}), '');
  assert.equal(extractText(null), '');
});

test('cleanReply strips thinking blocks, labels and fences', () => {
  assert.equal(cleanReply('<think>考え中</think>\n本文です'), '本文です');
  assert.equal(cleanReply('<think>閉じていない'), '');
  assert.equal(cleanReply('返事：本文'), '本文');
  assert.equal(cleanReply('【返信】本文'), '本文');
  assert.equal(cleanReply('```text\n本文\n```'), '本文');
  assert.equal(cleanReply('<|channel|>analysis<|message|>本文'), '本文');
  assert.equal(cleanReply('  本文  '), '本文');
});

test('classifyError distinguishes quota / rate / other', () => {
  assert.equal(classifyError(new Error('Account has exceeded its daily neuron allocation')), 'quota');
  assert.equal(classifyError(new Error('3040: quota exceeded')), 'quota');
  assert.equal(classifyError(new Error('429 Too Many Requests')), 'rate');
  assert.equal(classifyError(new Error('model not found')), 'other');
});

test('buildParams uses max_completion_tokens for gemma-4 and max_tokens otherwise', () => {
  const g = buildParams('@cf/google/gemma-4-26b-a4b-it', messages);
  assert.ok('max_completion_tokens' in g);
  assert.ok(!('max_tokens' in g));
  assert.equal(g.reasoning_effort, 'low');
  const q = buildParams('@cf/qwen/qwen3-30b-a3b-fp8', messages);
  assert.ok('max_tokens' in q);
  assert.ok(!('max_completion_tokens' in q));
});

test('parseModelList falls back to defaults', () => {
  assert.deepEqual(parseModelList(''), DEFAULT_MODELS);
  assert.deepEqual(parseModelList(' a , b '), ['a', 'b']);
});

test('generateReply moves to the next model when one fails or is empty', async () => {
  const calls = [];
  const ai = {
    async run(model) {
      calls.push(model);
      if (model === 'm1') throw new Error('No such model');
      if (model === 'm2') return { response: '' };
      return { response: '<think>x</think>本文' };
    },
  };
  const r = await generateReply(ai, messages, ['m1', 'm2', 'm3']);
  assert.deepEqual(calls, ['m1', 'm2', 'm3']);
  assert.equal(r.model, 'm3');
  assert.equal(r.text, '本文');
});

test('generateReply stops immediately on a quota error', async () => {
  const calls = [];
  const ai = {
    async run(model) {
      calls.push(model);
      throw new Error('daily neuron allocation exceeded');
    },
  };
  await assert.rejects(generateReply(ai, messages, ['m1', 'm2']), QuotaExceededError);
  assert.deepEqual(calls, ['m1']);
});

test('generateReply surfaces rate limits and upstream failures', async () => {
  await assert.rejects(
    generateReply({ async run() { throw new Error('429 rate limit'); } }, messages, ['m1']),
    RateLimitedError
  );
  await assert.rejects(
    generateReply({ async run() { throw new Error('boom'); } }, messages, ['m1', 'm2']),
    (err) => err instanceof UpstreamError && err.attempts.length === 2
  );
});

test('generateReply gives up on timeout without trying the next model', async () => {
  const calls = [];
  const ai = {
    run(model) {
      calls.push(model);
      return new Promise(() => {}); // never resolves
    },
  };
  await assert.rejects(
    generateReply(ai, messages, ['m1', 'm2'], { timeoutMs: 30 }),
    (err) => err instanceof UpstreamError && err.message === 'timeout' && /timeout after 30ms/.test(err.attempts[0].error)
  );
  assert.deepEqual(calls, ['m1']);
});

test('mock AI echoes the quoted text and supports failure modes', async () => {
  const r = await createMockAI('1').run('@cf/x', { messages });
  assert.ok(r.response.includes('ハトが入りました'));
  await assert.rejects(createMockAI('quota').run('@cf/x', { messages }), /neuron/);
  await assert.rejects(createMockAI('fail').run('@cf/x', { messages }), /upstream/);
});
