<!-- hv-managed-policy:start revision=1.0.0 sha256=2c2f4d048293cab2fc7f8c636eee474c0386c13a9c7bbf2c535c5ada47d1d6e5 -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation.
- Tracked implementation work is complete when documented validation is green, `review-cycle` has passed, the claim is handed off, and a ready-for-review pull request exists; do this unprompted, even where harness defaults wait for a user request. Before editing untracked requested work, create and claim its issue, or — patch-class only — record it on this session's open patch train; work the user explicitly scopes as a throwaway spike is exempt: it ends at its report and never enters the commit, push, or PR lifecycle.
- Claim an issue before editing it: add `agent: implementation` and post one claim comment naming your runtime, session, and branch. Do not take an issue another session holds with activity in the last 24 hours without a handoff. Any agent may assign work to another agent with a `dispatch: <runtime>` label and an instruction comment; the receiving agent claims it.
- Patch-class work — small bug, doc, and improvement changes with no schema, contract, dependency, or breaking change — may bundle as one patch train on one branch and pull request with one commit per item. Other work stays one issue per pull request. An incidental patch-class fix of ten lines or fewer near files under edit ships in the same pull request as its own commit, listed under `Drive-by fixes` in the PR description; other findings go to the tracker.
- Hand off intentionally: when done, blocked, or stopping, update your claim comment with the outcome and next step and remove `agent: implementation`. Never delete claim history.
- Open pull requests only when reviewable, never as drafts, and keep them ready for review. Watch a ready PR until it is mergeable — no base conflicts, no unresolved review threads, the repository's required checks green, its required approvals satisfied — or report a concrete blocker.
- Incomplete work remains ready with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Agents do not merge unless explicitly authorized in the current session, and then only when the repository's own required checks and approvals pass.
- Run documented validation and update affected docs before shipping.
- Token efficiency: risk defaults to standard, high needs a named trigger; after the first final pass only accepted blockers reopen edits; after six passes, ask the user before more; wait outside the implementer.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared SOPs and portable skills come from the designated control-plane repository. Repositories choose their own technology and may add stricter local rules.

<!-- hv-managed-policy:end -->

# iolaus.localhost Agent Guide

`AGENTS.md` is the canonical authored agent document for this repository.
`CLAUDE.md` must remain only the `@AGENTS.md` shim.

## Project Shape

- Turbo + pnpm 11 monorepo.
- SvelteKit app: `apps/site`.
- Resume PDF generator: `apps/resume-pdf`.
- Shared resume package: `packages/resume`.
- Local CLI and MCP bridge: `packages/cli`.

Use repository scripts before package-specific commands unless a narrower
package script is clearly enough.

## PDF Work

All PDF handling — reading, extraction, and generation — targets
`@happyvertical/pdf`, the organization PDF package. Do not add direct
dependencies on puppeteer, pdfjs, or other PDF engines in this repo's apps or
packages. If `@happyvertical/pdf` is missing a capability (e.g. HTML-to-PDF
rendering), improve that package upstream rather than working around it here.
`packages/resume` owns resume domain knowledge (templates, tailoring) only; the
rendering engine belongs upstream. The current direct puppeteer dependency in
`packages/resume` is legacy debt slated for removal once `@happyvertical/pdf`
ships a generation API.

## Validation

Run the narrowest useful check first, then broaden before shipping:

```bash
pnpm format-check
pnpm lint
pnpm check
pnpm test
pnpm build
```

For database-sensitive changes, also run:

```bash
pnpm --filter @willgriffin/iolaus-site db:migrate
pnpm --filter @willgriffin/iolaus-site db:status
```

Commit messages and pull request titles use Conventional Commits. Scopes are
allowed but optional.

## SMRT Domain Knowledge

The site uses SMRT's downstream domain knowledge tooling. Local dev/build runs
the SMRT Vite plugin, which writes ignored artifacts under `apps/site/.smrt/`
and mirrors project-scoped artifacts to repo `.smrt/`, including
`.smrt/smrt-knowledge.json`.

Generated knowledge artifacts are source facts, not authored guidance. Do not
commit `.smrt/` output unless a future issue explicitly changes that policy.

Run deterministic, token-free freshness checks before using model-generated
review or architecture advice:

```bash
pnpm knowledge:check
pnpm knowledge:check:json
```

For review work:

1. Run `pnpm build` or `pnpm --filter @willgriffin/iolaus-site build` so the SMRT
   manifest and knowledge artifact are fresh.
2. Run `pnpm knowledge:check`.
3. Build context for the changed files:
   `pnpm knowledge:review-context --focus "$(git diff --name-only origin/main...HEAD)"`.
4. Hand the returned prompt bundle to Codex, Claude, or another model.
5. Inspect the actual diff yourself and report findings first.
6. Re-run `pnpm knowledge:check` after edits.

For architecture planning:

```bash
pnpm knowledge:architecture-context "short idea or docs prompt"
pnpm knowledge:architecture-context:json "short idea or docs prompt"
```

## SMRT Dev MCP

This repo pins `@happyvertical/smrt-dev-mcp` and includes `.mcp.json` for local
MCP clients. Start it with:

```bash
pnpm smrt:dev-mcp
```

Expected domain knowledge tools:

- `reflect-domain-knowledge`
- `check-domain-knowledge`
- `build-domain-review-context`
- `build-domain-architecture-context`
- `smrt-review`
- `smrt-architecture`
- `get-agent-skill`

Expected resources:

- `smrt://knowledge/project`
- `smrt://knowledge/package/{name}`

Expected prompts:

- `domain-code-review`
- `domain-architecture`

Use MCP tools/resources/prompts for project-scoped SMRT context. For PR/code
reviews, always use the SMRT MCP review workflow first: fetch
`smrt-code-review` with `get-agent-skill` when available, call `smrt-review`
with the repository root and changed files, inspect the actual diff yourself,
then run `check-domain-knowledge` or `check-knowledge-freshness` after edits.
For architecture work, always call `reflect-domain-knowledge` and
`smrt-architecture` or `build-domain-architecture-context` before proposing or
reviewing a plan. Use `pnpm knowledge:*` scripts only as the fallback when the
MCP tools are not exposed in the active client, and state that fallback.
