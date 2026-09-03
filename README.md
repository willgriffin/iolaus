# Iolaus

An open-source, human-assisted job-search application built with s-m-r-t.
Candidate facts, opportunities, application preparation, and review are exposed
through the browser and authenticated agent tools. Employer transmission always
requires explicit human approval.

## Install locally

Iolaus defaults to a private, single-user local profile. Its SQLite database,
assets, secrets, process state, backups and exports live in the operating
system's user-owned application-data directory, outside this checkout. Local
background crawling, external workers and paid AI capabilities are off unless
you explicitly enable and configure them.

Requirements: Node 24.18 or newer and pnpm 11.24.0.

```sh
git clone https://github.com/willgriffin/iolaus.git
cd iolaus
pnpm install --frozen-lockfile
pnpm app:install
```

`app:install` builds the application, creates or upgrades its private SQLite
database, starts a loopback-only server, and opens the single-use owner setup
page. It is safe to retry. Operational recovery commands are:

```sh
pnpm app:doctor
pnpm app:stop
pnpm app:recover
pnpm app:start
pnpm app:open
pnpm app:backup
pnpm app:export
pnpm app:import -- /absolute/path/to/export.json
```

Set an absolute `SMRT_DATA_DIR` before the first run only when you want to own
the data location explicitly. `HOST` must remain loopback for the local owner
bootstrap. See [.env.example](.env.example) for self-hosted PostgreSQL and
optional provider settings.

Dependencies resolve from public npm; no private repository token is required.
Optional AI/PDF/crawling features require separately configured providers or
system dependencies. Missing optional providers never block the local install;
features stay disabled and can be diagnosed with `pnpm app:doctor`.

The checked-in candidate data is empty. Never commit candidate information,
credentials, generated resumes, application history or deployment secrets.
See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md) and
[provenance](PROVENANCE.md). License: [MIT](LICENSE).
