# Opportunity list views

The Opportunities toolbar provides List, Columns (a responsive card grid), and
Table. All use the server's current filtered, sorted page and the same parent-owned
selection IDs. Table is the initial and invalid-preference fallback. A presentation
preference is stored under `iolaus.admin.opportunities.view.v1`; denied storage does
not prevent switching. No view changes perform queries or business mutations.

## Test design

Risk: standard, presentation and local preference only. No database transaction,
SQL dialect, provider, or external write is involved. Native table/collection
selection and pagination retain their established contracts.

| Behavior | Trigger and positive case | Negative / boundary | Actor / context | Level / validation |
| --- | --- | --- | --- | --- |
| View selection | User presses List, Columns, Table; exactly one pressed button and identical page records | Initial/invalid preference defaults Table; repeated current button remains selected | Browser; upstream Button / CollectionList / DataTable | Browser focused suite |
| Preference | Switch then remount restores choice | Denied storage remains operable; SSR never reads browser storage | Browser / SSR | Browser and existing SSR suite |
| Stable selection | Check a row, switch views, select current page, replace page records | Off-page IDs retained; clear-page removes only current IDs; empty page cannot select | Parent-controlled IDs / native checkbox callbacks | Browser focused suite |
| Modal boundary | Activate record review button | Checkbox and evidence/posting link do not open modal | Browser; real parent with modal boundary fixture | Browser + authenticated HMR QA |
| Server page/filter | Same page rows across all views; next-page uses existing URL navigation | No new fetch/assessment; filter change preserves server-owned behavior | Browser navigation boundary | Browser focused suite |
| Responsive layout | Native grid wraps at mobile width, all controls visible in dark theme | No workflow columns or status mutation | Authenticated desktop/mobile | Read-only HMR QA |

Commands in an isolated source snapshot, coordinated with the integration lane:
`pnpm --filter @willgriffin/iolaus-site exec vitest run src/lib/components/admin/OpportunityCardList.spec.ts`
and `pnpm --filter @willgriffin/iolaus-site exec vitest run --config vitest.browser.config.ts src/lib/components/sources/OpportunityCardList.browser.spec.ts`.
Static validation uses the existing package check in the same isolated lane.
