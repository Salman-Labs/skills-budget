# skills-budget

Estimate whether a Codex or Claude Code skill catalog fits the hidden listing budget.

Both tools inject skill **names and descriptions** into the model context so the model can choose a skill. The `SKILL.md` body stays on disk until a skill is selected. When the catalog is large, descriptions are shortened or skills disappear from that listing, and the model is not told which ones. This CLI shows, per skill, whether the estimate is **keep**, **truncate**, or **drop**.

These figures are **estimates** of each product's documented rules. They are not a trace of a live Codex or Claude Code session.

## Install

Requires Node.js 18 or newer.

```bash
npm install --save-dev skills-budget
npx skills-budget --harness codex --context 272000
```

Or install the command globally:

```bash
npm install -g skills-budget
skills-budget --harness claude --context 200000 --include-agents
```

Library:

```ts
import { analyze } from "skills-budget";

const report = analyze({
  harness: "codex",
  context: 272_000,
  dirs: [".agents/skills"],
});

console.log(report.totals);
```

`analyze` is synchronous. Pass `dirs` to replace the default scan roots. Pass `includeAgents: true` for the Claude Code subagent roster.

## Usage

```bash
skills-budget --harness <codex|claude> --context <tokens> [options]
```

| Flag | Meaning |
| --- | --- |
| `--harness codex\|claude` | Which listing rules to apply. |
| `--context <tokens>` | Model context window, in tokens. Example: `272000`. |
| `--dir <path>` | Skill root to scan. Repeatable. Replaces the default directories. |
| `--include-agents` | Claude only. Also read `.claude/agents` and `~/.claude/agents`, and charge them against the same 1% budget. |
| `--json` | Print the report as JSON (`estimate` is always `true`). |
| `--ci` | Exit 1 if any entry is truncated or dropped. Exit 0 when the catalog fits. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Print `0.1.0`. |

Exit codes: `0` success, `1` `--ci` found truncation or drops, `2` usage error.

## Sample output

`npx skills-budget --harness codex --context 272000 --dir test/fixtures/codex-63`

The fixture is 63 skills. Sixty-two descriptions are 400 characters and `skill-63` is 900. At a 272,000-token window the Codex budget is 5,440 tokens, every skill is kept in the list, and every description is shortened. Rows `skill-06` through `skill-62` are omitted below; the command prints all 63.

```text
skills-budget 0.1.0 — ESTIMATE
These figures follow each tool's documented listing rules. They are not a live trace of a Codex or Claude Code session.
Harness: codex
Context: 272000 tokens
Budget: 5440 tokens
Rule: floor(272000 * 2 / 100) = 5440 tokens. Codex uses 2% of a known context window (skill_metadata_budget in codex-rs/ext/skills/src/render.rs). The 8000-character constant is only the fallback when the window is unknown; current source does not clamp this token budget at 8000.
Token heuristic: ceil(utf8Bytes/4) (ASCII descriptions are chars/4, rounded up).
Scanned 1 directory:
  test/fixtures/codex-63

NAME      SOURCE                  EST. TOKENS  STATUS
skill-01  test/fixtures/codex-63          119  truncate
skill-02  test/fixtures/codex-63          119  truncate
skill-03  test/fixtures/codex-63          119  truncate
skill-04  test/fixtures/codex-63          119  truncate
skill-05  test/fixtures/codex-63          119  truncate
skill-63  test/fixtures/codex-63          244  truncate

Totals: 63 entries · keep 0 · truncate 63 · drop 0
Full catalog (as written): 7622 tokens · sent 5440 / 5440 budget tokens (100.0%)

Trim these descriptions first:
  1. skill-63  225 description tokens  900 chars  truncate
  2. skill-01  100 description tokens  400 chars  truncate
  3. skill-02  100 description tokens  400 chars  truncate
  4. skill-03  100 description tokens  400 chars  truncate
  5. skill-04  100 description tokens  400 chars  truncate
```

