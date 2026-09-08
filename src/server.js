#!/usr/bin/env node
/**
 * autoclaw-openai-api — OpenAI-compatible HTTP API in front of the local AutoClaw gateway.
 *
 *   GET  /v1/models            -> model list (gateway models + agent ids)
 *   POST /v1/chat/completions  -> chat (stream & non-stream), OpenAI format
 *   GET  /health               -> liveness + gateway reachability
 *
 * Zero dependencies. Requires Node >= 22 (global WebSocket) and the AutoClaw app running.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Gateway, GatewayError, readToken } from './gateway.js';
import { getNodeStatus, getWallet } from './node-status.js';
import {
  listAccounts, pickAccount, headersFor, markCooldown,
  importFromStateDir, importFromBundle, removeAccount, accountWallet, hasAccounts, getAccount,
  getAgentSystemPrompt,
  startAutoRefreshLoop,
} from './accounts.js';
import {
  completionId, completionResponse, messagesToPrompt, buildUsage,
  extractAttachments, streamChunk, sseEncode, SSE_DONE, errorBody,
} from './openai-format.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const gateway = new Gateway((msg) => log(`[gateway] ${msg}`));

// ---------- helpers ----------

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(data);
}

function authorized(req) {
  if (config.apiKeys.length === 0) return true;
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return key && config.apiKeys.includes(key);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- models ----------

let modelsCache = { at: 0, data: null };

async function listModels() {
  if (modelsCache.data && Date.now() - modelsCache.at < 60_000) return modelsCache.data;
  const data = [];

  const [modelsRes, agentsRes] = await Promise.all([
    gateway.request('models.list', { view: 'configured' }).catch(() => null),
    gateway.request('agents.list').catch(() => null),
  ]);
  for (const m of modelsRes?.models ?? []) {
    data.push({
      id: m.id,
      object: 'model',
      owned_by: m.provider || 'autoclaw',
      created: 0,
      ...(m.contextWindow ? { context_length: m.contextWindow } : {}),
    });
  }
  // agent ids are valid `model` values too (they route the chat to that agent)
  for (const a of agentsRes?.agents ?? []) {
    if (!data.some((m) => m.id === a.id)) {
      data.push({ id: a.id, object: 'model', owned_by: 'autoclaw-agent', created: 0 });
    }
  }
  modelsCache = { at: Date.now(), data };
  return data;
}

// ---------- chat completions ----------

/**
 * Requests carrying OpenAI `tools` are proxied to the gateway's own
 * /v1/chat/completions HTTP endpoint (gateway.http.endpoints.chatCompletions),
 * which implements native function calling: the model emits `tool_calls`,
 * the client executes and posts the result back — exact OpenAI semantics.
 */
