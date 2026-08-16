/**
 * Extract the first real user prompt from the head of a `chat_history.jsonl`.
 *
 * Pure. The file is NDJSON; the reader that feeds us is byte-bounded, so the
 * last line may be truncated and unparseable. Those lines are skipped, never
 * thrown on. Synthetic user messages (environment preamble, `<system-reminder>`
 * blocks) come first; the real prompt is the first `type: "user"` line that
 * also has a `prompt_index` key, falling back to the first user line whose
 * text contains `<user_query>`.
 */

const PROMPT_CHAR_CAP = 4000;
const USER_QUERY_OPEN = '<user_query>';
const USER_QUERY_CLOSE = '</user_query>';

/** First real user prompt from the head of a chat_history.jsonl, or null. */
export function extractFirstPrompt(headText: string): string | null {
  let fallback: string | null = null;

  for (const line of headText.split(/\r?\n/)) {
    if (line === '') continue;
    const parsed = tryParseJson(line);
    if (parsed === undefined || !isRecord(parsed)) continue;
    if (parsed['type'] !== 'user') continue;

    const text = collectText(parsed);
    if (text === null) continue;

    // `prompt_index` is the measured discriminator for a real user turn. It
    // wins even when a synthetic line earlier happened to mention <user_query>.
    if (Object.hasOwn(parsed, 'prompt_index')) {
      return normalizePrompt(text);
    }

    if (fallback === null && text.includes(USER_QUERY_OPEN)) {
      fallback = text;
    }
  }

  return fallback === null ? null : normalizePrompt(fallback);
}

function collectText(record: Record<string, unknown>): string | null {
  const content = record['content'];
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] !== 'text') continue;
    const text = block['text'];
    if (typeof text === 'string') parts.push(text);
  }

  return parts.length === 0 ? null : parts.join('');
}

function normalizePrompt(text: string): string | null {
  const stripped = stripUserQueryWrapper(text);
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length > PROMPT_CHAR_CAP ? collapsed.slice(0, PROMPT_CHAR_CAP) : collapsed;
}

/**
 * Strip a leading `<user_query>` and a trailing `</user_query>` independently.
 *
 * The close tag is often missing: when grok offloads a large prompt it stores a
 * ~20 KB head in `chat_history.jsonl` and appends a pointer, so the stored
 * message never contains `</user_query>`. Requiring both tags left the open
 * tag in the label. Inner tags stay put — only the leading and trailing
 * occurrences go.
 */
function stripUserQueryWrapper(text: string): string {
  let stripped = text.trim();
  if (stripped.startsWith(USER_QUERY_OPEN)) {
    stripped = stripped.slice(USER_QUERY_OPEN.length);
  }
  if (stripped.endsWith(USER_QUERY_CLOSE)) {
    stripped = stripped.slice(0, stripped.length - USER_QUERY_CLOSE.length);
  }
  return stripped;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
