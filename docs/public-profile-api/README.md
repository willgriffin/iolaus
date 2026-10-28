# Published profile API v1

`GET /api/public/v1/profiles/{handle}` reads the current explicit publication.
It is anonymous: send no cookies, authorization header, or API key. Hosted
workspaces must enable `IOLAUS_PUBLIC_PROFILES_ENABLED=true`; disabled and
self-hosted private deployments return the same typed unavailable response.
The existing hosted HTML and PDF behavior is unchanged.

The strict [JSON Schema](profile-v1.schema.json), [OpenAPI contract](openapi.json),
and [synthetic example](synthetic-profile.json) define the wire format.
`apps/site/src/lib/public-profile-api-contract.ts` is the executable schema.
The API's `apiVersion: 1` evolves independently from persisted snapshot versions.
There is no list, draft, previous revision, or private source-record endpoint.

- `handle`: normalized published handle; use the returned value as canonical.
- `revision`: opaque change token. Compare for equality only; never decode,
  order, or treat it as a private record ID.
- `revisionCreatedAt`: timestamp when this immutable revision was prepared.
  It is **not** when the user clicked Publish. The resolver's historical
  `publishedAt` property means revision creation time; the API names it accurately.
- `links.profile` and `links.pdf`: controlled relative hosted routes, resolved
  against the API origin. PDF follows the current publication, so these URLs do
  not pin historical content. There are no upload URLs or storage paths.
- `profile`: only the selected, strictly validated public snapshot. Optional
  contacts require explicit opt-in; absent contacts must stay absent. Arrays
  can be empty because sections were excluded. Do not enrich from private data
  or invent missing sections. Text is plain data: escape it in HTML and validate
  HTTP(S) links before rendering. Fields such as education dates and experience
  summary are optional. The synthetic fixture includes optional-field omissions.

## Responses and browser behavior

GET and HEAD resolve the same publication and status; HEAD has no body.
OPTIONS returns 204 without resolving a handle or testing publication state.
All endpoint responses, including errors and unsupported methods, use
`Cache-Control: no-store`, `Access-Control-Allow-Origin: *`, and
`Access-Control-Allow-Methods: GET, HEAD, OPTIONS`. No credentials are allowed,
no session cookie is refreshed, and no private workspace is resolved. This
transport policy applies only to this endpoint, not admin or other APIs.

404 always has `{ "apiVersion": 1, "error": { "code": "PROFILE_UNAVAILABLE",
"message": "Profile unavailable." } }` for absent, invalid, reserved, draft,
withdrawn, deleted, or disabled publications. This endpoint
accepts normalized handle input in the same way as the existing resolver.
Operational/configuration failures and invalid stored/output payloads return 503 with code
`PROFILE_SERVICE_UNAVAILABLE` and message `Profile service unavailable.` in
the same envelope. Error responses never include internal exception details.
A generic HTML/routing 404 is not a withdrawal signal.

## Profile assistant (optional)

When `IOLAUS_PUBLIC_ASSISTANT_ENABLED=true` (shared hosted, public profiles on),
the publication also advertises `links.chat`, and `links.voice` once
`IOLAUS_PUBLIC_ASSISTANT_OPENAI_API_KEY` is set. Both are anonymous `POST`
endpoints under the same handle and answer only from the published snapshot;
they never read private records, remember visitors, or take actions.

- `POST /api/public/v1/profiles/{handle}/chat` — JSON `{ "messages": [{ "role":
  "user" | "assistant", "content": "…" }] }` (≤12 messages, ≤1000 characters
  each, last one from the visitor). Responds `text/event-stream`: `data:
  {"token":"…"}` frames followed by `data: {"done":true,"text":"…"}`.
- `POST /api/public/v1/profiles/{handle}/voice` — `application/sdp` WebRTC
  offer (≤64 KiB, audio only); responds `201 application/sdp` with the answer
  and `x-voice-seconds`, the deadline after which the server ends the call
  (see below for how that deadline is enforced).

Admission: browser requests must carry an `Origin` listed in
`IOLAUS_PUBLIC_ASSISTANT_ORIGINS` (comma-separated origins; CORS echoes the
matched origin, never `*`). Per client address: 12 questions per 10 minutes and
4 calls per hour (IPv6 keyed by /64); per handle: 120 questions per 10 minutes
and 12 call starts per hour; 3 concurrent calls per replica.

