# Issue 220: release browser coverage

The browser suite targets the shared card lists and header actions. Filters live
in dialogs; removed page headings and count labels are not readiness markers.
Single-card review and sequential triage remain separate workflows.

| Behavior | Positive check | Negative or recovery check | Evidence |
|---|---|---|---|
| Application preparation | Select a resume, create a draft, follow its client link and generate default and tailored materials | No approval or submission; application materials must actually render after navigation | `applying-readiness.spec.ts`, all four projects |
| Card review | Successful decision removes the card and returns to the list | Failed decision stays open; dismissal does not mutate; sequential queue still advances | `applying-readiness.spec.ts`, all four projects |
| Header filters and sorting | Filter dialog, salary order, legacy sort links and refill use the current controls | Closing deep-linked triage cannot reopen it while filters open; explicit list sort wins | `mobile.spec.ts`, all four projects |
| Overview | Current overview landmark exposes priority tasks | Foreign-owner tasks stay private | `applying-readiness.spec.ts`, all four projects |
| Archival | Application filters expose archived records; sweep removes eligible cards | Sweep preview is read-only, protected rows remain, and the authenticated list total falls by the archived count | `mobile.spec.ts` and `sweep.spec.ts` |
| Action feedback identity | A plain action result notifies once; a distinct result notifies again | Reusing the same object does not create an effect loop | `AdminRecordViewPageHeader.browser.spec.ts` |
| Outgoing header cleanup | Application-shaped incoming data can replace generic record data during teardown | The lifted outgoing header does not read absent resource metadata | `AdminRecordViewPageHeader.browser.spec.ts` plus the application browser flow |

The two component regressions fail on the prior release head: deep-proxied action
identity causes `effect_update_depth_exceeded`, and the outgoing registered header
can read `resource.label` after the next route replaces its data. Preserve raw
action-result identity and guard resource-dependent header content during teardown.

The browser fixtures use an isolated migrated SQLite database and fictional PDFs.
No personal resume, live employer submission, schema or authorization change is
required for these regressions. The sweep total is read through the authenticated
list API because the UI no longer renders the global count; the mutation and
visible-card/protected-row assertions still run through the browser.
