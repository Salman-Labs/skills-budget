import { describe, expect, it } from "vitest";
import {
  applyBudget,
  claudeBudgetTokens,
  CLAUDE_DESCRIPTION_CHAR_CAP,
  codexBudgetTokens,
  CODEX_DESCRIPTION_CHAR_CAP,
  estimateTokens,
} from "../src/index.js";
import type { CatalogItem } from "../src/index.js";

function item(overrides: Partial<CatalogItem> & Pick<CatalogItem, "name" | "description">): CatalogItem {
  return {
    sourceDir: "/skills",
    path: `/skills/${overrides.name}/SKILL.md`,
    kind: "skill",
    scope: "custom",
    ...overrides,
  };
}

describe("token heuristic", () => {
  it("rounds UTF-8 bytes up to a multiple of 4", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("💡")).toBe(1);
    expect(estimateTokens("💡💡")).toBe(2);
  });
});

describe("budget formulas", () => {
  it("uses 2% of a known Codex window and does not clamp at 8000 tokens", () => {
    expect(codexBudgetTokens(272_000)).toBe(5_440);
    expect(codexBudgetTokens(100_000)).toBe(2_000);
    expect(codexBudgetTokens(400_000)).toBe(8_000);
    expect(codexBudgetTokens(1_000_000)).toBe(20_000);
    expect(codexBudgetTokens(1)).toBe(1);
  });

  it("uses 1% of the Claude context window", () => {
    expect(claudeBudgetTokens(200_000)).toBe(2_000);
    expect(claudeBudgetTokens(272_000)).toBe(2_720);
    expect(claudeBudgetTokens(1_000_000)).toBe(10_000);
    expect(claudeBudgetTokens(1)).toBe(1);
  });
});

describe("codex allocation", () => {
  it("keeps every skill when the full listing fits", () => {
    const report = applyBudget(
      [item({ name: "alpha", description: "Short routing text." }), item({ name: "beta", description: "Also short." })],
      { harness: "codex", context: 272_000 },
    );
    expect(report.estimate).toBe(true);
    expect(report.entries.every((entry) => entry.status === "keep")).toBe(true);
    expect(report.withinBudget).toBe(true);
    expect(report.totals.usedTokens).toBeLessThanOrEqual(report.budgetTokens);
  });

  it("truncates many descriptions before it drops skills", () => {
    const skills = Array.from({ length: 30 }, (_, index) =>
      item({
        name: `skill-${String(index).padStart(2, "0")}`,
        description: "x".repeat(2_000),
      }),
    );
    const report = applyBudget(skills, { harness: "codex", context: 272_000 });
    expect(report.budgetTokens).toBe(5_440);
    expect(report.totals.drop).toBe(0);
    expect(report.totals.truncate).toBe(30);
    expect(report.withinBudget).toBe(true);
    expect(report.totals.usedTokens).toBeLessThanOrEqual(report.budgetTokens);
    const included = report.entries.map((entry) => entry.includedDescriptionChars);
    const max = Math.max(...included);
    const min = Math.min(...included);
    // Round-robin spends one character at a time, and a token is 4 bytes.
    // The skill that buys the last token can still absorb the free bytes inside it.
    expect(max - min).toBeLessThanOrEqual(4);
  });

  it("drops skills that do not fit even as name-only lines", () => {
    const skills = Array.from({ length: 10 }, (_, index) =>
      item({
        name: `skill-${String(index).padStart(2, "0")}`,
        description: "y".repeat(200),
        path: `/very/long/path/segment/${"p".repeat(40)}/skill-${index}/SKILL.md`,
      }),
    );
    const report = applyBudget(skills, { harness: "codex", context: 50 });
    expect(report.budgetTokens).toBe(1);
    expect(report.totals.drop).toBe(10);
    expect(report.totals.usedTokens).toBe(0);
    expect(report.entries.every((entry) => entry.reason === "omitted")).toBe(true);
  });

  it("caps a description at 1024 characters before charging the budget", () => {
    const report = applyBudget([item({ name: "long", description: "z".repeat(2_000) })], {
      harness: "codex",
      context: 1_000_000,
    });
    const entry = report.entries[0];
    expect(entry?.status).toBe("truncate");
    expect(entry?.reason).toBe("hard-cap");
    expect(entry?.includedDescriptionChars).toBe(CODEX_DESCRIPTION_CHAR_CAP);
    expect(entry?.descriptionChars).toBe(2_000);
  });
});

describe("claude allocation", () => {
  it("drops later descriptions and always keeps names", () => {
    const skills = ["alpha", "beta", "gamma", "delta"].map((name) =>
      item({ name, description: "d".repeat(400) }),
    );
    const report = applyBudget(skills, { harness: "claude", context: 25_000 });
    expect(report.budgetTokens).toBe(250);
    expect(report.entries).toHaveLength(4);
    expect(report.entries.every((entry) => entry.reason !== "omitted")).toBe(true);
    expect(report.entries.at(-1)?.status).toBe("drop");
    expect(report.entries.at(-1)?.reason).toBe("description-dropped");
    const dropped = report.entries.filter((entry) => entry.status === "drop").map((entry) => entry.name);
    expect(dropped).toContain("delta");
    expect(dropped).not.toContain("alpha");
  });

  it("caps description plus when_to_use at 1536 characters", () => {
    const report = applyBudget(
      [
        item({
          name: "wide",
          description: "w".repeat(1_500),
          whenToUse: "u".repeat(200),
        }),
      ],
      { harness: "claude", context: 1_000_000 },
    );
    const entry = report.entries[0];
    expect(entry?.status).toBe("truncate");
    expect(entry?.reason).toBe("hard-cap");
    expect(entry?.descriptionChars).toBe(1_701);
    expect(entry?.includedDescriptionChars).toBe(CLAUDE_DESCRIPTION_CHAR_CAP);
  });

  it("charges agents after skills so agent descriptions drop first", () => {
    const report = applyBudget(
      [
        item({ name: "alpha", description: "Review short diffs." }),
        item({ name: "zeta", description: "Write release notes." }),
        item({
          name: "reviewer",
          description: "r".repeat(800),
          kind: "agent",
          path: "/repo/.claude/agents/reviewer.md",
          sourceDir: "/repo/.claude/agents",
        }),
      ],
      { harness: "claude", context: 2_000, includeAgents: true },
    );
    expect(report.budgetTokens).toBe(20);
    const byName = Object.fromEntries(report.entries.map((entry) => [entry.name, entry.status]));
    expect(byName.alpha).toBe("keep");
    expect(byName.zeta).toBe("keep");
    expect(byName.reviewer).toBe("drop");
    expect(report.totals.usedTokens).toBeLessThanOrEqual(report.budgetTokens);
  });
});