The deadline has two independent levers. Each call is also watched from the
provider side over OpenAI Realtime's per-call websocket (keyed by call id, the
key sent as a header). At `x-voice-seconds` the server hangs the call up through
the provider's hang-up API; if that attempt fails, the session is silenced over
the websocket at once (the current reply cancelled, queued audio dropped, turn
detection off, no room for another answer) so it neither speaks nor spends, and
the hang-up is attempted eight times at 15 s intervals. A call's slot is
released only on a confirmed end: the provider confirms the hang-up, reports
the call already gone (404/410, the usual case when the visitor hangs up
first), or closes the websocket cleanly after the session ended, whoever ended
it. A link lost mid-call confirms nothing. If neither lever ever confirms the
end, the line stays reserved until the provider's own 60-minute session cap has
certainly ended the call, and is released then. A replacement call is therefore
never admitted while an unconfirmed one may still be live, and a dead line
cannot outlast the provider cap.

That residual case needs both the hang-up API and the websocket to fail, and it
is never silent. Each retried hang-up attempt logs a `console.warn` with the
attempt count and the provider's HTTP status and error class (never its
message, which could echo the request); the final failure logs one
`console.error` carrying the stable marker `VOICE_LINE_HELD` and a JSON record
(`callId`, `attempts`, `startedAt`, `releaseAt`, `heldSeconds`, `silenced`);
the eventual release logs `VOICE_LINE_RELEASED_BY_CAP`, or a `console.warn` if
the provider closes the session first. A lost or never-opened monitor logs its
close code. Alert on the `VOICE_LINE_` markers in the web pod logs; the API key
and provider payloads never appear in any of these lines.

`OPTIONS` answers the same typed 404 as the profile API while the feature is
disabled or the handle is malformed, before any origin decision. Replies are capped at 350 output tokens (voice
800). The text model is the configured AI profile named by
`IOLAUS_PUBLIC_ASSISTANT_PROFILE` (default `cheap`); voice uses
`IOLAUS_PUBLIC_ASSISTANT_REALTIME_MODEL` (default `gpt-realtime-1.5`) and
`IOLAUS_PUBLIC_ASSISTANT_VOICE` (default `ash`) directly against OpenAI with
the dedicated key. Errors use `{ "apiVersion": 1, "error": { "code":
"ASSISTANT_UNAVAILABLE", "message": "…" } }` with 400/403/404/413/415/429/502/503.

## Static-site consumer

```js
const endpoint = new URL('/api/public/v1/profiles/avery-example', apiOrigin);
const response = await fetch(endpoint, { credentials: 'omit', cache: 'no-store' });
const payload = await response.json();
if (response.status === 404 && payload.apiVersion === 1 &&
    payload.error?.code === 'PROFILE_UNAVAILABLE') {
  // Build a neutral unavailable page, removing previously published content.
} else if (!response.ok) {
  throw new Error('Publication check failed'); // Preserve the healthy deployment.
} else {
  const published = publicProfileApiSchema.parse(payload); // Or JSON Schema validator.
  const pdfUrl = new URL(published.links.pdf, endpoint.origin);
  // Escape public text. Build only when revision differs from deployed metadata.
}
```

Publishing replaces the current immutable snapshot. Private edits and newly
prepared previews remain invisible until explicitly published. Withdrawal or
account deletion makes subsequent API reads unavailable; it cannot revoke a
previously downloaded copy. Static consumers must fetch again immediately
before promotion, serialize promotions, and ensure an older build cannot
replace newer content. A typed unavailable result should publish a neutral
page; timeouts, 5xx, invalid JSON/schema, or generic 404 must fail the sync and
preserve the last healthy deployment. Polling intervals are intentions rather
than guaranteed removal deadlines: runner queues and third-party copies can
delay removal. Provide a manual rebuild/withdrawal procedure in each consumer.

Use synthetic fixtures in source history. Keep generated personal snapshots
out of repositories, build logs, and PR previews. No new infrastructure,
original PDF exposure, or runtime credentials are needed.
