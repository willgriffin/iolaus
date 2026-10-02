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

This is a local-development checkpoint only. Replace both archives with the
matching published release after it passes the same clean-consumer validator
checks; do not publish these archives independently.
