/**
 * AutoClaw / OpenClaw gateway WebSocket client.
 *
 * Handshake (protocol 4):
 *   1. open WS, receive event `connect.challenge` -> {nonce}
 *   2. sign `v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce`
 *      with the Ed25519 device key -> base64url
 *   3. request `connect` {minProtocol:4, maxProtocol:4, client, role, scopes, device, auth:{token}}
 * Frames: {type:'req',id,method,params} / {type:'res',id,ok,payload|error} / {type:'event',event,payload}
 * Chat runs stream back as `chat` events keyed by runId.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, gatewayTokenPath } from './config.js';

const ROLE = 'operator';
const SCOPES = ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'];
const CLIENT = {
  id: 'cli',
  version: '1.0.0',
  platform: process.platform,
  mode: 'cli',
  instanceId: crypto.randomUUID(),
};

const b64u = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class GatewayError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code || 'gateway_error';
    this.status = status || 502;
  }
}

function loadIdentity() {
  const file = config.gateway.identityPath;
  let dev;
  try {
    dev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new GatewayError(`cannot read device identity at ${file} — is the AutoClaw app installed?`, 'identity_missing', 500);
  }
  const spki = crypto.createPublicKey(dev.publicKeyPem).export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(ED25519_SPKI_PREFIX.length);
  return {
    deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
    publicKey: b64u(raw),
    privateKeyPem: dev.privateKeyPem,
  };
}

function readToken() {
  if (process.env.AUTOCLAW_TOKEN) return process.env.AUTOCLAW_TOKEN;
  try {
    return fs.readFileSync(gatewayTokenPath(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export { readToken };

export class Gateway {
  constructor(log = () => {}) {
    this.log = log;
    this.ws = null;
    this.hello = null;
    this.pending = new Map();      // reqId -> {resolve,reject,timer,method}
    this.chatWaiters = new Map();  // runId  -> {onDelta, resolve, reject, timer, texts}
    this.eventListeners = new Set();
    this.connecting = null;
    this.backoffMs = 500;
    this.stopping = false;
    this.nextId = 1;
    this.identity = loadIdentity();
  }

  /** Lazily connect (or reuse) the shared socket. Safe to call per request. */
  async ensureConnected() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.hello) return this.hello;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    const token = readToken();
    if (!token) throw new GatewayError(`gateway token not found (${gatewayTokenPath()}) — is the AutoClaw app running?`, 'token_missing', 502);

    for (let attempt = 1; ; attempt++) {
      try {
        await this.#openSocket(token);
        this.backoffMs = 500;
        return this.hello;
      } catch (err) {
        this.log(`connect attempt ${attempt} failed: ${err.message}`);
        if (err.code === 'identity_missing' || err.fatal) throw err;
        if (attempt >= 5) {
          throw new GatewayError(`cannot reach AutoClaw gateway at ${config.gateway.url}: ${err.message}`, 'gateway_unreachable', 502);
        }
        await new Promise((r) => setTimeout(r, this.backoffMs));
        this.backoffMs = Math.min(this.backoffMs * 2, 5000);
      }
    }
  }

  #openSocket(token) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      const ws = new WebSocket(config.gateway.url);
      this.ws = ws;
      this.hello = null;

      const challengeTimer = setTimeout(() => fail(new Error('connect challenge timeout')), 10_000);

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'event' && msg.event === 'connect.challenge' && !settled) {
          this.#sendConnect(ws, token, msg.payload?.nonce)
            .then((hello) => {
              settled = true;
              clearTimeout(challengeTimer);
              this.hello = hello;
              this.log('connected to gateway');
              resolve(hello);
            })
            .catch((err) => { clearTimeout(challengeTimer); fail(err); });
          return;
        }
        this.#handleFrame(msg);
      };
      ws.onerror = () => fail(new Error('websocket error'));
      ws.onclose = (ev) => {
        clearTimeout(challengeTimer);
        this.#onSocketClosed(ev);
        fail(new Error(`gateway closed (${ev.code})`));
      };
    });
  }

  async #sendConnect(ws, token, nonce) {
    const signedAt = Date.now();
    const payload = ['v2', this.identity.deviceId, CLIENT.id, CLIENT.mode, ROLE,
      SCOPES.join(','), String(signedAt), token ?? '', nonce].join('|');
    const signature = b64u(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(this.identity.privateKeyPem)));

    return await this.#requestOn(ws, 'connect', {
      minProtocol: 4,
      maxProtocol: 4,
      client: CLIENT,
      role: ROLE,
      scopes: SCOPES,
      device: {
        id: this.identity.deviceId,
        publicKey: this.identity.publicKey,
        signature,
        signedAt,
        nonce,
      },
      caps: ['tool-events'],
      auth: { token },
      userAgent: `autoclaw-openai-api node/${process.versions.node}`,
      locale: 'en-US',
    }, 15_000);
  }

  #handleFrame(msg) {
    if (msg.type === 'event') {
      if (msg.event === 'chat') this.#onChatEvent(msg.payload);
      for (const fn of this.eventListeners) {
        try { fn(msg); } catch { /* listener errors must not break the socket */ }
      }
      return;
    }
    if (msg.type !== 'res') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.payload);
    else {
      const err = new GatewayError(msg.error?.message || `gateway request ${p.method} failed`, msg.error?.code, 502);
      err.details = msg.error?.details;
      p.reject(err);
    }
  }

  #onSocketClosed(ev) {
    const err = new GatewayError(`gateway connection lost (${ev.code})`, 'gateway_disconnected', 502);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    for (const w of this.chatWaiters.values()) { clearTimeout(w.timer); w.reject(err); }
    this.chatWaiters.clear();
    this.hello = null;
    if (!this.stopping) this.log('gateway socket closed');
  }

  #requestOn(ws, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new GatewayError('gateway not connected', 'not_connected', 502));
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError(`timeout: ${method}`, 'timeout', 504));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    return this.ensureConnected().then(() => this.#requestOn(this.ws, method, params, timeoutMs));
  }

  #onChatEvent(payload) {
    const runId = payload?.runId;
    const w = runId ? this.chatWaiters.get(runId) : undefined;
    if (!w) return;
    // media references can ride on any payload of the run (files the agent produced)
    if (payload.mediaUrl) w.medias.push(payload.mediaUrl);
    if (Array.isArray(payload.mediaUrls)) w.medias.push(...payload.mediaUrls);
    if (payload.state === 'delta') {
      w.onDelta?.(payload);
      if (typeof payload.deltaText === 'string' && payload.deltaText) w.texts.push(payload.deltaText);
      return;
    }
    if (payload.state === 'final' || payload.state === 'ok' || payload.state === 'aborted' || payload.state === 'error') {
      this.chatWaiters.delete(runId);
      clearTimeout(w.timer);
      const content = Array.isArray(payload?.message?.content)
        ? payload.message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('')
        : '';
      if (payload.state === 'error') {
        w.reject(new GatewayError(payload.error || 'chat run failed', 'chat_error', 502));
      } else {
        w.resolve({
          state: payload.state,
          text: content || w.texts.join(''),
          stopReason: payload.stopReason,
          media: [...new Set(w.medias)].filter(Boolean),
        });
      }
    }
  }

  /**
   * Send one chat turn on a fresh session and stream deltas.
   * @returns {Promise<{runId:string, state:string, text:string, stopReason?:string, media:string[]}>}
   */
  async chat({ message, agentId, thinking, attachments, onDelta, onStarted, onActivity, timeoutMs }) {
    await this.ensureConnected();
    const created = await this.request('sessions.create', agentId ? { agentId } : {});
    const sessionKey = created?.key;
    if (!sessionKey) throw new GatewayError('sessions.create returned no key', 'session_error', 502);

    // surface gateway activity (tool runs, agent state) while the reply is pending
    let activityFn = null;
    if (onActivity) {
      activityFn = (msg) => {
        if (msg.type === 'event' && msg.event !== 'chat' && msg.payload?.sessionKey === sessionKey) {
          onActivity(msg.event);
        }
      };
      this.eventListeners.add(activityFn);
    }
    const dropActivity = () => { if (activityFn) this.eventListeners.delete(activityFn); };

    const ack = await this.request('chat.send', {
      sessionKey,
      message,
      ...(attachments?.length ? { attachments } : {}),
      ...(thinking ? { thinking } : {}),
      deliver: false,
      idempotencyKey: crypto.randomUUID(),
    });
    const runId = ack?.runId;
    if (!runId) throw new GatewayError('chat.send returned no runId', 'chat_error', 502);
    onStarted?.({ sessionKey, runId });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.chatWaiters.delete(runId);
        dropActivity();
        this.request('chat.abort', { sessionKey }).catch(() => {});
        reject(new GatewayError('chat run timed out', 'timeout', 504));
      }, timeoutMs || config.requestTimeoutMs);
      this.chatWaiters.set(runId, {
        onDelta, texts: [], medias: [], timer,
        resolve: (v) => { dropActivity(); resolve(v); },
        reject: (e) => { dropActivity(); reject(e); },
      });
    });
  }

  async abortChat(sessionKey) {
    try { await this.request('chat.abort', { sessionKey }); } catch { /* best effort */ }
  }

  stop() {
    this.stopping = true;
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}
