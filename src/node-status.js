/**
 * Quota probe: ping upstream cloud with a tiny request per model to check availability.
 * Cached for 5 minutes to avoid burning quota on health checks.
 * Borrows the upstream-call pattern from autoclaw-api/test-*.py.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
let cache = { at: 0, data: null };
let probing = null;

function readProviderConfig() {
  const cfgPath = path.join(config.gateway.stateDir, 'openclaw.json');
  try {
    const d = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const prov = d.models?.providers?.zai;
    if (!prov) return null;
    return prov;
  } catch {
    return null;
  }
}

async function probeOne(prov, model) {
  const hdrs = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': 'autoclaw-node-status/1.0',
    ...prov.headers,
    ...model.headers,
  };
  const body = JSON.stringify({
    model: model.id,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
  });
  try {
    const res = await fetch(prov.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: hdrs,
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok || res.body) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { available: true };
    }
    const text = await res.text();
    if (res.status === 403 && text.includes('quota')) return { available: false, reason: 'quota_exhausted' };
    if (res.status === 400) return { available: false, reason: 'invalid_model' };
    return { available: false, reason: `http_${res.status}` };
  } catch (err) {
    return { available: false, reason: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

export async function probeModels() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (probing) return probing;

  probing = (async () => {
    const prov = readProviderConfig();
    if (!prov) {
      cache = { at: Date.now(), data: { models: [], error: 'config_unreadable' } };
      return cache.data;
    }
    const models = (prov.models ?? []).map((m) => ({ id: m.id, name: m.name }));
    const results = [];
    // probe in parallel (max 5 at once)
    const batch = models.slice(0, 20);
    const chunks = [];
    for (let i = 0; i < batch.length; i += 5) chunks.push(batch.slice(i, i + 5));
    for (const chunk of chunks) {
      const settled = await Promise.all(chunk.map(async (m) => {
        const provM = prov.models.find((x) => x.id === m.id);
        const r = await probeOne(prov, provM);
        return { id: m.id, name: m.name, available: r.available, reason: r.reason ?? null };
      }));
      results.push(...settled);
    }
    cache = { at: Date.now(), data: { models: results, probedAt: new Date().toISOString() } };
    return cache.data;
  })();

  try {
    return await probing;
  } finally {
    probing = null;
  }
}

export async function getNodeStatus() {
  return probeModels();
}

// ---------- official credit/quota API (agent-assetmgr) ----------
// The AutoClaw cloud exposes the real wallet balance used by the Credits page.
let walletCache = { at: 0, data: null };

export async function getWallet() {
  if (walletCache.data && Date.now() - walletCache.at < 60_000) return walletCache.data;
  const prov = readProviderConfig();
  const model = prov?.models?.find((m) => m.headers?.['X-Authorization']);
  if (!model) return { error: 'no_jwt' };
  const auth = model.headers['X-Authorization'];
  const headers = { Authorization: auth, 'X-Authorization': auth, 'User-Agent': 'autoclaw-node-status/1.0' };
  try {
    const [walletsRes, expiringRes] = await Promise.all([
      fetch('https://autoglm-api.autoglm.ai/agent-assetmgr/api/v2/wallets', { headers, signal: AbortSignal.timeout(15000) }),
      fetch('https://autoglm-api.autoglm.ai/agent-assetmgr/api/v1/points/expiring', { headers, signal: AbortSignal.timeout(15000) }).catch(() => null),
    ]);
    if (!walletsRes.ok) return { error: `http_${walletsRes.status}` };
    const wallets = (await walletsRes.json())?.data;
    let expiring = null;
    if (expiringRes?.ok) {
      try { expiring = (await expiringRes.json())?.data ?? null; } catch { /* optional */ }
    }
    walletCache = {
      at: Date.now(),
      data: {
        totalBalance: wallets.total_balance,
        wallets: (wallets.wallets ?? []).map((w) => ({ type: w.public_wallet_type, name: w.display_name, balance: w.balance })),
        expiring: expiring ? { points: expiring.expiring_points, withinDays: expiring.expire_time_value, total: expiring.total_points } : null,
        fetchedAt: new Date().toISOString(),
      },
    };
    return walletCache.data;
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}
