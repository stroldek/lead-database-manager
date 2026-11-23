// Durable Object that owns the live Telegram connection. One instance ("main") per deployment.
// It is the only place where the account session exists in memory; the session itself is stored encrypted in D1.
import { DurableObject } from 'cloudflare:workers';
import { TgEngine, HttpError, describeError } from './engine.js';
import { createStore } from './store.js';
import { makeGramClient, runDiagnostics } from './gramjs.js';

const ALLOWED = new Set([
  'status', 'saveCredentials', 'startQr', 'startPhone', 'submitCode', 'submitPassword', 'cancelLogin', 'logout',
  'listDialogs', 'addSource', 'removeSource', 'monitorState', 'saveMonitorSettings', 'runCheck', 'runDiagnostics',
]);

export class TelegramSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.engine = new TgEngine({
      store: createStore(env.DB),
      makeClient: makeGramClient,
      secret: env.APP_SECRET,
      envCreds: { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH },
      scheduleAlarm: async (ms) => {
        if (ms === null) await ctx.storage.deleteAlarm();
        else await ctx.storage.setAlarm(Date.now() + ms);
      },
      diagnose: runDiagnostics,
    });
  }

  async alarm() {
    try { await this.engine.tick(); } catch (e) { console.error('tick_failed', e?.message || 'unknown'); }
  }

  /** Single RPC entry point; errors are returned as data so status codes survive the RPC boundary. */
  async invoke(method, args = []) {
    if (!ALLOWED.has(method)) return { ok: false, status: 400, error: 'unknown_method' };
    try {
      return { ok: true, data: await this.engine[method](...args) };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, status: e.status, error: e.message };
      console.error('engine_error', method, e?.message || 'unknown');
      return { ok: false, status: 502, error: describeError(e) };
    }
  }
}
