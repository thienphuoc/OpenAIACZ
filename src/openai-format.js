/** OpenAI wire-format helpers: chunk builders, message conversion, usage estimates. */

export function completionId() {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Flatten OpenAI message content (string or multimodal parts) to plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

/**
 * Convert an OpenAI chat `messages` array into one gateway prompt string.
 * Fresh gateway session per request => the whole conversation is embedded.
 * Single-turn requests pass through untouched for the cleanest agent prompt.
 */
export function messagesToPrompt(messages) {
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => contentToText(m.content)).filter(Boolean).join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
  const turns = convo.map((m) => {
    const who = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User';
    return `${who}: ${contentToText(m.content)}`.trim();
  }).filter(Boolean);

  if (!system && turns.length <= 1) return turns[0] ?? '';

  const parts = [];
  if (system) parts.push(`[Instructions]\n${system}`);
  if (turns.length > 1) {
    parts.push('[Conversation so far]\n' + turns.slice(0, -1).join('\n\n'));
    parts.push('[Latest message — reply to this as the assistant]\n' + turns[turns.length - 1]);
  } else if (turns.length === 1) {
    parts.push(turns[0]);
  }
  return parts.join('\n\n');
}

/** Rough token estimate (~4 chars/token) — the gateway does not report usage per run. */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil((text?.length || 0) / 4));
}

// gateway hard limits (attachment-normalize): 6MB per image, 10 images per text-only offload
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGES = 10;

/**
 * Extract OpenAI multimodal image parts into gateway chat.send attachments.
 * Accepts data: URLs (inline base64) and http(s) URLs (fetched once).
 * @returns {Promise<Array<{type:'image', mimeType:string, fileName:string, content:string}>>}
 */
export async function extractAttachments(messages) {
  const out = [];
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      if (part?.type !== 'image_url' || typeof part.image_url?.url !== 'string') continue;
      const url = part.image_url.url;

      const dataUrl = /^data:([^;]+);base64,(.+)$/s.exec(url);
      if (dataUrl) {
        out.push({ type: 'image', mimeType: dataUrl[1].toLowerCase(), fileName: 'image', content: dataUrl[2] });
        continue;
      }
      if (/^https?:\/\//i.test(url)) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) continue;
          const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
          out.push({ type: 'image', mimeType: mime, fileName: url.split('/').pop()?.slice(0, 80) || 'image', content: Buffer.from(await res.arrayBuffer()).toString('base64') });
        } catch { /* unreachable image — skip */ }
      }
    }
  }
  return out
    .filter((a) => {
      const bytes = Math.floor(a.content.length * 3 / 4);
      return bytes <= MAX_IMAGE_BYTES;
    })
    .slice(0, MAX_IMAGES);
}

export function buildUsage({ promptText, completionText }) {
  const prompt_tokens = estimateTokens(promptText);
  const completion_tokens = estimateTokens(completionText);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

export function streamChunk({ id, created, model, delta, finishReason = null, usage, ...extra }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
    ...extra,
  };
}

export function completionResponse({ id, created, model, content, reasoning, finishReason = 'stop', usage }) {
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

export function sseEncode(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

export function errorBody(message, type = 'invalid_request_error', code) {
  return { error: { message, type, ...(code ? { code } : {}) } };
}
