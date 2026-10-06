# Synthetic demo fixture

The synthetic fixture is strictly for local/demo proof. It creates one visibly
fictional candidate, company, posting, opportunity, decision, application,
resume placeholder, review comment, task, and audit run. It never creates a
file, starts a crawler, contacts an employer, or submits an application.

Run it only from a local or dedicated demo environment:

```bash
IOLAUS_ENABLE_DEMO_FIXTURES=1 IOLAUS_DEMO_OWNER_EMAIL='<existing local owner email>' pnpm --filter @willgriffin/iolaus-site exec tsx scripts/demo-fixture.ts
```

The fixture refuses to run without that explicit variable and always refuses
outside the resolved `local` runtime profile. `NODE_ENV` is not used to choose
the persistence target. It is idempotent: later invocations reuse the same
`iolaus-demo-fictional-*` records rather than creating more demo data.

Complete local owner setup and candidate onboarding first. The email selector
must identify an existing active owner with a native tenant membership and a
verified selected candidate profile; it never provisions an identity or grants
authority. Private fixture records and resume artifact paths are partitioned by
that owner and profile. Public fictional source and opportunity records remain
reusable. The browser test creates its owner before seeding within its disposable
runtime, and separately verifies an unrelated session cannot open the review.
