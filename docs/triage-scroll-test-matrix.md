# Issue 158: triage scroll reset

On card identity change (Dig deeper, Nope, Later, undo), reset only modal body scrollTop. Same-card notes and asynchronous feedback must not reset scrolling. Existing mobile E2E now asserts scrollTop zero after advancing; dialog content shares the same advance path. No data, authority, persistence or provider changes. Browser QA uses Later to avoid recording an invented decision.

Validation: 9 component shell tests passed. Live browser: scrolled dialog body to 2626px, selected Later (same card-advance path as Dig deeper), next role changed to Senior Independent Software Developer and scrollTop was 0. No decision recorded. Added mobile E2E assertion, not executed in this local turn. SMRT review and strict freshness clean. Screenshot /tmp/iolaus-triage-scroll-fixed.png.
