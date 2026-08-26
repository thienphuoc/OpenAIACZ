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
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    gateway.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
