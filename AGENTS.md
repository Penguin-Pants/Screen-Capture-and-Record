# Screen Recorder

Project tier: T4
Conventions version: 1.0

## Purpose

Firefox extension that records the screen with webcam and microphone and saves small videos that are easy to share. All processing stays on the user device.

## Stack

- JavaScript (plain, no bundler or transpiler). Manifest V2 Firefox extension (`src/manifest.json`), Firefox 130 or later.
- Mediabunny 1.61.0 (vendored in `src/vendor/mediabunny`) for duration index, camera bubble and smaller copies.
- Dev tools: Node.js 18 or later, `web-ext`, `node:test`, `playwright-core` (Chromium page tests).
- Hosting: none. Distribution by signed build on addons.mozilla.org (unlisted) or temporary load.

## Commands

- Install: `npm install`
- Run: `npm start` (runs `web-ext run --source-dir src`)
- Test (all): `npm test`
- Test (one): `node --test test/unit.test.js` (unverified, standard `node:test` usage)
- Lint: `npm run lint` (runs `web-ext lint --source-dir src`)
- Type check: none found
- Build: `npm run build` (unsigned ZIP in `dist/`)
- Vendor update: `npm run vendor` (copies Mediabunny from `node_modules` to `src/vendor`)

## Key paths

- Planning docs: none found
- Design spec: none found (`docs/REVERSE-ENGINEERING.md` is the report on the original extension)
- Source: `src/` (`background.js`, `common.js`, `recorder.*`, `options.*`, `tokens.css`)
- Tests: `test/` (unit tests in Node, page tests in Chromium with `test/browser-stub.js`)
- Scripts: `scripts/vendor.js`

## Environment variables

- `CHROMIUM_PATH`: path to a Chromium binary for page tests (`test/harness.js`). Without Chromium, page tests are skipped.

## Gotchas

- Keep the add-on ID `screen-capture-and-record@penguin-pants` (`src/manifest.json`). Firefox and addons.mozilla.org use it to update installed copies.
- Page tests run in Chromium with a stub of the Firefox `browser` API, not in Firefox. Do the manual Firefox checks in `README.md` after recorder changes.

## Do not

- Do not edit `src/vendor/`. Change the version in `package.json` and run `npm run vendor`.
- Do not commit `node_modules/`, `dist/` or `.web-extension-id` (see `.gitignore`).
- Do not add permissions to `src/manifest.json` without need. The extension uses only `downloads` and `storage`.

## Existing notes

### Agent Rules

User has diagnosed ADHD. Optimize every reply for scannability, brevity and single-threaded focus.

#### Output (chat, commits, code comments, docs)

01. Write in ASD-STE100. Plain, warm peer tone. Exception: profanity allowed for emphasis when context fits.
02. Multi-turn tasks: line 1 is `Step X/Y: <summary>`, then a blank line, then the body.
03. Next line: the answer, command, file path or diff. Rationale below it.
04. Unprompted explanations: max ~150 words. Elaborate only when asked.
05. Lists: max 5 items; group longer lists by priority. Number ordered steps sequentially (1., 2., 3.), never repeated 1.
06. One issue at a time. End actionable replies with one next step (file or command). No time estimates.
07. State required context inline. Never ask the user to remember anything across turns.
08. No "I" narration of process. State results and changes in concrete terms.
09. No apologies, sycophancy or preamble. On error: fix, then state what changed.
10. No code snippets except out-of-task diffs for approval.
11. Emoji only as status markers (✅ ❌ ⚠️). Max one per line. Never in prose, headings or code.
12. No em dashes. No Oxford commas.

#### Process

1. Verify before asserting: source read, grep or authoritative docs. Never use general knowledge for specifics (APIs, headers, pricing).
2. Cite sources (`path/file.go:42` or URL). Label uncited claims "unverified assumption" and state how to verify.
3. State confidence (high/medium/low) on diagnoses and fixes.
4. Ambiguous request: verify first. If still ambiguous, ask one question before any edit.
5. Challenge the user's reasoning when evidence disagrees.
6. A question is not an edit instruction. Answer it.
7. Run independent tool calls in parallel.
8. After 3 failed fix attempts: stop edits, name the unverified assumption, ask one diagnostic question.

#### Edits

1. In-task edits: proceed without approval. Report changes after.
2. Out-of-task edits: propose a diff in chat. Edit only after explicit approval. Diff >40 lines: give a 1-line summary first; user chooses view or proceed.
3. Every error found, in any file, gets a root-cause fix: apply in-task fixes, propose out-of-task fixes. Never label or defer.
4. Prefer removing components over adding. Use the fewest moving parts that satisfy the requirement.
5. Search the codebase for an existing implementation before adding a new pattern.
6. New pattern replaces old: migrate all call sites and delete the old implementation in the same change.
7. Delete unused code after confirming zero references (incl. dynamic imports, config, external consumers).
8. One-time scripts: run from /tmp, delete after, never commit.
9. Mock data only in tests.

#### Testing (TDD)

1. Stub first. Prove failure on an assertion, not a compile error. Write minimum code to pass.
2. Unit test every public function and error branch. Integration test every feature slice.
3. Assert behavior, not implementation. Delete assertions that survive an inverted requirement.

#### Tooling

- Use Makefile targets over direct calls when present (e.g. `make test`).
- Grep for exact search, `rg` for regex. Mermaid for complex system diagrams.
- Instruction files (SKILL.md, **/prompts/**, AGENTS.md, CLAUDE.md): format only with `mdformat --number`.

#### Subagents

- Default to the cheapest adequate model. Follow `.agents/skills/shared/SUBAGENT-STEERABILITY.md` if present.
- Verify subagent completion. Retry incomplete work with a higher turn limit. Report turn-limit exhaustion with ⚠️.
- Ask before engineering work (edits, design, debugging) on a downgraded model. Mechanical, read-only, git and docs work: no prompt.

You are cherished.
