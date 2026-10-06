# Release dependency patches

`@happyvertical/smrt-personas@0.52.0` is patched only at its compiled runtime
import boundary. The patch defers loading `@happyvertical/smrt-messages` until
the persona messaging tool executes, so the application's `Attachment` model
does not collide with the messages package during manifest discovery.

The patch is derived from happyvertical/smrt commit
`2d065a7943bbea3bf8f73a7cd0a4eed2b20a74e7` (upstream issue #3535). Its source,
original and patched archive hashes, and patch SHA-256 are recorded in
`@happyvertical__smrt-personas@0.52.0.provenance.json`. This release-local patch
does not assert that the upstream change has merged or been published.
