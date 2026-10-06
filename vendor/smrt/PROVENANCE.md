# Reviewed SMRT MCP Apps CLI closure

These two public package archives were built locally from
[`happyvertical/smrt` commit `c6e5cdf2d8146f520a9fb60d0e41e427dcf94673`](https://github.com/happyvertical/smrt/commit/c6e5cdf2d8146f520a9fb60d0e41e427dcf94673).
They are kept together because the reviewed CLI's `mcp-apps validate` command
loads Agent Plugins schemas through `@happyvertical/smrt-dev-mcp` exports that
the published `0.52.0` dev-MCP archive does not expose.

| Archive | SHA-256 | Contents verified |
| --- | --- | --- |
| `happyvertical-smrt-cli-0.52.0-c6e5cdf2.tgz` | `259b29368b28dec5b04e1b0e8d40f8ef8f56a055cb61c4348f652de69af4f1c8` | CLI bin, compiled `dist`, public docs/agent guidance |
| `happyvertical-smrt-dev-mcp-0.52.0-c6e5cdf2.tgz` | `1a610a21dfe89cae47e532cfc12cc00431e4932b45cf02658b8dc3315ccf1392` | compiled `dist`, public schemas, docs/skills |

The package licenses are included in their respective archives. Neither archive
contains environment files, keys, credentials, `node_modules`, or generated
SMRT knowledge output. Their upstream release defect is tracked in
[happyvertical/smrt#3335](https://github.com/happyvertical/smrt/issues/3335).

## Embedded validator qualification

These archives are intentionally retained together as embedded build tooling for
the daily-use release tracked by [Iolaus #164](https://github.com/willgriffin/iolaus/issues/164).
They are not a claim of parity with the published 0.52.0 validator, which lacks
the command/schema-export closure described above. Do not publish these archives
independently.

The exact installed CLI was exercised under Node 24.18.0: valid plugin metadata
passed, invalid plugin metadata failed, and both pinned dev-MCP schema exports
resolved. A clean frozen-lockfile install and the Docker dependency stage also
passed with both archives and the declaration patch present before installation.
Final application build, tests and independent review qualify the integrated
release separately; these tool checks do not replace application validation.

The archived CLI declares SDK dependencies at `^0.98.0`; the application keeps its
explicit AI 0.96.1 override. This qualification covers the filesystem/Ajv/schema
validator path, which performs no AI operation. It does not certify unrelated
CLI AI commands against that override. No provider credentials or personal data
are needed for the validator checks.

Published CLI/dev-MCP 0.54.2 includes the validator but requires a Node 26
closure. Replacing these archives therefore needs a separately qualified runtime
and dependency upgrade, not a silent version substitution in this Node 24
release. Replace both together once that supported closure passes the same
positive and negative validator checks.
