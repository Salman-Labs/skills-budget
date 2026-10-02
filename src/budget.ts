import type {
  AnalyzeResult,
  BudgetEntry,
  CatalogItem,
  Harness,
  SkillStatus,
  StatusReason,
  TrimSuggestion,
} from "./types.js";
import { SkillsBudgetError } from "./types.js";
import {
  codePointLength,
  codePoints,
  estimateTokens,
  oneLine,
  sliceCodePoints,
} from "./tokens.js";

/**
 * Codex listing budget, from `skill_metadata_budget` in
 * https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/render.rs
 *
 * When the context window is known the budget is
 * `max(1, context_window * 2 / 100)` tokens. There is no 8,000-token ceiling.
 * `DEFAULT_SKILL_METADATA_CHAR_BUDGET` (8_000) is a character fallback used
 * only when the window is unknown. Public docs say the same thing:
 * https://developers.openai.com/codex/skills
 *
 * Descriptions are pre-capped at 1,024 characters (`MAX_CATALOG_SKILL_DESCRIPTION_CHARS`)
 * with a `...` suffix, then fit by round-robin. Names that still do not fit are omitted.
 */
export const CODEX_CONTEXT_PERCENT = 2;
export const CODEX_DESCRIPTION_CHAR_CAP = 1024;
export const CODEX_UNKNOWN_WINDOW_CHAR_BUDGET = 8_000;

/**
 * Claude Code listing budget, from
 * https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short
 * and https://github.com/anthropics/claude-code/issues/81081
 *
 * Default `skillListingBudgetFraction` is 0.01 (1% of the context window).
 * Every skill name stays. Descriptions longer than `skillListingMaxDescChars`
 * (1,536, including `when_to_use`) are cut first. Overflow drops whole
 * descriptions, documented as least-used first.
 */
export const CLAUDE_CONTEXT_PERCENT = 1;
export const CLAUDE_DESCRIPTION_CHAR_CAP = 1536;

const TOKEN_HEURISTIC = "ceil(utf8Bytes/4)" as const;
const SUGGESTION_LIMIT = 5;

export function assertContext(context: number): void {
  if (!Number.isInteger(context) || context < 1) {
    throw new SkillsBudgetError("context must be a positive integer number of tokens");
  }
}

export function assertHarness(harness: string): asserts harness is Harness {
  if (harness !== "codex" && harness !== "claude") {
    throw new SkillsBudgetError("harness must be \"codex\" or \"claude\"");
  }
}

export function codexBudgetTokens(contextTokens: number): number {
  assertContext(contextTokens);
  return Math.max(1, Math.floor((contextTokens * CODEX_CONTEXT_PERCENT) / 100));
}

export function claudeBudgetTokens(contextTokens: number): number {
  assertContext(contextTokens);
  return Math.max(1, Math.floor((contextTokens * CLAUDE_CONTEXT_PERCENT) / 100));
}

export function budgetTokensFor(harness: Harness, contextTokens: number): number {
  return harness === "codex" ? codexBudgetTokens(contextTokens) : claudeBudgetTokens(contextTokens);
}

export function budgetRule(harness: Harness, contextTokens: number, budget: number): string {
  if (harness === "codex") {
    return (
      `floor(${contextTokens} * ${CODEX_CONTEXT_PERCENT} / 100) = ${budget} tokens. ` +
      "Codex uses 2% of a known context window (skill_metadata_budget in codex-rs/ext/skills/src/render.rs). " +
      `The ${CODEX_UNKNOWN_WINDOW_CHAR_BUDGET}-character constant is only the fallback when the window is unknown; ` +
      "current source does not clamp this token budget at 8000."
    );
  }
  return (
    `floor(${contextTokens} * ${CLAUDE_CONTEXT_PERCENT} / 100) = ${budget} tokens. ` +
    "Claude Code scales the skill listing at 1% of the context window (skillListingBudgetFraction default 0.01) " +
    `and caps each description plus when_to_use at ${CLAUDE_DESCRIPTION_CHAR_CAP} characters.`
  );
}

interface Prepared {
  item: CatalogItem;
  original: string;
  capped: string;
}

interface Allocation {
  omitted: boolean;
  /** Code points kept from `capped`. */
  includedChars: number;
}

