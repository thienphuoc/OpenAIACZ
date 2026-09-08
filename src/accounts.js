/**
 * Multi-account manager: pool multiple AutoClaw accounts (JWTs) and rotate
 * between them when one runs out of quota. Direct-upstream mode calls the
 * cloud proxy directly with a chosen account's JWT — bypassing the gateway —
 * which is what makes per-account quota pooling possible.
 *
 * Accounts persist in accounts.json (gitignored — contains secrets).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ACCOUNTS_PATH = path.join(ROOT, 'accounts.json');

let accounts = [];            // {id, label, jwt, baseUrl, modelHeaders:{id:headers}, addedAt, lastError}
const cooldowns = new Map();  // key: accountId hoặc accountId::modelId -> untilMs (persisted)
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(ACCOUNTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
      accounts = data.accounts ?? [];
      // restore cooldowns, drop expired ones
      const now = Date.now();
      for (const [k, until] of Object.entries(data.cooldowns ?? {})) {
        if (until > now) cooldowns.set(k, until);
      }
    }
  } catch (err) {
    console.error(`[accounts] failed to load: ${err.message}`);
  }
}

function save() {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify({
    accounts,
    cooldowns: Object.fromEntries(cooldowns),
  }, null, 2));
}

function decodeJwtExp(jwt) {
  try {
    const payload = jwt.replace('Bearer ', '').split('.')[1];
    const b = payload.replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(Buffer.from(b, 'base64').toString('utf8')).exp ?? null;
  } catch {
    return null;
  }
}

export function listAccounts() {
  load();
  const now = Date.now() / 1000;
  return accounts.map((a) => {
    const exp = decodeJwtExp(resolveJwt(a));
    return {
      id: a.id,
      label: a.label,
      live: !!a.live,
      baseUrl: a.baseUrl,
      models: Object.keys(a.modelHeaders ?? {}),
      addedAt: a.addedAt,
      lastError: a.lastError ?? null,
      cooldownUntil: cooldowns.get(a.id) ?? 0,
      onCooldown: (cooldowns.get(a.id) ?? 0) > Date.now(),
      jwtExp: exp,
      jwtExpired: exp != null && exp < now,
    };
  });
}
export function markCooldown(id, ms, reason, modelId) {
  // quota errors are model-specific: only skip this account FOR THAT MODEL
  const key = modelId ? `${id}::${modelId}` : id;
  cooldowns.set(key, Date.now() + ms);
  const a = accounts.find((x) => x.id === id);
  if (a) a.lastError = { ts: Date.now(), reason: String(reason).slice(0, 200) };
  save();
}

export function clearCooldown(id) {
  for (const k of [...cooldowns.keys()]) {
    if (k === id || k.startsWith(id + '::')) cooldowns.delete(k);
  }
  const a = accounts.find((x) => x.id === id);
  if (a) a.lastError = null;
  save();
}

/** Pick an account: preferred first if healthy, else rotate through the rest. */
export function pickAccount(preferredId, modelId) {
  load();
  const healthy = (modelId
    ? accounts.filter((a) => (cooldowns.get(a.id) ?? 0) <= Date.now() && (cooldowns.get(`${a.id}::${modelId}`) ?? 0) <= Date.now())
    : accounts.filter((a) => (cooldowns.get(a.id) ?? 0) <= Date.now()));
  if (healthy.length === 0) return null;
  if (preferredId && preferredId !== 'auto') {
    return healthy.find((a) => a.id === preferredId) ?? null;
  }
  // rotate: least-recently-used by cooldown timestamp order — simple cursor
  return healthy[0];
}

export function hasAccounts() {
  load();
  return accounts.length > 0;
}

/** Build upstream request headers for an account + model (mirrors gateway). */
export function headersFor(account, modelId) {
  const modelHeaders = account.modelHeaders?.[modelId] ?? {};
  const fallback = Object.values(account.modelHeaders ?? {})[0] ?? {};
  const jwt = resolveJwt(account);
  return {
    ...fallback,
    ...modelHeaders,
    ...(account.providerHeaders ?? {}),
    Authorization: 'Bearer autoclaw-internal-proxy',
    'X-Authorization': jwt,
    'X-Request-Id': crypto.randomUUID(),
    // explicit: modelId may not have its own stored headers (fallback model)
    'X-Request-Model': modelId,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    // WAF rejects unknown user agents with 400 — mirror the desktop app's SDK
    'User-Agent': 'OpenAI/JS 6.39.1',
  };
}

function makeId(jwt) {
  return 'acc-' + crypto.createHash('sha256').update(jwt).digest('hex').slice(0, 8);
}

