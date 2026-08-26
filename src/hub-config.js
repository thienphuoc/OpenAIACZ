import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadFileConfig() {
  const file = path.join(ROOT, 'hub-config.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[hub-config] failed to parse ${file}: ${err.message}`);
  }
  return {};
}

const fileCfg = loadFileConfig();

export const hubConfig = {
  host: process.env.HUB_HOST || fileCfg.host || '0.0.0.0',
  port: Number(process.env.HUB_PORT || fileCfg.port || 8788),
  adminKey: process.env.HUB_ADMIN_KEY || fileCfg.adminKey || '',
  strategy: process.env.HUB_STRATEGY || fileCfg.strategy || 'round-robin', // round-robin | fill-first
  probeIntervalMs: Number(process.env.HUB_PROBE_INTERVAL_MS || fileCfg.probeIntervalMs || 30_000),
  cooldownMs: Number(process.env.HUB_COOLDOWN_MS || fileCfg.cooldownMs || 60_000),
  apiKeys: (process.env.API_KEYS || (fileCfg.apiKeys ?? []).join(','))
    .split(',').map((s) => s.trim()).filter(Boolean),
  nodes: fileCfg.nodes ?? [],
};

export const registryPath = path.join(ROOT, 'hub-nodes.json');
