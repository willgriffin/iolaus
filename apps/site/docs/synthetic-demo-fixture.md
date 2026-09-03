# Synthetic demo fixture

The synthetic fixture is strictly for local/demo proof. It creates one visibly
fictional candidate, company, posting, opportunity, decision, application,
resume placeholder, review comment, task, and audit run. It never creates a
file, starts a crawler, contacts an employer, or submits an application.

Run it only from a local or dedicated demo environment:

```bash
IOLAUS_ENABLE_DEMO_FIXTURES=1 pnpm --filter @willgriffin/iolaus-site exec tsx scripts/demo-fixture.ts
```

The fixture refuses to run without that explicit variable and always refuses
when `NODE_ENV=production`. It is idempotent: later invocations reuse the same
`iolaus-demo-fictional-*` records rather than creating more demo data.
