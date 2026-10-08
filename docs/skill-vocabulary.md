# Skill vocabulary

The shared catalog canonicalizes exact aliases through the fixed baseline and a
trusted snapshot of `seed` and operator `confirmed` terms. Related edges are
for discovery only; they never imply an exact match.

Use `pnpm --filter @willgriffin/iolaus-site skills:vocabulary -- refresh` to
load the current trusted snapshot. Operators promote a term with `promote`, a
bounded label and aliases, and optional related edges whose weights are 0–1.
Candidate rows never enter the synchronous matcher snapshot.

```sh
pnpm --filter @willgriffin/iolaus-site skills:vocabulary promote --label PostgreSQL --slug postgresql --aliases postgres,postgresql --related-json '[{"slug":"sql","weight":0.5}]'
```

The same command corrects an existing canonical term. Labels, aliases and
categories are bounded to 100 characters; at most 50 aliases and 50 related
edges are accepted. Unknown or duplicate CLI flags are rejected. A native
transaction validates the entire proposed active alias graph before writing.
PostgreSQL advisory locking and the shared SQLite operation lock serialize
operator corrections, so concurrent conflicting aliases cannot both commit.
A rejected correction leaves the persisted vocabulary unchanged.