async function proxyToolsRequest(req, res, body, agentId) {
  const token = readToken();
  if (!token) return sendJson(res, 502, errorBody('gateway token unavailable'));

  const { model: _drop, activity: _a, ...forward } = body;
  const upstream = await fetch(`${config.gateway.httpUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...forward,
      model: agentId ? `openclaw/${agentId}` : 'openclaw',
    }),
  });

  if (body.stream === true) {
    res.writeHead(upstream.status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    return res.end();
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  return res.end(text);
}

/**
 * Direct-upstream chat: call the cloud proxy with an account's JWT, bypassing
 * the gateway. Enables multi-account quota pooling — on quota exhaustion the
 * account is cooled down and (in auto mode) the next one takes over.
 */
async function chatDirect(req, res, body) {
  const model = body.model;
  if (!model) return sendJson(res, 400, errorBody('`model` required in direct mode (upstream model id, e.g. zaicoding_glm-5.3)'));
  if (hasAccounts() === false) {
    return sendJson(res, 502, errorBody('no accounts imported — POST /v1/accounts/import first', 'server_error'));
  }

  const isStream = body.stream === true;
  const { account: preferred, direct: _d, activity: _a, ...openaiBody } = body;

  // The cloud proxy only serves agent-shaped requests: the AutoClaw system
  // prompt must lead the messages (policy gate — bare requests get 400).
  const agentPrompt = getAgentSystemPrompt();
  if (agentPrompt) {
    const msgs = Array.isArray(openaiBody.messages) ? [...openaiBody.messages] : [];
    if (msgs[0]?.role === 'system' && msgs[0]?.content?.includes('OpenClaw')) {
      // already agent-shaped
    } else {
      msgs.unshift({ role: 'system', content: agentPrompt });
    }
    openaiBody.messages = msgs;
  }
  const tried = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const account = pickAccount(attempt === 0 ? preferred : 'auto', model);
    if (!account) break;
    if (tried.includes(account.id)) continue;
    tried.push(account.id);

    // ghost-model guard: the gateway catalog lists models that don't exist on
    // the upstream proxy (gemini-*, glm-5.2, ...) — fail with the real list
    if (account.modelHeaders && !account.modelHeaders[model]) {
      const avail = Object.keys(account.modelHeaders);
      return sendJson(res, 400, errorBody(
        `Model "${model}" không tồn tại trên account ${account.label}. Các model khả dụng: ${avail.join(', ')}`,
        'invalid_request_error',
      ));
    }

    const headers = headersFor(account, model);
    let upstream;
    try {
      upstream = await fetch(`${account.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(openaiBody),
      });
    } catch (err) {
      markCooldown(account.id, 60_000, `network: ${err.message}`);
      continue;
    }

    if (upstream.status === 401 || upstream.status === 403) {
      const text = await upstream.text();
      const quota = /quota|810000/i.test(text);
      // quota is model-specific → cooldown that (account, model) pair only
      markCooldown(account.id, quota ? 10 * 60_000 : 60_000, `http_${upstream.status}: ${text.slice(0, 150)}`, quota ? model : undefined);
      if (!isStream) continue;
      if (!res.headersSent) continue;
      res.end();
      return;
    }
    if (upstream.status >= 500 || upstream.status === 429) {
      markCooldown(account.id, 60_000, `http_${upstream.status}`, model);
      if (!res.headersSent) continue;
      res.end();
      return;
    }

    if (isStream) {
      res.writeHead(upstream.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'X-Served-Account': account.label,
      });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      return res.end();
    }

    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Served-Account': account.label,
    });
    return res.end(text);
  }

  if (!res.headersSent) {
    sendJson(res, 502, errorBody(`all accounts failed or on cooldown (tried ${tried.length})`, 'server_error'));
  }
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, errorBody('invalid JSON body'));
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return sendJson(res, 400, errorBody('`messages` must be a non-empty array'));
  if ((body.n ?? 1) !== 1) return sendJson(res, 400, errorBody('only n=1 is supported'));
  const stream = body.stream === true;
  const wantActivity = body.activity === true; // UI flag: non-standard clients stay pure OpenAI
  const model = typeof body.model === 'string' && body.model ? body.model : 'autoclaw';
  const thinking = body.thinking; // off|minimal|low|medium|high|xhigh|max — gateway reasoning level

  // `model` may name an agent (e.g. "main", "auto-designer") — route the session there
  let agentId;
  try {
    const ids = (await listModels()).filter((m) => m.owned_by === 'autoclaw-agent').map((m) => m.id);
    if (ids.includes(model)) agentId = model;
  } catch { /* model list unavailable — send without agent routing */ }

  // function calling: hand the whole request to the gateway's native OpenAI endpoint
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return proxyToolsRequest(req, res, body, agentId);
  }

  // direct multi-account mode: body.account set, or DIRECT=1 default and agentId is absent
  if (body.account || (body.direct === true)) {
    return chatDirect(req, res, body);
  }

  const prompt = messagesToPrompt(messages);
  const attachments = await extractAttachments(messages); // OpenAI image_url parts -> gateway attachments
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);

  const started = Date.now();
  let settled = false;
  let abortRun = null;
  let lastActivity = null;

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(sseEncode(streamChunk({ id, created, model, delta: { role: 'assistant', content: '' } })));

      // client disconnects mid-stream -> abort the gateway run
      req.on('close', () => { if (!settled && abortRun) gateway.abortChat(abortRun.sessionKey); });
    }

    const result = await gateway.chat({
      message: prompt,
      agentId,
      thinking,
      attachments,
      timeoutMs: config.requestTimeoutMs,
      onStarted: ({ sessionKey }) => { abortRun = { sessionKey }; },
      onActivity: (stream && wantActivity)
        ? (event) => {
            if (event === lastActivity) return;
            lastActivity = event;
            res.write(sseEncode({ type: 'activity', event }));
          }
        : undefined,
      onDelta: stream
        ? (p) => {
            if (p.isReasoning === true) {
              if (p.deltaText) res.write(sseEncode(streamChunk({ id, created, model, delta: { reasoning_content: p.deltaText } })));
            } else if (p.deltaText) {
              res.write(sseEncode(streamChunk({ id, created, model, delta: { content: p.deltaText } })));
            }
          }
        : undefined,
    });
    settled = true;

    const usage = buildUsage({ promptText: prompt, completionText: result.text });
    const finishReason = result.state === 'aborted' ? 'length' : 'stop';
    // files the agent produced -> downloadable through our /v1/media proxy
    const mediaUrls = (result.media ?? []).map((p) => ({
      path: p,
      url: `/v1/media?path=${encodeURIComponent(p)}`,
    }));

    if (stream) {
      res.write(sseEncode(streamChunk({ id, created, model, delta: {}, finishReason, usage, ...(mediaUrls.length ? { media_urls: mediaUrls } : {}) })));
      res.write(SSE_DONE);
      res.end();
    } else {
      const resp = completionResponse({ id, created, model, content: result.text, finishReason, usage });
      if (mediaUrls.length) resp.media_urls = mediaUrls;
      sendJson(res, 200, resp);
    }
    log(`chat ok model=${model} agent=${agentId || '-'} imgs=${attachments.length} media=${mediaUrls.length} finish=${result.state} tokens=${usage.total_tokens} in ${Date.now() - started}ms`);
  } catch (err) {
    settled = true;

    // Quota/permission failure on the gateway's account → fall back to the
    // multi-account pool (direct mode), like CLIProxyAPI's credential rotation.
    // The gateway hides the 403 detail ("chat run failed"), so any agent-run
    // failure is worth one pool attempt — cooldowns stop hammering dead accounts.
    const quotaDead = /810000|quota|HTTP 403/i.test(err.message || '') || err.code === 'chat_error';
    if (quotaDead && hasAccounts() && !res.headersSent) {
      let directModel = body.model;
      if (agentId) {
        try {
          const cfg = await getAgentConfig();
          directModel = (cfg.primary || '').replace(/^zai\//, '') || directModel;
        } catch { /* keep requested model */ }
      }
      log(`gateway quota failure (${err.message.slice(0, 80)}) → falling back to account pool, model=${directModel}`);
      body.model = directModel;
      body.direct = true;
      body.account = 'auto';
      return await chatDirect(req, res, body);
    }

    const status = err instanceof GatewayError ? err.status : 500;
    const type = status >= 500 ? 'server_error' : 'invalid_request_error';
    if (stream) {
      if (!res.headersSent) {
        sendJson(res, status, errorBody(err.message, type, err.code));
      } else {
        res.write(sseEncode(errorBody(err.message, type, err.code)));
        res.write(SSE_DONE);
        res.end();
      }
    } else {
      sendJson(res, status, errorBody(err.message, type, err.code));
    }
    log(`chat error: ${err.message}`);
  }
}

