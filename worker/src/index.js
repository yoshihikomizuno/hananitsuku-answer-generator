/* ==========================================================
   index.js — Worker のエントリ
   ========================================================== */

import { handleRequest } from './handler.js';

export { QuotaCounter } from './quota.js';

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error('unhandled', String(err));
      return new Response(JSON.stringify({ error: 'internal' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  },
};
