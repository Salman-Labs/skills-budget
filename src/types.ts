export type Harness = "codex" | "claude";

export type SkillStatus = "keep" | "truncate" | "drop";

export type SkillKind = "skill" | "agent";

export type SkillScope = "system" | "admin" | "repo" | "user" | "plugin" | "custom";

export type StatusReason =
  | "fits"
  | "hard-cap"
  | "budget-truncated"
  | "description-dropped"
  | "omitted";

export interface AnalyzeOptions {
  harness: Harness;
  /** Model context window in tokens. */
  context: number;
  /**
   * Skill roots to scan. When omitted, the harness default directories are used.
   * An explicit list replaces those defaults.
   */
  dirs?: readonly string[];
  /**
   * Claude Code only. Also read subagent markdown under `.claude/agents`,
   * `~/.claude/agents`, and `agents/` folders inside the scanned roots.
   * Those entries share the skill-listing budget in this estimate.
   */
  includeAgents?: boolean;
  cwd?: string;
  home?: string;
  /** Defaults to `CODEX_HOME` or `~/.codex`. */
  codexHome?: string;
}

export interface CatalogItem {
  name: string;
  description: string;
  whenToUse?: string;
  sourceDir: string;
  path: string;
  kind: SkillKind;
  scope: SkillScope;
}

export interface BudgetEntry {
  name: string;
  kind: SkillKind;
  scope: SkillScope;
  sourceDir: string;
  path: string;
  /** Listing-line tokens with the description as written, before caps. */
  estimatedTokens: number;
  /** Listing-line tokens actually charged after caps and budget allocation. */
  includedTokens: number;
  descriptionChars: number;
  includedDescriptionChars: number;
  status: SkillStatus;
  reason: StatusReason;
}

export interface TrimSuggestion {
  name: string;
  kind: SkillKind;
  sourceDir: string;
  path: string;
  descriptionChars: number;
  descriptionTokens: number;
  status: SkillStatus;
}

export interface SkippedSkill {
  path: string;
  name?: string;
  reason: string;
}

export interface AnalyzeTotals {
  entries: number;
  keep: number;
  truncate: number;
  drop: number;
  fullTokens: number;
  usedTokens: number;
  budgetTokens: number;
}

export interface AnalyzeResult {
  estimate: true;
  harness: Harness;
  contextTokens: number;
  budgetTokens: number;
  budgetRule: string;
  tokenHeuristic: "ceil(utf8Bytes/4)";
  includeAgents: boolean;
  scannedDirs: string[];
  entries: BudgetEntry[];
  skipped: SkippedSkill[];
  suggestions: TrimSuggestion[];
  totals: AnalyzeTotals;
  withinBudget: boolean;
  warnings: string[];
}

export class SkillsBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsBudgetError";
  }
}