// ---------- agent config (primary model) ----------

/** Read the live agent primary model through the gateway WS config API. */
async function getAgentConfig() {
  const cfg = await gateway.request('config.get', {});
  const parsed = cfg.parsed ?? cfg.config ?? {};
  const defaults = parsed.agents?.defaults?.model ?? {};
  const agentsList = (parsed.agents?.list ?? []).map((a) => ({ id: a.id, model: a.model ?? null }));
  const models = (parsed.models?.providers?.zai?.models ?? []).map((m) => m.id);
  return {
    primary: defaults.primary ?? null,
    pdfModel: defaults.pdfModel?.primary ?? null,
    agents: agentsList,
    availableModels: models,
    hash: cfg.hash,
  };
}

/** Set the primary model (normalizes `zai/<id>`), hot-reloaded by the gateway. */
async function setAgentPrimaryModel(model) {
  const raw = typeof model === 'string' ? model.trim() : '';
  if (!raw) throw new GatewayError('`primary` required (model id or zai/<id>)', 'invalid_request', 400);
  const primary = raw.includes('/') ? raw : `zai/${raw}`;

  const cfg = await gateway.request('config.get', {});
  const parsed = cfg.parsed ?? cfg.config ?? {};
  const known = (parsed.models?.providers?.zai?.models ?? []).map((m) => m.id);
  const short = primary.split('/')[1];
  if (known.length && !known.includes(short)) {
    throw new GatewayError(`unknown model "${short}" — known: ${known.join(', ')}`, 'invalid_request', 400);
  }
  parsed.agents ??= {};
  parsed.agents.defaults ??= {};
  parsed.agents.defaults.model ??= {};
  parsed.agents.defaults.model.primary = primary;
  await gateway.request('config.set', { raw: JSON.stringify(parsed, null, 2), baseHash: cfg.hash });
  return { ok: true, primary, note: 'hot-reloaded by gateway (may take a few seconds)' };
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    return res.end();
  }

  try {
    if (!authorized(req)) {
      return sendJson(res, 401, errorBody('invalid or missing API key', 'invalid_request_error', 'invalid_api_key'));
    }

    if (req.method === 'GET' && (url.pathname === '/health')) {
      await gateway.ensureConnected();
      return sendJson(res, 200, { ok: true, gateway: config.gateway.url });
    }

    if (req.method === 'GET' && (url.pathname === '/_status')) {
      const status = await getNodeStatus();
      return sendJson(res, 200, status);
    }

    // official credit balance + model availability (for hub / monitoring)
    if (req.method === 'GET' && (url.pathname === '/v1/quota' || url.pathname === '/quota')) {
      const [wallet, models] = await Promise.all([getWallet(), getNodeStatus()]);
      return sendJson(res, 200, {
        credits: wallet.error ? null : wallet.totalBalance,
        wallets: wallet.error ? [] : wallet.wallets,
        expiring: wallet.expiring ?? null,
        walletError: wallet.error ?? null,
        models: models.models ?? [],
      });
    }

    // ---- multi-account management ----
    if (url.pathname === '/v1/accounts') {
      if (req.method === 'GET') {
        const list = listAccounts();
        const withCredits = await Promise.all(list.map(async (a) => ({
          ...a,
          wallet: await accountWallet(getAccount(a.id) ?? {}),
        })));
        return sendJson(res, 200, { accounts: withCredits });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        try {
          let account;
          if (body.dir) account = importFromStateDir(body.dir, body.label);
          else if (body.bundle) account = importFromBundle({ ...body.bundle, label: body.label });
          else if (body.jwt && body.baseUrl) {
            account = importFromBundle({
              providerAuth: { zai: { baseUrl: body.baseUrl, models: [{ id: body.model || 'zai_auto', headers: { 'X-Authorization': body.jwt } }] } },
              label: body.label,
            });
          } else return sendJson(res, 400, errorBody('provide {dir} | {bundle} | {jwt+baseUrl}'));
          return sendJson(res, 201, { ok: true, id: account.id, label: account.label });
        } catch (err) {
          return sendJson(res, 400, errorBody(err.message));
        }
      }
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/accounts/')) {
      const id = url.pathname.split('/').pop();
      const ok = removeAccount(id);
      return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, errorBody('account not found'));
    }

    if (req.method === 'GET' && url.pathname === '/accounts') {
      const html = fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public', 'accounts.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }

    // ---- agent config: view / change primary model ----
    if (req.method === 'GET' && url.pathname === '/v1/agent-config') {
      return sendJson(res, 200, await getAgentConfig());
    }
    if (req.method === 'PUT' && url.pathname === '/v1/agent-config') {
      const body = JSON.parse(await readBody(req));
      try {
        return sendJson(res, 200, await setAgentPrimaryModel(body.primary ?? body.model));
      } catch (err) {
        const status = err instanceof GatewayError ? err.status : 502;
        return sendJson(res, status, errorBody(err.message, 'invalid_request_error', err.code));
      }
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/index.html')) {
      const uiPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public', 'index.html');
      const html = fs.readFileSync(uiPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return sendJson(res, 200, { object: 'list', data: await listModels() });
    }

    // Download files the agent produced (workspace paths surfaced as media_urls in chat responses).
    // Proxied to the gateway's assistant-media route, which itself validates the path
    // is inside agent media roots — arbitrary host files are rejected upstream.
    if (req.method === 'GET' && (url.pathname === '/v1/media' || url.pathname === '/media')) {
      const source = url.searchParams.get('path');
      if (!source) return sendJson(res, 400, errorBody('missing ?path='));
      const token = readToken();
      if (!token) return sendJson(res, 502, errorBody('gateway token unavailable'));
      const upstream = new URL(`${config.gateway.httpUrl}/__openclaw__/assistant-media`);
      upstream.searchParams.set('source', source);
      upstream.searchParams.set('token', token);
      const up = await fetch(upstream, { redirect: 'follow' });
      if (!up.ok) {
        const detail = await up.text().catch(() => '');
        return sendJson(res, up.status === 403 ? 403 : 502, errorBody(`gateway media fetch failed: ${detail.slice(0, 200) || up.status}`));
      }
      res.writeHead(200, {
        'Content-Type': up.headers.get('content-type') || 'application/octet-stream',
        'Content-Length': up.headers.get('content-length') || '',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      if (up.body) {
        for await (const chunk of up.body) res.write(chunk);
      }
      return res.end();
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      return await handleChatCompletions(req, res);
    }

    sendJson(res, 404, errorBody(`unknown route: ${route}`, 'invalid_request_error'));
  } catch (err) {
    const status = err instanceof GatewayError ? err.status : 500;
    sendJson(res, status, errorBody(err.message, status >= 500 ? 'server_error' : 'invalid_request_error', err.code));
    log(`${route} error: ${err.message}`);
  }
});

server.listen(config.port, config.host, () => {
  log(`autoclaw-openai-api listening on http://${config.host}:${config.port}/v1`);
  log(`  gateway      : ${config.gateway.url}`);
  log(`  auth         : ${config.apiKeys.length ? 'API key required' : 'disabled (set API_KEYS to enable)'}`);
  startAutoRefreshLoop(); // live accounts pick up rotated JWTs every 30 min
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    gateway.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