export function applyBudget(
  items: readonly CatalogItem[],
  options: { harness: Harness; context: number; includeAgents?: boolean; warnings?: readonly string[]; scannedDirs?: readonly string[] },
): AnalyzeResult {
  assertHarness(options.harness);
  assertContext(options.context);
  const harness = options.harness;
  const budget = budgetTokensFor(harness, options.context);
  const prepared = items.map((item) => prepare(item, harness));
  const ordered = orderForHarness(prepared, harness);
  const allocations =
    harness === "codex" ? allocateCodex(ordered, budget) : allocateClaude(ordered, budget);

  const entries = ordered.map((row, index) => toEntry(row, allocations[index] ?? { omitted: true, includedChars: 0 }, harness));
  const totals = summarize(entries, budget);
  const suggestions = suggest(entries, ordered.map((row) => row.original));
  const warnings = [...(options.warnings ?? [])];
  if (harness === "claude" && totals.usedTokens > budget) {
    warnings.push(
      "Skill names alone exceed the 1% listing budget. Claude Code still lists every name; descriptions in this estimate are dropped.",
    );
  }

  return {
    estimate: true,
    harness,
    contextTokens: options.context,
    budgetTokens: budget,
    budgetRule: budgetRule(harness, options.context, budget),
    tokenHeuristic: TOKEN_HEURISTIC,
    includeAgents: options.includeAgents ?? false,
    scannedDirs: [...(options.scannedDirs ?? [])],
    entries,
    skipped: [],
    suggestions,
    totals,
    withinBudget: totals.usedTokens <= budget,
    warnings,
  };
}

function prepare(item: CatalogItem, harness: Harness): Prepared {
  const description = oneLine(item.description);
  const whenToUse = item.whenToUse ? oneLine(item.whenToUse) : "";
  const original =
    harness === "claude" && whenToUse.length > 0 ? `${description} ${whenToUse}`.trim() : description;
  const cap = harness === "codex" ? CODEX_DESCRIPTION_CHAR_CAP : CLAUDE_DESCRIPTION_CHAR_CAP;
  const capped = capDescription(original, cap, harness === "codex");
  return { item, original, capped };
}

function capDescription(text: string, maxChars: number, ellipsis: boolean): string {
  const chars = codePoints(text);
  if (chars.length <= maxChars) return text;
  if (!ellipsis) return chars.slice(0, maxChars).join("");
  const keep = Math.max(0, maxChars - 3);
  return `${chars.slice(0, keep).join("")}...`;
}

function orderForHarness(rows: Prepared[], harness: Harness): Prepared[] {
  const copy = [...rows];
  copy.sort((left, right) => {
    if (harness === "codex") {
      const scope = scopeRank(left.item.scope) - scopeRank(right.item.scope);
      if (scope !== 0) return scope;
    } else if (left.item.kind !== right.item.kind) {
      return left.item.kind === "skill" ? -1 : 1;
    }
    if (left.item.name !== right.item.name) return left.item.name < right.item.name ? -1 : 1;
    if (left.item.path !== right.item.path) return left.item.path < right.item.path ? -1 : 1;
    return 0;
  });
  return copy;
}

function scopeRank(scope: CatalogItem["scope"]): number {
  switch (scope) {
    case "system":
      return 0;
    case "admin":
      return 1;
    case "repo":
      return 2;
    case "user":
      return 3;
    case "plugin":
      return 4;
    default:
      return 5;
  }
}

function allocateCodex(rows: Prepared[], budget: number): Allocation[] {
  if (rows.length === 0) return [];
  const fullCosts = rows.map((row) => lineCost(codexLine(row.item, row.capped)));
  if (sum(fullCosts) <= budget) {
    return rows.map((row) => ({ omitted: false, includedChars: codePointLength(row.capped) }));
  }

  const minimumCosts = rows.map((row) => lineCost(codexLine(row.item, "")));
  if (sum(minimumCosts) > budget) {
    let used = 0;
    const allocations: Allocation[] = [];
    for (const cost of minimumCosts) {
      if (used + cost <= budget) {
        used += cost;
        allocations.push({ omitted: false, includedChars: 0 });
      } else {
        allocations.push({ omitted: true, includedChars: 0 });
      }
    }
    return allocations;
  }

  const extras = rows.map((row) => descriptionExtraCosts(row));
  const charCounts = rows.map((row) => codePointLength(row.capped));
  const included = new Array<number>(rows.length).fill(0);
  const currentExtra = new Array<number>(rows.length).fill(0);
  let remaining = budget - sum(minimumCosts);
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < rows.length; index += 1) {
      const count = charCounts[index] ?? 0;
      const have = included[index] ?? 0;
      if (have >= count) continue;
      const costs = extras[index] ?? [];
      const nextCost = costs[have + 1] ?? 0;
      const delta = nextCost - (currentExtra[index] ?? 0);
      if (delta <= remaining) {
        included[index] = have + 1;
        currentExtra[index] = nextCost;
        remaining -= delta;
        changed = true;
      }
    }
  }
  return included.map((chars) => ({ omitted: false, includedChars: chars }));
}

function descriptionExtraCosts(row: Prepared): number[] {
  const minimum = codexLine(row.item, "");
  const minimumBytes = Buffer.byteLength(minimum, "utf8") + 1;
  const minimumCost = Math.ceil(minimumBytes / 4);
  const extra = [0];
  let prefixBytes = 0;
  for (const char of codePoints(row.capped)) {
    prefixBytes += Buffer.byteLength(char, "utf8");
    const renderedBytes = minimumBytes + prefixBytes + 1;
    extra.push(Math.max(0, Math.ceil(renderedBytes / 4) - minimumCost));
  }
  return extra;
}

