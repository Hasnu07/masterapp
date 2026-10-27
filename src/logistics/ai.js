/*
 * The logistics app's AI features (route optimizer, AI flights, "Parse & Add"
 * instructions, market prices, Stock Take) call Claude with the app's own
 * key, kept in its settings — which masterapp never copies. Here the key is
 * masterapp's own (ANTHROPIC_API_KEY); without one every AI button says so
 * and does nothing. One call: a system prompt, the user's words, an answer —
 * as text, or as JSON when the caller wants a structure back.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

export const aiReady = () => Boolean(config.ai.key);

let client = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.ai.key }));

/**
 * Asks Claude. `json: true` asks for a JSON answer and parses it (the first
 * {...} or [...] in the text). Throws with a plain message when there is no
 * key, or the API refused or failed.
 */
export async function ask({ system = '', prompt, json = false, maxTokens = 8000, images = [] }) {
  if (!aiReady()) throw Object.assign(new Error('No AI key: set ANTHROPIC_API_KEY to use the AI features'), { status: 409 });
  let r;
  try {
    r = await anthropic().beta.messages.create({
      model: config.ai.model,
      max_tokens: maxTokens,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [system, json ? 'Answer with JSON only — no prose around it.' : ''].filter(Boolean).join('\n\n'),
      // Pictures (data URLs from the console, e.g. the stock take's photos) go before the words.
      messages: [
        {
          role: 'user',
          content: [
            ...images
              .map((u) => String(u).match(/^data:(image\/[\w.+-]+);base64,(.+)$/))
              .filter(Boolean)
              .slice(0, 12)
              .map((m) => ({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })),
            { type: 'text', text: String(prompt) },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw Object.assign(new Error('The AI key was refused'), { status: 409 });
    if (err instanceof Anthropic.RateLimitError) throw Object.assign(new Error('The AI is busy — try again in a minute'), { status: 503 });
    if (err instanceof Anthropic.APIError) throw Object.assign(new Error(`The AI could not answer (${err.status})`), { status: 502 });
    throw Object.assign(new Error('The AI could not be reached'), { status: 502 });
  }
  if (r.stop_reason === 'refusal') throw Object.assign(new Error('The AI declined this request'), { status: 422 });
  const text = r.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!json) return text;
  const m = text.match(/[[{][\s\S]*[\]}]/);
  if (!m) throw Object.assign(new Error('The AI did not answer with a structure'), { status: 502 });
  try {
    return JSON.parse(m[0]);
  } catch {
    throw Object.assign(new Error('The AI answered with something that is not JSON'), { status: 502 });
  }
}
