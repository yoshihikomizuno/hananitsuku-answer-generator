/* ==========================================================
   quota.js — 無料枠の門番（Durable Object・SQLite backend）
   1つのオブジェクト（"global"）が、UTC日付ごとの総回数と IP 別回数を数える。
   - take():    1回ぶん消費できるか判定して消費する
   - status():  残り回数
   - exhaust(): AI 側が枠切れを返したので、その日は使い切りにする（回路遮断）
   ========================================================== */

import { DurableObject } from 'cloudflare:workers';

const STATE_KEY = 'state';

export const utcDate = (now = new Date()) => now.toISOString().slice(0, 10);

export const nextResetAt = (now = new Date()) => {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
};

export class QuotaCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** IPハッシュ → 直近60秒のタイムスタンプ（メモリのみ。退避で消えてよい） */
    this.recent = new Map();
  }

  async #load() {
    const today = utcDate();
    const stored = await this.ctx.storage.get(STATE_KEY);
    if (stored && stored.date === today) return stored;
    return { date: today, total: 0, ips: {} };
  }

  async #save(state) {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  #recentCount(ipKey, now, perIpMinute) {
    const windowStart = now - 60000;
    const list = (this.recent.get(ipKey) || []).filter((t) => t > windowStart);
    if (list.length >= perIpMinute) {
      this.recent.set(ipKey, list);
      return false;
    }
    list.push(now);
    this.recent.set(ipKey, list);
    if (this.recent.size > 5000) {
      for (const [key, times] of this.recent) {
        if (times.every((t) => t <= windowStart)) this.recent.delete(key);
      }
    }
    return true;
  }

  async status(limit) {
    const state = await this.#load();
    return { total: state.total, remaining: Math.max(0, limit - state.total), resetAt: nextResetAt() };
  }

  async take({ limit, perIpDay, perIpMinute, ipKey }) {
    const state = await this.#load();
    const remaining = Math.max(0, limit - state.total);
    if (remaining <= 0) return { ok: false, reason: 'quota_exceeded', remaining: 0 };

    const ipCount = state.ips[ipKey] || 0;
    if (ipCount >= perIpDay) return { ok: false, reason: 'rate_limited', remaining, scope: 'day' };
    if (!this.#recentCount(ipKey, Date.now(), perIpMinute)) {
      return { ok: false, reason: 'rate_limited', remaining, scope: 'minute' };
    }

    state.total += 1;
    state.ips[ipKey] = ipCount + 1;
    await this.#save(state);
    return { ok: true, remaining: Math.max(0, limit - state.total) };
  }

  async exhaust(limit) {
    const state = await this.#load();
    state.total = Math.max(state.total, limit);
    await this.#save(state);
    return { remaining: 0 };
  }
}
