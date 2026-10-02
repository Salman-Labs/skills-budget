export interface SkillFrontmatter {
  name?: string;
  description?: string;
  whenToUse?: string;
  disableModelInvocation: boolean;
}

const BLOCK_MARKERS = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

/**
 * Minimal YAML frontmatter reader for SKILL.md and agent markdown.
 * Supports scalars, quoted strings, and `|` / `>` blocks. Other YAML is ignored.
 */
export function parseFrontmatter(markdown: string): SkillFrontmatter | null {
  let text = markdown;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const after = text.slice(end + 4, end + 5);
  if (after !== "" && after !== "\n") return null;

  const block = text.slice(text.indexOf("\n", 0) + 1, end);
  const values = parseBlock(block);
  const description = clean(values.description);
  const whenToUse = clean(values.when_to_use);
  const name = clean(values.name);
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    disableModelInvocation: isTrue(values["disable-model-invocation"]),
  };
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseBlock(block: string): Record<string, string> {
  const lines = block.split("\n");
  const values: Record<string, string> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1] ?? "";
    const raw = match[2] ?? "";
    if (BLOCK_MARKERS.has(raw.trim())) {
      const folded = raw.trim().startsWith(">");
      const parsed = readBlockScalar(lines, index + 1);
      values[key] = folded ? foldScalar(parsed.value) : parsed.value;
      index = parsed.next;
      continue;
    }
    values[key] = unquote(raw.trim());
    index += 1;
  }
  return values;
}

function readBlockScalar(lines: string[], start: number): { value: string; next: number } {
  const content: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      content.push("");
      index += 1;
      continue;
    }
    if (!/^\s/.test(line)) break;
    content.push(line);
    index += 1;
  }
  while (content.length > 0 && content[content.length - 1] === "") content.pop();
  let indent = Number.POSITIVE_INFINITY;
  for (const line of content) {
    if (line === "") continue;
    const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (leading < indent) indent = leading;
  }
  if (!Number.isFinite(indent)) indent = 0;
  const stripped = content.map((line) => (line === "" ? "" : line.slice(indent)));
  return { value: stripped.join("\n").trim(), next: index };
}

function foldScalar(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}
