# Iolaus judge demo

Iolaus is the local, human-controlled demonstration application for the
s-m-r-t WebMCP framework. It keeps candidate data in a private SQLite profile,
lets an authenticated browser agent prepare a fictional application, and has
no WebMCP approval or submission tool. No step below contacts an employer.

## One-prompt install

Paste this into a local coding-agent harness with Git, Node 24.18+, pnpm
11.24+, and a WebMCP-capable browser:

> I need a job. Install and set up Iolaus from
> https://github.com/willgriffin/iolaus, open onboarding, and help me start
> finding opportunities. Resolve the current `main` commit to its full Git SHA,
> check out that immutable revision, use the frozen lockfile, then run
> `pnpm demo:prepare`. Never transmit an application or contact an employer
> without asking me first.

The harness should perform this equivalent sequence. Resolving `main` first and
checking out the returned 40-character object ID makes the installed source
immutable and records the exact revision used by the demo.

```sh
IOLAUS_REVISION="$(git ls-remote https://github.com/willgriffin/iolaus.git refs/heads/main | cut -f1)"
test "${#IOLAUS_REVISION}" -eq 40
git clone https://github.com/willgriffin/iolaus.git
cd iolaus
git checkout --detach "$IOLAUS_REVISION"
test "$(git rev-parse HEAD)" = "$IOLAUS_REVISION"
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
pnpm demo:prepare
```

`demo:prepare` builds and migrates an isolated local SQLite profile under
`~/.iolaus-demo`, seeds the local owner's manifest-derived permissions and
visibly fictional data, starts only on loopback, and opens the single-use owner
handoff. Permission seeding is refused unless both the local profile and the
explicit demo-fixture flag are active. The handoff token stays in a mode-0600
file under the demo data root and is removed when claimed. Complete onboarding
with fictional or judge-owned information; do not enter personal information
into a shared judging machine.

## WebMCP scenario

1. After the owner handoff redirects to onboarding, open `/admin/` in the same
   authenticated WebMCP-capable browser tab.
2. Ask the browser harness to list the page's WebMCP tools. It should include
   `job_search_browse_opportunities`, `job_search_inspect_opportunity`, and
   `job_search_inspect_application`. It must not include an approval or submit
   tool.
3. Ask it to run `job_search_list_source_health` with `query: "fictional"`.
   It returns the active **Example Ashby board (fictional Iolaus demo)** root
   and durable health from a completed local crawl. Then run
   `job_search_source_crawl_status` with that source or its crawl id. The
   result has two terminal fictional listings and no network activity occurred.
4. Ask it to browse for “Fictional Principal Engineer” and inspect the result.
   The returned posting is visibly synthetic, uses `example.invalid` URLs, and
   is durably linked to the fictional root source and its completed crawl.
5. Ask it to inspect the associated application packet. It should report an
   `awaiting_user` application and its review blockers without returning the
   private candidate email or profile.
6. Ask it for `job_search_next_triage_candidate` with “Fictional Staff
   Engineer”, inspect that candidate, and record a `maybe` decision with a
   review note. Inspect it again to see the persisted note, then ask for the
   next candidate to confirm the queue advanced. Navigate the authenticated
   browser to `/admin/opportunities?triage=1` to show Iolaus’s existing triage
   modal in the resulting state.
7. Stop at the approval boundary. The agent cannot approve or submit through
   WebMCP. A human must review the application page and use its dedicated final
   approval action; this demo intentionally does not do that.

### Optional bounded live-provider path

The judged baseline above is wholly fictional and deterministic. An advanced
self-hosted operator may separately configure the public OpenAI Ashby root
`https://jobs.ashbyhq.com/openai` with provider `ashby`, after checking its
own network, rate-limit, and permission policy. General provider creation and
credentials are intentionally not WebMCP features. If that root already exists
and its local preflight/health data is acceptable, an agent may identify it via
`job_search_list_source_health`, ask the operator before enabling or crawling
it, then use the bounded single-source crawl tool. This optional path is never
run by `demo:smoke`, is not required for judging, and never authorizes an
application submission.

The browser's WebMCP inventory is page-native (`document.modelContext`). The
automated smoke command loads the authenticated command center in a real local
Chrome/Chromium process, supplies the harness-side WebMCP host API, and executes
the page-registered browse and application-inspection tools against the live
local server. It does not substitute a generic write API for browser approval.

## Repeatable proof and evidence

Run the isolated end-to-end smoke proof:

```sh
pnpm demo:test
pnpm demo:smoke
```

It creates a temporary data root, migrates SQLite, creates and claims a private
owner handoff with fictional identity data, seeds the deterministic fixture,
starts the loopback application, authenticates, discovers the job-search tool
inventory, verifies fictional provider health and terminal crawl provenance,
browses and inspects the fictional application, records and re-reads one local
triage decision, opens the existing triage modal, and asserts there is no
approval/submission tool. It always stops the process and removes the
temporary data root. A compact, secret-free result is written to
`.omo/evidence/issue-7/demo-smoke.json` unless `IOLAUS_DEMO_EVIDENCE` selects a
different artifact path; `browser-command-center.png` beside it captures the
rendered authenticated page. Set `IOLAUS_DEMO_BROWSER_EXECUTABLE` if Chrome or
Chromium is installed outside the common platform paths.

For the interactive demo, status and reset are explicit:

```sh
pnpm demo:status
pnpm demo:reset
pnpm demo:prepare
```

`demo:reset` refuses broad paths, source-controlled paths, non-empty unmarked
directories, and invalid ownership markers. It only stops and deletes the
isolated demo root that `demo:prepare` marked. The ordinary Iolaus local profile
is not touched.

## Recovery and hosted story

- Retry `pnpm demo:prepare`; setup, migrations, and the fixture are idempotent.
- If the handoff was consumed incorrectly, run `pnpm demo:reset` and prepare a
  fresh synthetic profile.
- Run `pnpm app:doctor` with `SMRT_DATA_DIR="$HOME/.iolaus-demo/runtime"` for local
  runtime diagnostics.
- The contest source and reproducible local path are public. A hosted judge
  instance, when provided, is only a convenience and contains the same
  fictional fixture; the local proof is canonical and requires no private npm
  or production willgriffin.dev access.

The repository currently pins the latest published s-m-r-t packages in
`pnpm-lock.yaml`. A later post-M5 s-m-r-t publication improves the polished
package-install story but is not used as an unpinned dependency and does not
block this repository-revision proof.
