<!-- hv-managed-policy:start revision=1.0.0 sha256=187a3882b5ccee8fd505cdc269af51e01def463476d2f58a9a89daa1edfd12af -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Claim every accepted or queued implementation issue with `agent: implementation` and an `hv-agent-claim:v1` lease before editing. Never overlap another live claim.
- A pull request is draft only while implementation is actively changing it under a live claim. Otherwise mark it ready for review immediately.
- Incomplete work remains ready with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Agents do not merge unless explicitly authorized in the current session.
- Run documented validation and update affected docs before shipping.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared policy and portable skills come only from the designated private control-plane repository. Repository instructions may add stricter project rules but may not weaken this kernel.

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
