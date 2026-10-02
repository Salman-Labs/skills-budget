import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { CatalogItem, Harness, SkillKind, SkillScope, SkippedSkill } from "./types.js";
import { oneLine } from "./tokens.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".hg"]);
const MAX_DEPTH = 12;

export interface ScanOptions {
  harness: Harness;
  dirs: readonly string[];
  includeAgents: boolean;
  home: string;
  codexHome: string;
}

export interface ScanResult {
  items: CatalogItem[];
  skipped: SkippedSkill[];
  warnings: string[];
  scannedDirs: string[];
}

export function defaultScanDirs(options: {
  harness: Harness;
  cwd: string;
  home: string;
  codexHome?: string;
  includeAgents?: boolean;
}): string[] {
  const cwd = path.resolve(options.cwd);
  const home = path.resolve(options.home);
  const codexHome = path.resolve(options.codexHome ?? path.join(home, ".codex"));
  const chain = directoriesUpToGitRoot(cwd);
  const candidates: string[] = [];

  if (options.harness === "codex") {
    candidates.push(
      path.join(codexHome, "skills"),
      path.join(home, ".agents", "skills"),
      path.join(codexHome, "plugins"),
      "/etc/codex/skills",
    );
    for (const dir of chain) {
      candidates.push(path.join(dir, ".agents", "skills"), path.join(dir, ".codex", "skills"));
    }
  } else {
    candidates.push(path.join(home, ".claude", "skills"), path.join(home, ".claude", "plugins", "cache"));
    for (const dir of chain) {
      candidates.push(path.join(dir, ".claude", "skills"));
    }
    if (options.includeAgents) {
      candidates.push(path.join(home, ".claude", "agents"));
      for (const dir of chain) candidates.push(path.join(dir, ".claude", "agents"));
    }
  }

  return dedupeExisting(candidates);
}

export function scanCatalog(options: ScanOptions): ScanResult {
  const items: CatalogItem[] = [];
  const skipped: SkippedSkill[] = [];
  const warnings: string[] = [];
  const scannedDirs: string[] = [];
  const seenFiles = new Set<string>();

  for (const dir of options.dirs) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
      warnings.push(`Scan directory does not exist: ${resolved}`);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch (error) {
      warnings.push(`Cannot read ${resolved}: ${errorMessage(error)}`);
      continue;
    }
    if (!stat.isDirectory()) {
      warnings.push(`Scan path is not a directory: ${resolved}`);
      continue;
    }
    scannedDirs.push(resolved);
    const rootIsAgents = path.basename(resolved) === "agents";
    walk(resolved, (file) => {
      let real = file;
      try {
        real = fs.realpathSync(file);
      } catch {
        return;
      }
      if (seenFiles.has(real)) return;
      const kind = classifyFile(file, rootIsAgents, options.includeAgents);
      if (!kind) return;
      seenFiles.add(real);
      const loaded = loadEntry(file, resolved, kind, options);
      if (loaded.skip) {
        skipped.push(loaded.skip);
        return;
      }
      if (loaded.warning) warnings.push(loaded.warning);
      if (loaded.item) items.push(loaded.item);
    });
  }

  return { items, skipped, warnings, scannedDirs };
}

function classifyFile(file: string, rootIsAgents: boolean, includeAgents: boolean): SkillKind | undefined {
  const base = path.basename(file);
  if (base === "SKILL.md") return "skill";
  if (!includeAgents || !base.endsWith(".md")) return undefined;
  if (rootIsAgents) return "agent";
  const parts = file.split(path.sep);
  if (parts.includes("agents")) return "agent";
  return undefined;
}

function loadEntry(
  file: string,
  root: string,
  kind: SkillKind,
  options: ScanOptions,
): { item?: CatalogItem; skip?: SkippedSkill; warning?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { warning: `Cannot read ${file}: ${errorMessage(error)}` };
  }
  const frontmatter = parseFrontmatter(raw);
  if (!frontmatter) {
    if (kind === "skill") {
      return { skip: { path: file, reason: "missing YAML frontmatter" } };
    }
    return {};
  }
  if (options.harness === "claude" && frontmatter.disableModelInvocation) {
    return {
      skip: {
        path: file,
        ...(frontmatter.name ? { name: oneLine(frontmatter.name) } : {}),
        reason: "disable-model-invocation removes the description from Claude's listing",
      },
    };
  }
  const name = oneLine(frontmatter.name ?? defaultName(file, kind));
  const description = frontmatter.description ? oneLine(frontmatter.description) : "";
  if (!name) {
    return { skip: { path: file, reason: "missing name" } };
  }
  if (!description && kind === "skill") {
    return { skip: { path: file, name, reason: "missing description" } };
  }
  return {
    item: {
      name,
      description,
      ...(frontmatter.whenToUse ? { whenToUse: oneLine(frontmatter.whenToUse) } : {}),
      sourceDir: root,
      path: file,
      kind,
      scope: scopeFor(file, options),
    },
  };
}

function defaultName(file: string, kind: SkillKind): string {
  if (kind === "skill") return path.basename(path.dirname(file));
  return path.basename(file, ".md");
}

function isInside(file: string, root: string): boolean {
  const left = path.resolve(file).split(path.sep).join("/");
  const right = path.resolve(root).split(path.sep).join("/");
  return left === right || left.startsWith(`${right}/`);
}

function scopeFor(file: string, options: ScanOptions): SkillScope {
  const normalized = path.resolve(file).split(path.sep).join("/");
  if (normalized.includes("/.system/") || normalized.endsWith("/.system")) return "system";
  if (normalized === "/etc/codex/skills" || normalized.startsWith("/etc/codex/skills/")) return "admin";
  if (normalized.includes("/.codex/plugins/") || normalized.includes("/.claude/plugins/")) return "plugin";
  const home = path.resolve(options.home);
  const codexHome = path.resolve(options.codexHome);
  const userRoots = [
    path.join(codexHome, "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".claude", "agents"),
  ];
  if (userRoots.some((root) => isInside(file, root))) return "user";
  if (
    normalized.includes("/.agents/skills/") ||
    normalized.includes("/.codex/skills/") ||
    normalized.includes("/.claude/skills/") ||
    normalized.includes("/.claude/agents/")
  ) {
    return "repo";
  }
  return "custom";
}

function walk(dir: string, visit: (file: string) => void, seen = new Set<string>(), depth = 0): void {
  if (depth > MAX_DEPTH) return;
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (real === path.parse(real).root || seen.has(real)) return;
  seen.add(real);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, visit, seen, depth + 1);
    else if (stat.isFile()) visit(full);
  }
}

function directoriesUpToGitRoot(cwd: string): string[] {
  const chain: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    chain.push(current);
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function dedupeExisting(candidates: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