function allocateClaude(rows: Prepared[], budget: number): Allocation[] {
  if (rows.length === 0) return [];
  const fullCosts = rows.map((row) => lineCost(claudeLine(row.item.name, row.capped)));
  const nameCosts = rows.map((row) => lineCost(claudeLine(row.item.name, "")));
  if (sum(fullCosts) <= budget) {
    return rows.map((row) => ({ omitted: false, includedChars: codePointLength(row.capped) }));
  }

  const include = rows.map((row) => row.capped.length > 0);
  let cost = sum(fullCosts);
  for (let index = rows.length - 1; index >= 0 && cost > budget; index -= 1) {
    if (!include[index]) continue;
    include[index] = false;
    cost -= fullCosts[index] ?? 0;
    cost += nameCosts[index] ?? 0;
  }
  return rows.map((row, index) => ({
    omitted: false,
    includedChars: include[index] ? codePointLength(row.capped) : 0,
  }));
}

function toEntry(row: Prepared, allocation: Allocation, harness: Harness): BudgetEntry {
  const includedText = allocation.omitted ? "" : sliceCodePoints(row.capped, allocation.includedChars);
  const line =
    harness === "codex"
      ? codexLine(row.item, includedText)
      : claudeLine(row.item.name, includedText);
  const asWritten =
    harness === "codex" ? codexLine(row.item, row.original) : claudeLine(row.item.name, row.original);
  const { status, reason } = classify(row, allocation, harness);
  return {
    name: row.item.name,
    kind: row.item.kind,
    scope: row.item.scope,
    sourceDir: row.item.sourceDir,
    path: row.item.path,
    estimatedTokens: lineCost(asWritten),
    includedTokens: allocation.omitted ? 0 : lineCost(line),
    descriptionChars: codePointLength(row.original),
    includedDescriptionChars: allocation.omitted ? 0 : codePointLength(includedText),
    status,
    reason,
  };
}

function classify(row: Prepared, allocation: Allocation, harness: Harness): { status: SkillStatus; reason: StatusReason } {
  const originalLen = codePointLength(row.original);
  const cappedLen = codePointLength(row.capped);
  if (allocation.omitted) return { status: "drop", reason: "omitted" };
  if (harness === "claude" && allocation.includedChars === 0 && originalLen > 0) {
    return { status: "drop", reason: "description-dropped" };
  }
  if (allocation.includedChars < originalLen) {
    if (allocation.includedChars === cappedLen && originalLen > cappedLen) {
      return { status: "truncate", reason: "hard-cap" };
    }
    return { status: "truncate", reason: "budget-truncated" };
  }
  return { status: "keep", reason: "fits" };
}

function summarize(entries: BudgetEntry[], budget: number): AnalyzeResult["totals"] {
  let keep = 0;
  let truncate = 0;
  let drop = 0;
  let fullTokens = 0;
  let usedTokens = 0;
  for (const entry of entries) {
    if (entry.status === "keep") keep += 1;
    else if (entry.status === "truncate") truncate += 1;
    else drop += 1;
    fullTokens += entry.estimatedTokens;
    usedTokens += entry.includedTokens;
  }
  return {
    entries: entries.length,
    keep,
    truncate,
    drop,
    fullTokens,
    usedTokens,
    budgetTokens: budget,
  };
}

function statusRank(status: BudgetEntry["status"]): number {
  if (status === "truncate") return 0;
  if (status === "drop") return 1;
  return 2;
}

function suggest(entries: BudgetEntry[], originals: string[]): TrimSuggestion[] {
  const ranked = entries.map((entry, index) => ({
    entry,
    descriptionTokens: estimateTokens(originals[index] ?? ""),
  }));
  ranked.sort((left, right) => {
    const tokens = right.descriptionTokens - left.descriptionTokens;
    if (tokens !== 0) return tokens;
    const status = statusRank(left.entry.status) - statusRank(right.entry.status);
    if (status !== 0) return status;
    if (left.entry.name !== right.entry.name) return left.entry.name < right.entry.name ? -1 : 1;
    return left.entry.path < right.entry.path ? -1 : left.entry.path > right.entry.path ? 1 : 0;
  });
  return ranked.slice(0, SUGGESTION_LIMIT).map(({ entry, descriptionTokens }) => ({
    name: entry.name,
    kind: entry.kind,
    sourceDir: entry.sourceDir,
    path: entry.path,
    descriptionChars: entry.descriptionChars,
    descriptionTokens,
    status: entry.status,
  }));
}

export function codexLine(item: Pick<CatalogItem, "name" | "path">, description: string): string {
  if (description.length === 0) return `- ${item.name}: (file: ${item.path})`;
  return `- ${item.name}: ${description} (file: ${item.path})`;
}

export function claudeLine(name: string, description: string): string {
  if (description.length === 0) return `- ${name}`;
  return `- ${name}: ${description}`;
}

function lineCost(line: string): number {
  return estimateTokens(`${line}\n`);
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
