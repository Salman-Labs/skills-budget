/** Codex `APPROX_BYTES_PER_TOKEN` (`codex-rs/ext/skills/src/render.rs`). */
export const BYTES_PER_TOKEN = 4;

/**
 * Same integer rule as Codex `approx_token_count`: ceil(utf8Bytes / 4).
 * For ASCII skill text this is the familiar chars/4 heuristic.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function codePoints(text: string): string[] {
  return Array.from(text);
}

export function codePointLength(text: string): number {
  return codePoints(text).length;
}

export function sliceCodePoints(text: string, count: number): string {
  if (count <= 0) return "";
  return codePoints(text).slice(0, count).join("");
}

/** Collapse whitespace the way a one-line listing injection does. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
