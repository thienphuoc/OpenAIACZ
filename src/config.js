import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Resolve `~`, `%APPDATA%`, `%LOCALAPPDATA%` inside configured paths. */
function resolveUserPath(p) {
  if (!p) return p;
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localappdata = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return p
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%APPDATA%/gi, appdata)
    .replace(/%LOCALAPPDATA%/gi, localappdata);
}

function loadFileConfig() {
  for (const name of ['config.json', 'config.example.json']) {
    if (name === 'config.example.json' && fs.existsSync(path.join(ROOT, 'config.json'))) continue;
    const file = path.join(ROOT, name);
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`[config] failed to parse ${file}: ${err.message}`);
    }
  }
  return {};
}

const fileCfg = loadFileConfig();

export const config = {
  host: process.env.HOST || fileCfg.host || '127.0.0.1',
  port: Number(process.env.PORT || fileCfg.port || 8787),

  // Downstream Bearer keys for THIS server. Empty array = auth disabled (local use).
  apiKeys: (process.env.API_KEYS || (fileCfg.apiKeys ?? []).join(','))
    .split(',').map((s) => s.trim()).filter(Boolean),

  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || fileCfg.requestTimeoutMs || 180_000),

  gateway: {
    url: process.env.AUTOCLAW_WS || fileCfg.gateway?.url || 'ws://127.0.0.1:18789',
    get httpUrl() {
      return this.url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    },
    stateDir: resolveUserPath(process.env.AUTOCLAW_STATE_DIR || fileCfg.gateway?.stateDir || path.join(os.homedir(), '.openclaw-autoclaw')),
    identityPath: resolveUserPath(
      process.env.AUTOCLAW_IDENTITY
      || fileCfg.gateway?.identityPath
      || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'autoclaw', 'identity', 'device.json')
    ),
  },
};

export function gatewayTokenPath() {
  return process.env.AUTOCLAW_TOKEN_FILE || path.join(config.gateway.stateDir, '.gateway-token');
}