`EST. TOKENS` is the listing line with the description as written, before per-skill caps and budget trimming. The same fixture under Claude (`--harness claude --context 200000`) keeps 17 descriptions and drops 46, because Claude removes whole descriptions instead of sharing the leftover characters.

## How the estimates work

Tokens are `ceil(utf8Bytes / 4)`. For ASCII text that is the usual chars/4 heuristic, rounded up. Codex uses the same byte rule (`APPROX_BYTES_PER_TOKEN = 4` in `render.rs`). This is not a model tokenizer.

Whitespace in `name` and `description` is collapsed to one line before costing, which is what a one-line listing injection does.

### Codex

Checked against current `main`:

- Budget function: [`skill_metadata_budget`](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/render.rs) in `codex-rs/ext/skills/src/render.rs`.
- Public docs: [Agent skills](https://developers.openai.com/codex/skills).
- Report of the 2% budget and silent shortening: [openai/codex#19679](https://github.com/openai/codex/issues/19679).

When the context window is known, the budget is `max(1, floor(contextTokens * 2 / 100))` tokens. A 272,000-token window is **5,440** tokens. A 1,000,000-token window is **20,000** tokens.

**There is no 8,000-token cap in current source.** The constant `DEFAULT_SKILL_METADATA_CHAR_BUDGET = 8_000` is a **character** fallback used only when the context window is unknown. The docs say the same thing: "at most 2% of the model's context window, or 8,000 characters when the context window is unknown." Two percent of a 400,000-token window is 8,000 tokens, which is why the two numbers get conflated. This tool follows the known-window formula and does not invent an 8,000-token ceiling.

Listing shape modeled here, from `render_with_description`:

```text
- name: description (file: /absolute/path/SKILL.md)
```

Allocation, in order:

1. Cut each description to 1,024 characters (`MAX_CATALOG_SKILL_DESCRIPTION_CHARS`). The cut keeps 1,021 characters and adds `...`. A description that only hits this cap is `truncate` / `hard-cap`, even when the budget has room.
2. If every full line fits, status is `keep` (or `truncate` when step 1 applied).
3. Otherwise, if every name-only line fits, distribute the remaining tokens round-robin, one character at a time, so one skill cannot take the whole remainder. Shortened rows are `truncate` / `budget-truncated`.
4. If the names alone do not fit, include name-only lines from the front of the list until the budget is spent. The rest are `drop` / `omitted`: Codex leaves them out of the model-visible list. In that mode Codex also strips every description. The warning in upstream source is "All skill descriptions were removed and N additional skills were not included."

Sort order follows the scope rank in that file: system, admin, repo, user, plugin, then name, then path. Directories passed with `--dir` are scope `custom` and sort by name, then path.

### Claude Code

Checked against:

- [Skill descriptions are cut short](https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short).
- Maintainer confirmation on [anthropics/claude-code#81081](https://github.com/anthropics/claude-code/issues/81081): the listing budget defaults to 1% of the context window; on overflow every name is kept and descriptions are dropped starting with the least-used skills. With no usage history that order follows the listing.

Budget: `max(1, floor(contextTokens * 1 / 100))` tokens. A 200,000-token window is **2,000** tokens. The docs describe this as a character budget that scales at 1% of the context window, which matches `contextTokens * 4 * 0.01` characters under the chars/4 heuristic.

Each entry's `description` plus `when_to_use` is capped at **1,536** characters (`skillListingMaxDescChars`) before the budget is applied. That cap is a hard cut with no ellipsis in this estimate.

Listing shape modeled here:

```text
- name: description
```

A dropped description becomes `- name`. The skill is still invocable. Status `drop` for Claude means **name kept, description removed** (`description-dropped`). Codex `drop` means the skill line itself was omitted. The table legend states which harness you are looking at.

Claude's real drop order is least-used, with a recency factor. This tool does not read Claude's usage history, so it drops whole descriptions from the end of a stable sort: skills A to Z, then agents. That is a stand-in for a fresh session, not a replay of your `skillUsage` file.

### Agents

[anthropics/claude-code#87515](https://github.com/anthropics/claude-code/issues/87515) points out that the subagent roster (name + description) is injected in full and has no listing budget of its own. With `--include-agents`, this tool charges those markdown files against the **same 1%** as skills, and drops agent descriptions before skill descriptions. That shows combined pressure. It is not a claim that today's Claude Code truncates agents.

## Where it scans

Defaults are used when `--dir` is omitted. Passing `--dir` replaces them. Only directories that exist are listed. Ancestor walks stop at the git root (a `.git` file or directory).

Codex, from [`host_roots.rs`](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs) and the [skills docs](https://developers.openai.com/codex/skills):

| Scope | Path |
| --- | --- |
| User (legacy, still scanned) | `$CODEX_HOME/skills`, default `~/.codex/skills`, including `skills/.system` |
| User | `~/.agents/skills` |
| Repo | `.agents/skills` and `.codex/skills` from the working directory up to the git root |
| Admin | `/etc/codex/skills` |
| Plugins | `$CODEX_HOME/plugins` |

Claude Code, from the [skills docs](https://code.claude.com/docs/en/skills) and the [plugins reference](https://code.claude.com/docs/en/plugins-reference):

| Scope | Path |
| --- | --- |
| Personal | `~/.claude/skills` |
| Project | `.claude/skills` from the working directory up to the git root |
| Plugins | `~/.claude/plugins/cache` (`SKILL.md` under installed plugin copies) |
| Agents (`--include-agents`) | `~/.claude/agents`, `.claude/agents` on the same walk, and `agents/*.md` inside a scanned root |

A skill is a `SKILL.md` with YAML frontmatter. `name` falls back to the directory name. `description` is required. Block scalars (`|` and `>`) and quoted strings are read; other YAML is ignored. Claude skills with `disable-model-invocation: true` are omitted from the listing, matching the docs (the description is not injected). Codex does not treat that flag as a listing filter.

## Limitations

- Results are estimates. Codex also prepends a skills-usage blurb and, for extension catalogs, alias tables. Those bytes are not included, so a catalog that lands just under the budget here can still truncate upstream.
- Codex `skills.max_context_tokens` (positive, capped at 10,000 in source) and Claude `skillListingBudgetFraction`, `skillListingMaxDescChars`, `skillOverrides`, and `SLASH_COMMAND_TOOL_CHAR_BUDGET` are not read.
- Plugin enablement is not read. A cached plugin skill is counted even if that plugin is disabled, which can over-count.
- Bundled skills compiled into the Codex or Claude Code binaries are not on disk in the usual roots, so they are missing.
- `.claude/commands/*.md` shares Claude's listing and is not scanned.
- Nested `.claude/skills` directories *below* the working directory load only after Claude reads a file there. They are not included unless you pass `--dir` or start in that directory.
- Enterprise managed skill paths and synced `~/.claude/skills/synced` are picked up only when that directory is one of the roots above.
- Claude drop order ignores real usage and recency.
- The token heuristic is not the model's tokenizer. Non-ASCII text is counted by UTF-8 bytes, not by code points.

## Development

```bash
npm install
npm test
npm run build
node dist/cli.js --harness codex --context 272000 --dir test/fixtures/codex-63 --ci
```

`npm test` runs Vitest. GitHub Actions runs those tests, then `tsc`, on Node 18, 20, and 22 for every pull request.

Pushing a `v*` tag runs `.github/workflows/publish.yml`: build, test, then `npm publish --provenance --access public`. The tag must match `package.json` `version` (`v0.1.0` publishes `0.1.0`).

## License

MIT, copyright Salman Labs. See [LICENSE](LICENSE).
