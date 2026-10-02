import os from "node:os";
import path from "node:path";
import type { AnalyzeResult, BudgetEntry } from "./types.js";

export function formatReport(
  report: AnalyzeResult,
  options?: { cwd?: string; home?: string; version?: string },
): string {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.home ?? os.homedir();
  const version = options?.version ?? "0.1.0";
  const lines: string[] = [];
  lines.push(`skills-budget ${version} — ESTIMATE`);
  lines.push(
    "These figures follow each tool's documented listing rules. They are not a live trace of a Codex or Claude Code session.",
  );
  lines.push(`Harness: ${report.harness}`);
  lines.push(`Context: ${report.contextTokens} tokens`);
  lines.push(`Budget: ${report.budgetTokens} tokens`);
  lines.push(`Rule: ${report.budgetRule}`);
  lines.push(`Token heuristic: ${report.tokenHeuristic} (ASCII descriptions are chars/4, rounded up).`);
  if (report.scannedDirs.length === 0) {
    lines.push("Scanned: (none)");
  } else {
    lines.push(`Scanned ${report.scannedDirs.length} ${report.scannedDirs.length === 1 ? "directory" : "directories"}:`);
    for (const dir of report.scannedDirs) lines.push(`  ${displayPath(dir, cwd, home)}`);
  }
  lines.push("");

  if (report.entries.length === 0) {
    lines.push("No skills found.");
  } else {
    lines.push(...renderTable(report.entries, cwd, home));
    lines.push("");
    lines.push(statusLegend(report.harness));
  }

  const { totals } = report;
  lines.push("");
  lines.push(
    `Totals: ${totals.entries} ${totals.entries === 1 ? "entry" : "entries"} · keep ${totals.keep} · truncate ${totals.truncate} · drop ${totals.drop}`,
  );
  const pct = totals.budgetTokens === 0 ? 0 : (totals.usedTokens / totals.budgetTokens) * 100;
  lines.push(
    `Full catalog (as written): ${totals.fullTokens} tokens · sent ${totals.usedTokens} / ${totals.budgetTokens} budget tokens (${pct.toFixed(1)}%)`,
  );
  if (!report.withinBudget) {
    lines.push("The name-only listing still exceeds the budget. Claude keeps the names anyway.");
  }

  lines.push("");
  lines.push(...renderSuggestions(report));

  if (report.skipped.length > 0) {
    lines.push("");
    lines.push("Not counted:");
    for (const skipped of report.skipped) {
      const name = skipped.name ? `${skipped.name} — ` : "";
      lines.push(`  ${name}${skipped.reason} (${displayPath(skipped.path, cwd, home)})`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("");
    for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderTable(entries: BudgetEntry[], cwd: string, home: string): string[] {
  const header = ["NAME", "SOURCE", "EST. TOKENS", "STATUS"];
  const rows = entries.map((entry) => [
    entry.name,
    displayPath(entry.sourceDir, cwd, home),
    String(entry.estimatedTokens),
    entry.status,
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, index) =>
        index === cells.length - 1
          ? cell
          : pad(cell, widths[index] ?? cell.length, index === 2 ? "right" : "left"),
      )
      .join("  ");
  return [render(header), ...rows.map((row) => render(row)), "", "EST. TOKENS is the listing line as written, before per-skill caps and budget trimming."];
}

function renderSuggestions(report: AnalyzeResult): string[] {
  if (report.suggestions.length === 0) return ["No descriptions to trim."];
  const pressure = report.totals.truncate + report.totals.drop > 0;
  const title = pressure
    ? "Trim these descriptions first:"
    : "Largest descriptions (catalog currently fits):";
  const lines = [title];
  report.suggestions.forEach((suggestion, index) => {
    lines.push(
      `  ${index + 1}. ${suggestion.name}  ${suggestion.descriptionTokens} description tokens  ${suggestion.descriptionChars} chars  ${suggestion.status}`,
    );
  });
  return lines;
}

function statusLegend(harness: AnalyzeResult["harness"]): string {
  if (harness === "codex") {
    return "Status: keep = full description listed; truncate = description shortened (1024-char cap and/or round-robin); drop = skill omitted from the model-visible list.";
  }
  return "Status: keep = full description listed; truncate = cut to 1536 characters; drop = name kept, description removed. Without usage history, later names and agents lose descriptions first.";
}

function displayPath(filePath: string, cwd: string, home: string): string {
  const resolved = path.resolve(filePath);
  const homeResolved = path.resolve(home);
  if (resolved === homeResolved || resolved.startsWith(homeResolved + path.sep)) {
    return `~${resolved.slice(homeResolved.length)}`;
  }
  const relative = path.relative(cwd, resolved);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return resolved;
}

function pad(value: string, width: number, align: "left" | "right"): string {
  if (value.length >= width) return value;
  const gap = " ".repeat(width - value.length);
  return align === "left" ? value + gap : gap + value;
}
