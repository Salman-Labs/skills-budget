#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.js";
import { formatReport } from "./format.js";
import type { Harness } from "./types.js";
import { SkillsBudgetError } from "./types.js";

interface Io {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

interface ParsedArgs {
  harness?: Harness;
  context?: number;
  dirs: string[];
  includeAgents: boolean;
  json: boolean;
  ci: boolean;
  help: boolean;
  version: boolean;
}

export function runCli(argv: readonly string[], io?: Io): number {
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    stderr.write("Run skills-budget --help for usage.\n");
    return 2;
  }

  if (parsed.help) {
    stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (parsed.version) {
    stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (!parsed.harness) {
    stderr.write("Missing required flag --harness codex|claude\n");
    return 2;
  }
  if (parsed.context === undefined) {
    stderr.write("Missing required flag --context <tokens>\n");
    return 2;
  }

  try {
    const report = analyze({
      harness: parsed.harness,
      context: parsed.context,
      ...(parsed.dirs.length > 0 ? { dirs: parsed.dirs } : {}),
      includeAgents: parsed.includeAgents,
    });
    if (parsed.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else stdout.write(formatReport(report, { version: readVersion() }));
    const pressure = report.totals.truncate + report.totals.drop > 0;
    if (parsed.ci && pressure) {
      stderr.write(
        `CI: failed because ${report.totals.truncate} truncated and ${report.totals.drop} dropped.\n`,
      );
      return 1;
    }
    return 0;
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return error instanceof SkillsBudgetError ? 2 : 1;
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dirs: [],
    includeAgents: false,
    json: false,
    ci: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--version" || token === "-v") {
      parsed.version = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--ci") {
      parsed.ci = true;
      continue;
    }
    if (token === "--include-agents") {
      parsed.includeAgents = true;
      continue;
    }
    const inline = splitInline(token);
    if (inline) {
      applyValue(parsed, inline.flag, inline.value);
      continue;
    }
    if (token === "--harness" || token === "--context" || token === "--dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SkillsBudgetError(`Missing value for ${token}`);
      }
      applyValue(parsed, token, value);
      index += 1;
      continue;
    }
    throw new SkillsBudgetError(`Unknown argument: ${token}`);
  }
  return parsed;
}

function splitInline(token: string): { flag: "--harness" | "--context" | "--dir"; value: string } | undefined {
  const match = /^(--harness|--context|--dir)=(.*)$/.exec(token);
  if (!match) return undefined;
  const flag = match[1];
  const value = match[2];
  if (flag !== "--harness" && flag !== "--context" && flag !== "--dir") return undefined;
  if (!value) throw new SkillsBudgetError(`Missing value for ${flag}`);
  return { flag, value };
}

function applyValue(parsed: ParsedArgs, flag: "--harness" | "--context" | "--dir", value: string): void {
  if (flag === "--dir") {
    parsed.dirs.push(value);
    return;
  }
  if (flag === "--harness") {
    if (value !== "codex" && value !== "claude") {
      throw new SkillsBudgetError("--harness must be codex or claude");
    }
    parsed.harness = value;
    return;
  }
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new SkillsBudgetError("--context must be a positive integer number of tokens");
  }
  parsed.context = Number(value);
}

function helpText(): string {
  return [
    "Usage: skills-budget --harness <codex|claude> --context <tokens> [options]",
    "",
    "Estimate whether skill names and descriptions fit the hidden listing budget.",
    "Results are ESTIMATES based on documented Codex and Claude Code rules.",
    "",
    "Options:",
    "  --harness <codex|claude>   Which listing rules to apply",
    "  --context <tokens>         Model context window, in tokens",
    "  --dir <path>               Skill root to scan (repeatable; replaces defaults)",
    "  --include-agents           Claude only: charge .claude/agents and ~/.claude/agents",
    "                             against the same 1% budget",
    "  --json                     Print the machine-readable report",
    "  --ci                       Exit 1 if any skill is truncated or dropped",
    "  -h, --help                 Show this help",
    "  -v, --version              Print the version",
  ].join("\n");
}

function readVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string };
    return parsed.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entry = process.argv[1];
if (entry && sameFile(entry, fileURLToPath(import.meta.url))) {
  process.exit(runCli(process.argv.slice(2)));
}

function sameFile(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}
