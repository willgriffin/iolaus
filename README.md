# Iolaus

An open-source, human-assisted job-search application built with s-m-r-t.
Candidate facts, opportunities, application preparation, and review are exposed
through the browser and authenticated agent tools. Employer transmission always
requires explicit human approval.

## Development snapshot

This first source snapshot is not yet an end-user release. Local SQLite setup,
private onboarding and the one-prompt installation experience are being completed
before the first release. Do not point development commands at a production DB.

Requirements: Node 24.18 or newer and pnpm 11.24.0.

```sh
git clone https://github.com/willgriffin/iolaus.git
cd iolaus
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Dependencies resolve from public npm; no private repository token is required.
Optional AI/PDF/crawling features may require separately configured providers or
system dependencies. They are not certified by source-snapshot validation.

The checked-in candidate data is empty. Never commit candidate information,
credentials, generated resumes, application history or deployment secrets.
See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md) and
[provenance](PROVENANCE.md). License: [MIT](LICENSE).
