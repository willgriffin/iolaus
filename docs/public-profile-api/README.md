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
