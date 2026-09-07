import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput, buildPrompt, pickTechniques, SYSTEM_PROMPT } from '../js/prompt.js';
import { LEVELS, TECHNIQUES, MAX_TEXT_LENGTH } from '../js/data.js';

const sample = {
  text: '家を出た瞬間、部屋にハトが入ったんです。',
  target: 'junior',
  level: 'shikkari',
  techniques: ['tensaku', 'jogen'],
  name: '田中',
};

test('normalizeInput accepts a valid body', () => {
  const r = normalizeInput(sample);
  assert.equal(r.ok, true);
  assert.equal(r.value.target.id, 'junior');
  assert.equal(r.value.level.id, 'shikkari');
  assert.deepEqual(r.value.techniques.map((t) => t.id), ['tensaku', 'jogen']);
  assert.equal(r.value.name, '田中');
});

test('normalizeInput rejects empty / long text and unknown ids', () => {
  assert.equal(normalizeInput({ ...sample, text: '   ' }).error, 'text_required');
  assert.equal(normalizeInput({ ...sample, text: 'あ'.repeat(MAX_TEXT_LENGTH + 1) }).error, 'text_too_long');
  assert.equal(normalizeInput({ ...sample, target: 'boss' }).error, 'invalid_target');
  assert.equal(normalizeInput({ ...sample, level: 'max' }).error, 'invalid_level');
  assert.equal(normalizeInput({ ...sample, techniques: [] }).error, 'invalid_techniques');
  assert.equal(normalizeInput({ ...sample, techniques: ['tensaku', 'jogen', 'jiman'] }).error, 'invalid_techniques');
  assert.equal(normalizeInput({ ...sample, techniques: ['ishiki'] }).error, 'invalid_techniques', 'technique outside the level pool');
  assert.equal(normalizeInput({ ...sample, name: 'あ'.repeat(21) }).error, 'name_too_long');
  assert.equal(normalizeInput(null).error, 'invalid_body');
});

test('normalizeInput normalizes line breaks and de-duplicates techniques', () => {
  const r = normalizeInput({ ...sample, text: 'a\r\nb\rc', techniques: ['tensaku', 'tensaku'] });
  assert.equal(r.ok, true);
  assert.equal(r.value.text, 'a\nb\nc');
  assert.equal(r.value.techniques.length, 1);
});

test('buildPrompt embeds text, register, level and techniques', () => {
  const { value } = normalizeInput(sample);
  const p = buildPrompt(value);
  assert.equal(p.system, SYSTEM_PROMPT);
  assert.ok(p.user.includes(sample.text));
  assert.ok(p.user.includes('後輩・部下'));
  assert.ok(p.user.includes('添削返し'));
  assert.ok(p.user.includes('頼まれていない助言'));
  assert.ok(p.user.includes('200〜320字'));
  assert.ok(p.user.includes('田中（呼びかけに使ってよい）'));
  assert.equal(p.combined, `${p.system}\n\n${p.user}`);
});

test('buildPrompt without a name says not to write one', () => {
  const { value } = normalizeInput({ ...sample, name: '' });
  assert.ok(buildPrompt(value).user.includes('不明（名前は書かない）'));
});

test('pickTechniques returns ids from the level pool with the right count', () => {
  for (const level of LEVELS) {
    for (let i = 0; i < 20; i += 1) {
      const ids = pickTechniques(level.id);
      assert.equal(ids.length, level.pick);
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ids) {
        assert.ok(level.pool.includes(id), `${id} not in pool of ${level.id}`);
        assert.ok(TECHNIQUES.some((t) => t.id === id));
      }
    }
  }
});

test('pickTechniques avoids repeating the previous combination when possible', () => {
  // 決定的な乱数（常に 0）だと同じ並びになるので、前回回避のロジックが働く
  const zero = () => 0;
  const first = pickTechniques('ussura', [], zero);
  const second = pickTechniques('ussura', first, zero);
  assert.notDeepEqual(first.slice().sort(), second.slice().sort());
});

test('every level pool only references existing techniques', () => {
  const ids = new Set(TECHNIQUES.map((t) => t.id));
  for (const level of LEVELS) {
    for (const id of level.pool) assert.ok(ids.has(id), `${level.id}: ${id}`);
    assert.ok(level.pool.length >= level.pick);
  }
});