/** Import an account from a state directory (openclaw.json with JWT headers). */
export function importFromStateDir(dirPath, label) {
  load();
  const cfgPath = path.join(dirPath, 'openclaw.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const prov = cfg.models?.providers?.zai;
  if (!prov?.baseUrl) throw new Error('no zai provider in openclaw.json');

  const modelHeaders = {};
  let jwt = null;
  for (const m of prov.models ?? []) {
    if (m.headers?.['X-Authorization']) {
      jwt = m.headers['X-Authorization'];
      modelHeaders[m.id] = { ...m.headers };
    }
  }
  if (!jwt) throw new Error('no X-Authorization JWT found in models');

  const isLocal = path.resolve(dirPath) === path.resolve(path.join(os.homedir(), '.openclaw-autoclaw'));
  const id = isLocal ? 'acc-local' : makeId(jwt);
  const existing = accounts.find((a) => a.id === id);
  const account = {
    id,
    label: label || path.basename(dirPath),
    // live accounts re-read the JWT on every use — the app rotates it (often daily)
    live: isLocal,
    liveJwtPath: isLocal ? path.join(dirPath, 'request-headers.json') : undefined,
    jwt,
    baseUrl: prov.baseUrl,
    providerHeaders: { ...prov.headers },
    modelHeaders,
    addedAt: existing?.addedAt ?? Date.now(),
  };
  if (existing) Object.assign(existing, account);
  else accounts.push(account);
  cooldowns.delete(id);
  save();
  return account;
}

/** Resolve the CURRENT jwt for an account (live accounts re-read from disk). */
export function resolveJwt(account) {
  if (account.live && account.liveJwtPath) {
    try {
      const rh = JSON.parse(fs.readFileSync(account.liveJwtPath, 'utf8'));
      if (rh.headers?.['X-Authorization']) return rh.headers['X-Authorization'];
    } catch { /* fall back to stored */ }
  }
  return account.jwt;
}

/** Import from an export bundle (admin auth/export format). */
export function importFromBundle(bundle) {
  const prov = bundle.providerAuth?.zai;
  if (!prov?.baseUrl) throw new Error('bundle has no zai providerAuth');
  const modelHeaders = {};
  let jwt = null;
  for (const m of prov.models ?? []) {
    if (m.headers?.['X-Authorization']) {
      jwt = m.headers['X-Authorization'];
      modelHeaders[m.id] = { ...m.headers };
    }
  }
  if (!jwt) throw new Error('bundle has no JWT');
  load();
  const id = makeId(jwt);
  const existing = accounts.find((a) => a.id === id);
  const account = {
    id,
    label: bundle.label || `imported-${id}`,
    jwt,
    baseUrl: prov.baseUrl,
    modelHeaders,
    addedAt: existing?.addedAt ?? Date.now(),
  };
  if (existing) Object.assign(existing, account);
  else accounts.push(account);
  cooldowns.delete(id);
  save();
  return account;
}

export function removeAccount(id) {
  load();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  accounts.splice(idx, 1);
  cooldowns.delete(id);
  save();
  return true;
}

export function getAccount(id) {
  load();
  return accounts.find((a) => a.id === id) ?? null;
}

/** The cloud proxy only serves requests carrying the agent system prompt — cache it. */
let agentPromptCache = null;
export function getAgentSystemPrompt() {
  if (agentPromptCache) return agentPromptCache;
  try {
    agentPromptCache = fs.readFileSync(path.join(ROOT, 'src', 'agent-system-prompt.txt'), 'utf8');
  } catch {
    agentPromptCache = null;
  }
  return agentPromptCache;
}

/**
 * Periodic JWT refresh: re-imports every live account (re-reading its state
 * dir) so rotated upstream tokens are picked up automatically. Snapshot
 * accounts from other machines can't self-refresh — the UI flags those as
 * needing a re-export after the source machine rotates its token.
 */
export function startAutoRefreshLoop(intervalMs = 30 * 60 * 1000) {
  const tick = () => {
    load();
    for (const a of accounts.filter((x) => x.live)) {
      try {
        const jwt = resolveJwt(a); // re-reads liveJwtPath
        if (jwt && jwt !== a.jwt) {
          a.jwt = jwt;
          save();
          console.log(`[accounts] ${a.label}: JWT rotated, updated`);
        }
      } catch { /* file may be mid-write; next tick retries */ }
    }
  };
  setInterval(tick, intervalMs);
}

/** Fetch official wallet balance for one account. */
export async function accountWallet(account) {
  const headers = { Authorization: resolveJwt(account), 'X-Authorization': resolveJwt(account), 'User-Agent': 'autoclaw-openai-api/1.1' };
  try {
    const res = await fetch('https://autoglm-api.autoglm.ai/agent-assetmgr/api/v2/wallets', {
      headers, signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    if (j.code === 0 && j.data) {
      return {
        ok: true,
        totalBalance: j.data.total_balance,
        wallets: (j.data.wallets ?? []).map((w) => ({ type: w.public_wallet_type, name: w.display_name, balance: w.balance })),
      };
    }
    return { ok: false, reason: j.msg || `code_${j.code}` };
  } catch (err) {
    return { ok: false, reason: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}
