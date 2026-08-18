/**
 * Caps on fields that become individual argv elements.
 *
 * Linux MAX_ARG_STRLEN is 128 KiB per argv element (32 pages), independently
 * of the much larger total ARG_MAX. These ceilings sit well below that so a
 * well-formed call cannot reach E2BIG; the spawn-failed E2BIG message is the
 * backstop, not the routine outcome.
 *
 * Prompt-shaped text (`grok.prompt`, `review.instructions`, `websearch.query`,
 * `websearch.instructions`) is not capped here: it is folded into the prompt
 * and delivered through `--prompt-file` above a threshold.
 */

/** `cwd` — a filesystem path, one `--cwd` element. */
export const ARGV_PATH_MAX = 4096;

/**
 * Short identifiers that become one flag value: `model`, `effort`, `agent`,
 * `resume`, `sessionId`, `forkSession`, `review.base`, `review.commit`.
 */
export const ARGV_TOKEN_MAX = 256;

/** `--rules` is one argv element. Longer system-prompt text belongs in the prompt. */
export const ARGV_RULES_MAX = 8192;

/** `tools`, `disallowedTools`, `allow`, `deny` — item count. */
export const ARGV_LIST_MAX = 100;

/** Each item of those lists is one argv element (`--allow` / `--deny`) or part of a joined `--tools`. */
export const ARGV_LIST_ITEM_MAX = 512;
