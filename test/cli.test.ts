import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { analyze } from "../src/index.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-63");

function capture(): { io: { stdout: { write(chunk: string): void }; stderr: { write(chunk: string): void } }; out(): string; err(): string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

describe("codex 63-skill fixture", () => {
  it("truncates many skills and does not drop them at a 272k window", () => {
    const report = analyze({ harness: "codex", context: 272_000, dirs: [fixture], cwd: fixture });
    expect(report.entries).toHaveLength(63);
    expect(report.budgetTokens).toBe(5_440);
    expect(report.totals.drop).toBe(0);
    expect(report.totals.truncate).toBeGreaterThanOrEqual(50);
    expect(report.totals.keep + report.totals.truncate + report.totals.drop).toBe(63);
    expect(report.withinBudget).toBe(true);
    expect(report.totals.usedTokens).toBeLessThanOrEqual(report.budgetTokens);
    expect(report.suggestions[0]?.name).toBe("skill-63");
    expect(report.suggestions.every((suggestion) => suggestion.status === "truncate")).toBe(true);
    expect(report.estimate).toBe(true);
  });
});

describe("cli", () => {
  it("prints an estimate table and fails CI when descriptions are trimmed", () => {
    const capped = capture();
    const code = runCli(
      ["--harness", "codex", "--context", "272000", "--dir", fixture, "--ci"],
      capped.io,
    );
    expect(code).toBe(1);
    expect(capped.out()).toContain("ESTIMATE");
    expect(capped.out()).toContain("skill-01");
    expect(capped.out()).toContain("truncate");
    expect(capped.out()).toContain("Trim these descriptions first:");
    expect(capped.err()).toContain("CI: failed");

    const open = capture();
    expect(runCli(["--harness", "codex", "--context", "272000", "--dir", fixture], open.io)).toBe(0);
  });

  it("prints JSON and accepts repeated --dir flags", () => {
    const io = capture();
    const code = runCli(
      ["--harness=claude", "--context=200000", "--dir", fixture, "--dir", fixture, "--json"],
      io.io,
    );
    expect(code).toBe(0);
    const report = JSON.parse(io.out()) as { estimate: boolean; harness: string; entries: unknown[] };
    expect(report.estimate).toBe(true);
    expect(report.harness).toBe("claude");
    expect(report.entries).toHaveLength(63);
  });

  it("exits 2 on usage errors and prints help", () => {
    const missing = capture();
    expect(runCli(["--harness", "codex"], missing.io)).toBe(2);
    expect(missing.err()).toContain("--context");

    const help = capture();
    expect(runCli(["--help"], help.io)).toBe(0);
    expect(help.out()).toContain("--include-agents");
    expect(help.out()).toContain("--ci");
    expect(help.out()).toContain("--json");
  });
});
