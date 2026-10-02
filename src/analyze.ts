import os from "node:os";
import path from "node:path";
import { applyBudget, assertContext, assertHarness } from "./budget.js";
import { defaultScanDirs, scanCatalog } from "./scan.js";
import type { AnalyzeOptions, AnalyzeResult } from "./types.js";

export function analyze(options: AnalyzeOptions): AnalyzeResult {
  assertHarness(options.harness);
  assertContext(options.context);
  const home = path.resolve(options.home ?? os.homedir());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const codexHome = path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, ".codex"));
  const includeAgents = options.includeAgents ?? false;
  const warnings: string[] = [];
  if (includeAgents && options.harness === "codex") {
    warnings.push(
      "Ignoring includeAgents for Codex. The subagent roster is a Claude Code listing (anthropics/claude-code#87515).",
    );
  }
  const scanAgents = includeAgents && options.harness === "claude";
  const dirs = options.dirs
    ? options.dirs.map((dir) => path.resolve(cwd, dir))
    : defaultScanDirs({
        harness: options.harness,
        cwd,
        home,
        codexHome,
        includeAgents: scanAgents,
      });

  const scanned = scanCatalog({
    harness: options.harness,
    dirs,
    includeAgents: scanAgents,
    home,
    codexHome,
  });
  const result = applyBudget(scanned.items, {
    harness: options.harness,
    context: options.context,
    includeAgents: scanAgents,
    warnings: [...warnings, ...scanned.warnings],
    scannedDirs: scanned.scannedDirs,
  });
  return {
    ...result,
    skipped: scanned.skipped,
  };
}
