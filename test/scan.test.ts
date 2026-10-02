import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyze, defaultScanDirs } from "../src/index.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-budget-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe("default scan directories", () => {
  it("follows the documented Codex and Claude roots and stops at the git root", () => {
    const home = tempDir();
    const project = tempDir();
    fs.mkdirSync(path.join(project, ".git"));
    const nested = path.join(project, "nested");
    for (const dir of [
      path.join(home, ".codex", "skills"),
      path.join(home, ".agents", "skills"),
      path.join(home, ".codex", "plugins"),
      path.join(home, ".claude", "skills"),
      path.join(home, ".claude", "agents"),
      path.join(home, ".claude", "plugins", "cache"),
      path.join(project, ".agents", "skills"),
      path.join(project, ".codex", "skills"),
      path.join(project, ".claude", "skills"),
      path.join(project, ".claude", "agents"),
      path.join(nested, ".claude", "skills"),
      path.join(nested, ".agents", "skills"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const codex = defaultScanDirs({ harness: "codex", cwd: project, home, codexHome: path.join(home, ".codex") });
    expect(codex).toEqual(
      expect.arrayContaining([
        path.join(home, ".codex", "skills"),
        path.join(home, ".agents", "skills"),
        path.join(home, ".codex", "plugins"),
        path.join(project, ".agents", "skills"),
        path.join(project, ".codex", "skills"),
      ]),
    );
    expect(codex.some((dir) => dir.includes(`${path.sep}nested${path.sep}`))).toBe(false);

    const claude = defaultScanDirs({
      harness: "claude",
      cwd: nested,
      home,
      includeAgents: true,
    });
    expect(claude).toEqual(
      expect.arrayContaining([
        path.join(home, ".claude", "skills"),
        path.join(home, ".claude", "plugins", "cache"),
        path.join(home, ".claude", "agents"),
        path.join(project, ".claude", "skills"),
        path.join(nested, ".claude", "skills"),
        path.join(project, ".claude", "agents"),
      ]),
    );
    const skillsOnly = defaultScanDirs({ harness: "claude", cwd: project, home, includeAgents: false });
    expect(skillsOnly.some((dir) => dir.endsWith(`${path.sep}agents`))).toBe(false);
  });
});

describe("analyze", () => {
  it("does not apply the Claude agent roster to Codex", () => {
    const root = tempDir();
    const report = analyze({
      harness: "codex",
      context: 1_000,
      dirs: [root],
      includeAgents: true,
      home: tempDir(),
      cwd: root,
    });
    expect(report.includeAgents).toBe(false);
    expect(report.warnings.join(" ")).toContain("includeAgents");
  });
});

describe("SKILL.md parsing", () => {
  it("reads quoted, folded, and literal descriptions", () => {
    const root = tempDir();
    write(
      path.join(root, "quoted", "SKILL.md"),
      `---\nname: quoted\ndescription: "Use when the user says \\"ship it\\"."\n---\n\nBody\n`,
    );
    write(
      path.join(root, "folded", "SKILL.md"),
      "---\nname: folded\ndescription: >\n  hello\n  world\n---\n",
    );
    write(
      path.join(root, "literal", "SKILL.md"),
      "---\nname: literal\ndescription: |\n  line one\n  line two\n---\n",
    );
    write(path.join(root, "broken", "SKILL.md"), "no frontmatter here\n");

    const report = analyze({ harness: "codex", context: 272_000, dirs: [root], home: tempDir(), cwd: root });
    const byName = Object.fromEntries(report.entries.map((entry) => [entry.name, entry.descriptionChars]));
    expect(byName.quoted).toBe("Use when the user says \"ship it\".".length);
    expect(byName.folded).toBe("hello world".length);
    expect(byName.literal).toBe("line one line two".length);
    expect(report.skipped.map((skip) => path.basename(path.dirname(skip.path)))).toContain("broken");
  });

  it("leaves disable-model-invocation skills out of the Claude listing only", () => {
    const root = tempDir();
    write(
      path.join(root, "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: Deploy the application.\ndisable-model-invocation: true\n---\n",
    );
    write(
      path.join(root, "visible", "SKILL.md"),
      "---\nname: visible\ndescription: Review a diff.\n---\n",
    );
    const claude = analyze({ harness: "claude", context: 200_000, dirs: [root], home: tempDir(), cwd: root });
    expect(claude.entries.map((entry) => entry.name)).toEqual(["visible"]);
    expect(claude.skipped[0]?.name).toBe("hidden");

    const codex = analyze({ harness: "codex", context: 200_000, dirs: [root], home: tempDir(), cwd: root });
    expect(codex.entries.map((entry) => entry.name).sort()).toEqual(["hidden", "visible"]);
  });

  it("counts Claude agents only when includeAgents is set", () => {
    const root = tempDir();
    write(
      path.join(root, ".claude", "skills", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: Review short diffs.\n---\n",
    );
    write(
      path.join(root, ".claude", "agents", "reviewer.md"),
      `---\nname: reviewer\ndescription: ${"r".repeat(800)}\n---\n`,
    );
    const home = tempDir();
    const without = analyze({
      harness: "claude",
      context: 2_000,
      dirs: [root],
      home,
      cwd: root,
    });
    expect(without.entries.map((entry) => entry.name)).toEqual(["alpha"]);

    const withAgents = analyze({
      harness: "claude",
      context: 2_000,
      dirs: [root],
      includeAgents: true,
      home,
      cwd: root,
    });
    expect(withAgents.entries.map((entry) => entry.kind).sort()).toEqual(["agent", "skill"]);
    expect(withAgents.entries.find((entry) => entry.name === "reviewer")?.status).toBe("drop");
    expect(withAgents.entries.find((entry) => entry.name === "alpha")?.status).toBe("keep");
  });
});
