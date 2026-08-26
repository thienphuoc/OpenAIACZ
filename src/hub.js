#!/usr/bin/env node
/**
 * autoclaw-hub — Admin panel + load balancer for pooling multiple AutoClaw API nodes.
 *
 *   GET  /admin           -> admin web UI
 *   POST /v1/chat/completions -> proxy to best available node (load balanced)
 *   GET  /v1/models       -> merged model list from all nodes
 *   GET  /health          -> hub health + node summary
 *
 * Admin API (requires X-Admin-Key or Authorization: Bearer <adminKey>):
 *   GET    /admin/api/nodes           -> list nodes + status
 *   POST   /admin/api/nodes           -> add node {url, label, apiKey}
 *   DELETE /admin/api/nodes/:id       -> remove node
 *   POST   /admin/api/nodes/:id/refresh -> force health probe
 *   GET    /admin/api/stats          -> usage stats per node
 *   PUT    /admin/api/strategy        -> set strategy
 *
 * Zero dependencies. Node >= 22.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { hubConfig, registryPath } from './hub-config.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------- node registry ----------
let nodes = [];          // {id, url, label, apiKey, status, latencyMs, models, lastCheck, cooldownUntil, stats}
let rrCursor = 0;

function loadRegistry() {
  try {
    if (fs.existsSync(registryPath)) {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      nodes = (data.nodes ?? []).map((n) => ({
        id: n.id || crypto.randomUUID(),
        url: n.url,
        label: n.label || n.url,
        apiKey: n.apiKey || '',
        status: 'unknown',
        latencyMs: null,
        models: [],
        lastCheck: 0,
        cooldownUntil: 0,
        stats: { success: 0, fail: 0, requests: 0, errors: [] },
      }));
      log(`loaded ${nodes.length} nodes from ${registryPath}`);
    }
  } catch (err) {
    log(`failed to load registry: ${err.message}`);
  }
  // seed from config if empty
  if (nodes.length === 0 && hubConfig.nodes.length > 0) {
    for (const n of hubConfig.nodes) {
      nodes.push(createNode(n.url, n.label, n.apiKey || ''));
    }
    saveRegistry();
    log(`seeded ${nodes.length} nodes from config`);
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(registryPath, JSON.stringify({
      nodes: nodes.map((n) => ({ id: n.id, url: n.url, label: n.label, apiKey: n.apiKey })),
    }, null, 2));
  } catch (err) {
    log(`failed to save registry: ${err.message}`);
  }
}

function createNode(url, label, apiKey) {
  return {
    id: crypto.randomUUID(),
    url: url.replace(/\/$/, ''),
    label: label || url,
    apiKey: apiKey || '',
    status: 'unknown',
    latencyMs: null,
    models: [],
    lastCheck: 0,
    cooldownUntil: 0,
    stats: { success: 0, fail: 0, requests: 0, errors: [] },
  };
}

// ---------- health probe ----------
async function probeNode(node) {
  const t0 = Date.now();
  try {
    // health check
    const res = await fetch(`${node.url}/health`, {
      signal: AbortSignal.timeout(8000),
      headers: node.apiKey ? { Authorization: `Bearer ${node.apiKey}` } : {},
    });
    if (!res.ok) {
      node.status = 'down';
      node.latencyMs = null;
      node.lastCheck = Date.now();
      return;
    }
    // model list + status probe
    const [modelsRes, statusRes] = await Promise.all([
      fetch(`${node.url}/v1/models`, {
        signal: AbortSignal.timeout(10000),
        headers: node.apiKey ? { Authorization: `Bearer ${node.apiKey}` } : {},
      }).catch(() => null),
      fetch(`${node.url}/_status`, {
        signal: AbortSignal.timeout(30000),
        headers: node.apiKey ? { Authorization: `Bearer ${node.apiKey}` } : {},
      }).catch(() => null),
    ]);

    node.models = modelsRes?.ok ? (await modelsRes.json()).data ?? [] : [];
    if (statusRes?.ok) {
      const s = await statusRes.json();
      node.quotaStatus = s;
    }
    node.latencyMs = Date.now() - t0;
    node.status = 'up';
    node.lastCheck = Date.now();
  } catch (err) {
    node.status = 'down';
    node.latencyMs = null;
    node.lastCheck = Date.now();
  }
}

async function probeAll() {
  await Promise.all(nodes.map(probeNode));
}

function startHealthLoop() {
  probeAll().then(() => log('initial health probe done'));
  setInterval(() => probeAll().then(() => {}), hubConfig.probeIntervalMs);
}

// ---------- load balancing ----------
function isAvailable(node) {
  if (node.status !== 'up') return false;
  if (node.cooldownUntil > Date.now()) return false;
  return true;
}

function pickNode() {
  const available = nodes.filter(isAvailable);
  if (available.length === 0) return null;

  if (hubConfig.strategy === 'fill-first') {
    return available[0];
  }
  // round-robin
  const node = available[rrCursor % available.length];
  rrCursor = (rrCursor + 1) % Number.MAX_SAFE_INTEGER;
  return node;
}

function markCooldown(node, reason) {
  node.cooldownUntil = Date.now() + hubConfig.cooldownMs;
  node.stats.fail++;
  node.stats.errors.push({ ts: Date.now(), reason: String(reason).slice(0, 200) });
  if (node.stats.errors.length > 20) node.stats.errors.shift();
  log(`node ${node.label} cooldown ${hubConfig.cooldownMs}ms: ${reason}`);
}

// ---------- HTTP helpers ----------
function sendJson(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(data);
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function adminAuthed(req) {
  if (!hubConfig.adminKey) return true; // no key = open (local dev)
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const xKey = req.headers['x-admin-key'] || '';
  return (bearer && bearer === hubConfig.adminKey) || (xKey && xKey === hubConfig.adminKey);
}

function clientAuthed(req) {
  if (hubConfig.apiKeys.length === 0) return true;
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return key && hubConfig.apiKeys.includes(key);
}

// ---------- proxy chat completions ----------
async function proxyChat(req, res, body) {
  const parsed = JSON.parse(body);
  const model = parsed.model;
  const isStream = parsed.stream === true;

  // try up to 3 nodes
  const tried = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const node = pickNode();
    if (!node) {
      if (!res.headersSent) sendJson(res, 503, { error: { message: 'no available nodes', type: 'server_error' } });
      return;
    }
    tried.push(node.id);
    node.stats.requests++;

    try {
      const upstream = await fetch(`${node.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(node.apiKey ? { Authorization: `Bearer ${node.apiKey}` } : {}),
        },
        body,
      });

      if (upstream.status >= 500 || upstream.status === 429) {
        markCooldown(node, `upstream ${upstream.status}`);
        if (!isStream) continue; // try next node for non-stream
        // for stream, if headers not sent yet, try next
        if (!res.headersSent) continue;
        // headers already sent — can't retry, return what we have
        res.writeHead(upstream.status);
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
        return res.end();
      }

      // success path
      node.stats.success++;

      if (isStream) {
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
          'X-Served-By': node.label,
        });
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
        return res.end();
      }

      // non-stream: forward JSON
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Served-By': node.label,
      });
      return res.end(text);
    } catch (err) {
      markCooldown(node, err.message);
      if (!res.headersSent) continue;
      res.end();
      return;
    }
  }

  // all attempts failed
  if (!res.headersSent) {
    sendJson(res, 502, {
      error: {
        message: `all nodes failed or on cooldown (tried ${tried.length})`,
        type: 'server_error',
        tried_nodes: tried,
      },
    });
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Key',
    });
    return res.end();
  }

  try {
    // ---- admin web UI ----
    if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }

    // ---- admin API ----
    if (url.pathname.startsWith('/admin/api/')) {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: { message: 'invalid admin key' } });

      if (req.method === 'GET' && url.pathname === '/admin/api/nodes') {
        return sendJson(res, 200, {
          nodes: nodes.map((n) => ({
            id: n.id, url: n.url, label: n.label, status: n.status,
            latencyMs: n.latencyMs, modelCount: n.models.length,
            models: n.models.slice(0, 30).map((m) => m.id),
            quotaStatus: n.quotaStatus || null,
            lastCheck: n.lastCheck ? new Date(n.lastCheck).toISOString() : null,
            cooldownUntil: n.cooldownUntil > Date.now() ? new Date(n.cooldownUntil).toISOString() : null,
            stats: n.stats,
          })),
        });
      }

      if (req.method === 'POST' && url.pathname === '/admin/api/nodes') {
        const body = JSON.parse(await readBody(req));
        if (!body.url) return sendJson(res, 400, { error: { message: 'url required' } });
        const node = createNode(body.url, body.label, body.apiKey || '');
        nodes.push(node);
        saveRegistry();
        probeNode(node).then(() => {});
        return sendJson(res, 201, { ok: true, id: node.id });
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/admin/api/nodes/')) {
        const id = url.pathname.split('/').pop();
        const idx = nodes.findIndex((n) => n.id === id);
        if (idx < 0) return sendJson(res, 404, { error: { message: 'node not found' } });
        nodes.splice(idx, 1);
        saveRegistry();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname.includes('/refresh')) {
        const id = url.pathname.split('/').slice(-2, -1)[0];
        const node = nodes.find((n) => n.id === id);
        if (!node) return sendJson(res, 404, { error: { message: 'node not found' } });
        await probeNode(node);
        return sendJson(res, 200, { ok: true, status: node.status });
      }

      if (req.method === 'GET' && url.pathname === '/admin/api/stats') {
        return sendJson(res, 200, {
          strategy: hubConfig.strategy,
          nodes: nodes.map((n) => ({
            id: n.id, label: n.label, status: n.status,
            requests: n.stats.requests, success: n.stats.success, fail: n.stats.fail,
            cooldown: n.cooldownUntil > Date.now(),
            recentErrors: n.stats.errors.slice(-5),
          })),
        });
      }

      if (req.method === 'PUT' && url.pathname === '/admin/api/strategy') {
        const body = JSON.parse(await readBody(req));
        if (!['round-robin', 'fill-first'].includes(body.strategy)) {
          return sendJson(res, 400, { error: { message: 'invalid strategy' } });
        }
        hubConfig.strategy = body.strategy;
        return sendJson(res, 200, { ok: true, strategy: hubConfig.strategy });
      }

      // ---- auth export/import: let another machine copy credentials ----
      if (req.method === 'GET' && url.pathname === '/admin/api/auth/export') {
        // returns .gateway-token + device.json + openclaw.json (JWT) as JSON bundle
        const stateDir = process.env.AUTOCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw-autoclaw');
        try {
          const gatewayToken = fs.readFileSync(path.join(stateDir, '.gateway-token'), 'utf8').trim();
          const deviceIdentity = JSON.parse(fs.readFileSync(path.join(stateDir, 'identity', 'device.json'), 'utf8'));
          const openclawConfig = JSON.parse(fs.readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8'));
          // extract only the JWT headers (the real credential) — not the whole config
          const providers = openclawConfig.models?.providers ?? {};
          const providerAuth = {};
          for (const [name, prov] of Object.entries(providers)) {
            providerAuth[name] = {
              baseUrl: prov.baseUrl,
              apiKey: prov.apiKey,
              headers: prov.headers,
              models: (prov.models ?? []).map((m) => ({
                id: m.id,
                name: m.name,
                headers: m.headers,
              })),
            };
          }
          return sendJson(res, 200, {
            gatewayToken,
            deviceIdentity,
            providerAuth,
            exportedAt: new Date().toISOString(),
          });
        } catch (err) {
          return sendJson(res, 500, { error: { message: `auth export failed: ${err.message}` } });
        }
      }

      if (req.method === 'POST' && url.pathname === '/admin/api/auth/import') {
        // accepts the bundle from export — writes to state dir on THIS machine
        const body = JSON.parse(await readBody(req));
        const stateDir = process.env.AUTOCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw-autoclaw');
        try {
          if (body.gatewayToken) {
            fs.mkdirSync(path.dirname(path.join(stateDir, '.gateway-token')), { recursive: true });
            fs.writeFileSync(path.join(stateDir, '.gateway-token'), body.gatewayToken + '\n');
          }
          if (body.deviceIdentity) {
            fs.mkdirSync(path.join(stateDir, 'identity'), { recursive: true });
            fs.writeFileSync(path.join(stateDir, 'identity', 'device.json'), JSON.stringify(body.deviceIdentity, null, 2));
          }
          if (body.providerAuth) {
            // merge provider auth into openclaw.json
            const cfgPath = path.join(stateDir, 'openclaw.json');
            let cfg = {};
            try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = {}; }
            cfg.models ??= { providers: {} };
            cfg.models.providers ??= {};
            for (const [name, prov] of Object.entries(body.providerAuth)) {
              if (!cfg.models.providers[name]) cfg.models.providers[name] = {};
              cfg.models.providers[name].baseUrl = prov.baseUrl;
              cfg.models.providers[name].apiKey = prov.apiKey;
              if (prov.headers) cfg.models.providers[name].headers = prov.headers;
              if (prov.models) {
                for (const m of prov.models) {
                  const existing = (cfg.models.providers[name].models ??= []).find((x) => x.id === m.id);
                  if (existing) {
                    if (m.headers) existing.headers = m.headers;
                  } else {
                    cfg.models.providers[name].models.push({ id: m.id, name: m.name, headers: m.headers });
                  }
                }
              }
            }
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          }
          return sendJson(res, 200, { ok: true, message: 'auth imported — restart node to take effect' });
        } catch (err) {
          return sendJson(res, 500, { error: { message: `auth import failed: ${err.message}` } });
        }
      }

      return sendJson(res, 404, { error: { message: `unknown admin route: ${route}` } });
    }

    // ---- client-facing API ----
    if (!clientAuthed(req)) {
      return sendJson(res, 401, { error: { message: 'invalid or missing API key' } });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        hub: true,
        nodes: nodes.length,
        up: nodes.filter((n) => n.status === 'up').length,
        strategy: hubConfig.strategy,
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      // merge models from all up nodes, de-dup by id
      const seen = new Map();
      for (const n of nodes.filter((n) => n.status === 'up')) {
        for (const m of n.models) {
          if (!seen.has(m.id)) seen.set(m.id, m);
        }
      }
      return sendJson(res, 200, { object: 'list', data: [...seen.values()] });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readBody(req);
      return await proxyChat(req, res, body);
    }

    sendJson(res, 404, { error: { message: `unknown route: ${route}` } });
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { error: { message: err.message, type: 'server_error' } });
    log(`${route} error: ${err.message}`);
  }
});

loadRegistry();
server.listen(hubConfig.port, hubConfig.host, () => {
  log(`autoclaw-hub listening on http://${hubConfig.host}:${hubConfig.port}/admin`);
  log(`  strategy    : ${hubConfig.strategy}`);
  log(`  admin key   : ${hubConfig.adminKey ? 'required' : 'open (local dev)'}`);
  log(`  client auth : ${hubConfig.apiKeys.length ? 'API key required' : 'disabled'}`);
  log(`  nodes       : ${nodes.length}`);
  startHealthLoop();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down hub');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
