# LegendKeeper Companion MCP

A private, read-only MCP server with isolated LegendKeeper credentials for two authorized people. GitHub uses your existing account key; optional Google sign-in uses a separate key for your husband. It keeps the local STDIO integration and adds an OAuth-protected Cloudflare Worker endpoint at `/mcp`.

The remote Worker uses Cloudflare's `OAuthProvider` 1.x in a combined authorization-server/resource-server deployment. GitHub authenticates the human user; only the configured numeric GitHub user ID is allowed. The Worker uses a separate LegendKeeper API key for upstream reads. The ChatGPT access token is never sent to LegendKeeper.

## Local STDIO server

The existing local server remains available through `npm start` and `npm run inspector`. It reads `LEGENDKEEPER_API_KEY` from `.env` using Node's `--env-file-if-exists`; keep `.env` private and do not commit it.

The local and remote transports share the read-only tool registrations in `src/legendkeeper-tools.mjs`.

## Install and typecheck

Use Node.js 24 or newer. From the project directory:

```sh
npm install
npm run typecheck
npm test
```

`npm install` installs the Worker dependencies and refreshes `package-lock.json`. The Worker uses Wrangler's current JSONC configuration and generated Worker types.

## Local Worker and OAuth test

1. Copy the example local Worker variables and edit the copy on your machine:

   ```sh
   cp .dev.vars.example .dev.vars
   ```

   Fill in `LEGENDKEEPER_API_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and your numeric `ALLOWED_GITHUB_USER_ID`. Keep `.dev.vars` private; it is ignored by Git. Do not put credentials in `wrangler.jsonc`.

   Keep `MCP_BASE_URL=http://localhost:8787` in `.dev.vars` for local runs. `wrangler.jsonc` intentionally retains the production URL; without this local override, the Worker's canonical-origin check rejects requests to localhost with HTTP 421. Restart `npm run dev` after changing `.dev.vars`.

2. Find your immutable numeric GitHub user ID. For example, if `jq` is installed:

   ```sh
   curl -fsSL https://api.github.com/users/YOUR_GITHUB_USERNAME | jq -r .id
   ```

   Confirm that the returned number is your account before putting it in `.dev.vars`.

3. In GitHub, create a **GitHub OAuth App** for local testing. Set its Authorization callback URL to:

   ```text
   http://localhost:8787/callback
   ```

   The local redirect is for development only. The app's client ID and client secret go in `.dev.vars`; do not paste them into chat or source files. GitHub permits the localhost HTTP callback for local development.

4. Start the Worker:

   ```sh
   npm run dev
   ```

   The local OAuth issuer and MCP URL are `http://localhost:8787` and `http://localhost:8787/mcp`. Wrangler uses a local KV emulator for the `OAUTH_KV` binding; this does not create a Cloudflare KV namespace.

5. Launch the pinned remote Inspector with `npm run inspector:remote`. Test with MCP Inspector. Keep `npm run inspector` for the existing STDIO server. For the Worker, open MCP Inspector and choose a remote **Streamable HTTP** connection to `http://localhost:8787/mcp`. Start OAuth from the inspector, sign into GitHub, and approve the consent page. The GitHub callback must exactly match the local URL above.

6. Verify the tools by calling `search_campaign`, `list_pages`, and `read_page`. To check the protected endpoint without a token, in another terminal run:

   ```sh
   curl -i -X POST http://localhost:8787/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   ```

   It should return `401` with a `WWW-Authenticate: Bearer` challenge pointing to protected-resource metadata. Do not use `curl -v` with credentials.

## Cloudflare and GitHub production setup

These are manual steps for after you have reviewed the implementation. No Cloudflare resource, OAuth app, secret, or deployment has been created by this project change.

1. Log in to Cloudflare Wrangler:

   ```sh
   npx wrangler login
   ```

2. Find the account's `workers.dev` subdomain in the Cloudflare dashboard under **Workers & Pages**. The production endpoint will be:

   ```text
   https://legendkeeper-companion.YOUR_WORKERS_DEV_SUBDOMAIN.workers.dev/mcp
   ```

   Set `MCP_BASE_URL` in `wrangler.jsonc` to the same URL without `/mcp`, for example `https://legendkeeper-companion.example.workers.dev`. This endpoint must be known before setting the GitHub callback URL.

3. Create a KV namespace after logging in:

   ```sh
   npx wrangler kv namespace create OAUTH_KV
   ```

   Copy the returned namespace ID into the `OAUTH_KV` entry in `wrangler.jsonc`, replacing the all-zero local placeholder. The KV namespace holds OAuth grants, codes, and clients. Do not reuse another application's namespace.

4. Create a separate GitHub OAuth App for production (the local and production callbacks differ). Set its Authorization callback URL to the exact HTTPS URL:

   ```text
   https://legendkeeper-companion.YOUR_WORKERS_DEV_SUBDOMAIN.workers.dev/callback
   ```

   This callback depends on the endpoint from step 2, so determine that URL first. Record the OAuth app's client ID and client secret privately. Find and confirm your numeric GitHub user ID as described above.

5. Put the confirmed GitHub user ID in the ordinary `ALLOWED_GITHUB_USER_ID` variable in `wrangler.jsonc`. If you want browser-based MCP clients, set `MCP_CORS_ORIGIN` to that client's exact origin; leave it unset for non-browser clients. The Worker rejects unapproved browser Origins and does not use wildcard CORS.

6. Review and deploy only when ready. The required secrets are `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `LEGENDKEEPER_API_KEY`. Use the **production** GitHub OAuth App credentials. The first deployment can upload code and all secrets together using Wrangler's [documented `--secrets-file` mechanism](https://developers.cloudflare.com/workers/configuration/secrets/), avoiding a partially configured public Worker:

   ```sh
   npm run typecheck
   npm test
   cp .secrets.production.example.json .secrets.production.json
   chmod 600 .secrets.production.json
   open -e .secrets.production.json
   ```

   For GitHub-only deployment, fill the three existing GitHub/LegendKeeper values and omit the optional `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `LEGENDKEEPER_API_KEY_HUSBAND` entries. For two-user deployment, fill all six entries with the matching production credentials; never upload empty placeholder values. Do not use `.dev.vars` or `.env` as the production secret input: those contain local settings and possibly local OAuth credentials. The production input file is Git-ignored. Never paste secret values into commands, chat, or source code.

   When explicitly ready to publish, run:

   ```sh
   npx wrangler deploy --config wrangler.jsonc --env="" --secrets-file .secrets.production.json
   ```

   This command **publishes** the Worker and configures its secrets. It uses the top-level production configuration, including the existing `OAUTH_KV` namespace. The unchanged `secrets.required` list guards the existing GitHub-only configuration. Google additionally needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `LEGENDKEEPER_API_KEY_HUSBAND`; these optional names are in the template, and runtime authorization fails closed if the selected identity’s key is absent. Local `.dev.vars`/`.env` values are development inputs, not deployed runtime bindings. `ALLOWED_GITHUB_USER_ID` and `MCP_BASE_URL` are ordinary configuration. Remove the production secret input after a successful deployment or keep it only in approved private storage.

7. Check OAuth and MCP after secrets are present:

   ```sh
   curl -i https://legendkeeper-companion.YOUR_WORKERS_DEV_SUBDOMAIN.workers.dev/.well-known/oauth-protected-resource/mcp
   curl -i https://legendkeeper-companion.YOUR_WORKERS_DEV_SUBDOMAIN.workers.dev/.well-known/oauth-authorization-server
   ```

   The exact discovery path can be advertised by the protected-resource metadata. An unauthenticated `/mcp` request must return `401` with its metadata challenge. For end-to-end auth, use MCP Inspector's remote Streamable HTTP connection to the HTTPS `/mcp` URL, authorize through GitHub, confirm the consent screen, and call all three read-only tools. The callback, issuer, metadata, and MCP endpoint must all use the same production hostname.

8. In ChatGPT web, use **Settings → Apps → Create** (or your workspace's custom app settings), provide the HTTPS `/mcp` endpoint, and choose OAuth. Complete authorization with the allowlisted GitHub account. As of October 2026, custom MCP app availability varies by plan and workspace: full developer-mode MCP is available for Business, Enterprise, and Edu, while Pro supports read/fetch use in developer mode. Check [OpenAI's current MCP app instructions](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) for current access and UI details.

## Credential rotation and revocation

- Replace a Cloudflare secret with `npx wrangler secret put SECRET_NAME`; use the interactive prompt. Replacing `LEGENDKEEPER_API_KEY` requires a valid new LegendKeeper key. Replacing the GitHub client secret requires updating the corresponding GitHub OAuth App secret first.
- Revoke OAuth grants/tokens through the revocation endpoint advertised in the authorization-server metadata (the provider implements revocation alongside its configured token endpoint), or delete the associated OAuth KV data if you intentionally want to invalidate every grant. Do not delete the KV namespace casually; it contains active authorization state.
- To revoke the upstream GitHub app, remove it from your GitHub account's **Settings → Applications → Authorized OAuth Apps** and/or delete the OAuth App. That prevents future identity checks; also revoke server-issued grants if they should stop working immediately.
- Rotate/revoke each LegendKeeper API key in its own account, then replace only its matching Cloudflare secret: `LEGENDKEEPER_API_KEY` for GitHub or `LEGENDKEEPER_API_KEY_HUSBAND` for Google.

## Security and tool surface

The remote server exposes exactly `search_campaign`, `list_pages`, and `read_page`. All are marked read-only. OAuth uses authorization code with PKCE, the provider's browser-bound consent helpers, a GitHub numeric-ID allowlist or Google OIDC verified-sub allowlist. Each authorized identity is bound to its own LegendKeeper key, with no credential fallback. The API handler checks the validated token audience, allowlisted user, and `mcp:read` scope for each MCP request. The MCP route is unavailable without a valid OAuth access token. No write, update, or delete tools are registered.

## MCP protocol compatibility

The Worker uses `agents` 0.28.1 and `@modelcontextprotocol/server` 2.3.1. Its handler explicitly enables `legacy: 'stateless'`, the [official compatibility mode](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) for published 2025 clients alongside MCP 2026-07-28. Setting `legacy: 'reject'` disables that lane and causes Inspector 2.11.0's `2025-11-25` initialization to fail with -32022. No protocol headers or response bodies are rewritten by application code. These three read-only tools need no sessionful server-to-client requests.

Retest in two terminals: `npm run dev` and `npm run inspector:remote`. Select Streamable HTTP, connect to `http://localhost:8787/mcp`, and complete OAuth. Confirm initialization negotiates `2025-11-25`, then use List Tools and check for `search_campaign`, `list_pages`, and `read_page`. OAuth completion alone does not verify MCP compatibility.

`node --test tests/mcp-protocol.test.mjs` bundles the actual Worker with a test-only authorization fixture, in-memory KV, and a Cloudflare entrypoint class stub. It exchanges a PKCE authorization code for a real provider-issued token, checks unauthenticated rejection, initializes with Inspector's protocol, sends the initialized notification, and lists all three read-only tools. It also checks modern discovery. It does not open a browser, contact GitHub/LegendKeeper, or run workerd.

## Debugging LegendKeeper reads locally

The Worker passes a fetch wrapper to SDK 4.1.0 so the SDK's `config.fetch(...)` invocation preserves the Cloudflare global receiver. The SDK uses Web fetch/AbortSignal APIs; enabling Node compatibility is not needed for this read fix. The default endpoint is `https://www.legendkeeper.com`, with project discovery before resource reads.

For safe diagnostics, add `MCP_DEV_DIAGNOSTICS=true` to your private `.dev.vars`, stop Wrangler with Ctrl-C, then run `npm run dev`. In a second terminal run `npm run inspector:remote`, reconnect through OAuth, and call `list_pages` with `{"limit":1}`. Confirm it returns actual pages. Diagnostics only activate on localhost origins and require this explicit flag; production-facing tool errors stay generic. They report an allowlisted error type, cause type, HTTP status, a synthesized message, and a boolean indicating whether the API key binding exists. They never log raw SDK error messages, bodies, URLs, keys, or campaign content.

If a call still fails, share only the JSON line whose `event` is `legendkeeper_read_error`. HTTP 401 suggests an invalid/revoked LegendKeeper key; 403 suggests access restrictions; a connection error without a status suggests runtime/network/TLS/timeout failure; a project-resolution diagnostic means the SDK could not find exactly one project for the key. Keep your GitHub account’s key in `.dev.vars` as `LEGENDKEEPER_API_KEY` and your husband’s Google account key as `LEGENDKEEPER_API_KEY_HUSBAND` (STDIO still loads only `LEGENDKEEPER_API_KEY` from `.env`). Diagnostics describe the current request’s selected key binding without logging its value. Disable diagnostics again with `MCP_DEV_DIAGNOSTICS=false`.

## Production review and remaining verification

The configured Worker is `legendkeeper-companion`, with issuer `https://legendkeeper-companion.pink-void.workers.dev`, resource URL ending in `/mcp`, GitHub callback ending in `/callback`, allowlisted GitHub ID `180304956`, and one `OAUTH_KV` namespace. Confirm that ID belongs to the intended account and that the namespace belongs to the authenticated deployment account. No resources or secrets are created by the review tests.

Production diagnostics are explicitly false and additionally blocked on non-localhost hosts. Production CORS stays unset: server-to-server MCP requests without an Origin are accepted; unapproved browser Origins are rejected. Do not add a wildcard to troubleshoot ChatGPT. If a deployed client sends an Origin and receives 403, inspect its exact Origin before considering an explicit allowed origin. Anonymous OPTIONS may return preflight metadata but cannot run tools.

The production GitHub OAuth App callback must be exactly `https://legendkeeper-companion.pink-void.workers.dev/callback`. This is separate from ChatGPT's client redirect URL, which is registered through the provider. Grant `mcp:read` and requested `offline_access` on the consent screen for refresh access. The provider advertises PKCE S256, authorization-code and refresh-token grants, and stores encrypted grant properties in KV; the Worker checks audience, scope and GitHub identity on every authenticated MCP request. Access tokens last one hour and refresh tokens up to 30 days. Revoke server grants as well as GitHub access when revoking a client.

After deployment, check:

```sh
curl -i https://legendkeeper-companion.pink-void.workers.dev/.well-known/oauth-protected-resource/mcp
curl -i https://legendkeeper-companion.pink-void.workers.dev/.well-known/oauth-authorization-server
curl -i -X POST https://legendkeeper-companion.pink-void.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect HTTPS production metadata and a 401 Bearer challenge for the unauthenticated tool request. Then connect Inspector to the production HTTPS `/mcp` endpoint, complete OAuth, confirm initialization, list all three tools, call each with real campaign inputs, and verify refresh access. Repeat the connection from ChatGPT. Reject a non-allowlisted GitHub account. Only these deployed checks establish actual production behavior.

`.env`, `.dev.vars`, their environment-specific variants, and `.secrets.production.json` are ignored. This workspace currently has no Git repository metadata, so previously tracked files/history cannot be audited here; before any future push, verify no credential file is tracked. Ignoring a file does not untrack it or prevent explicit upload via `--secrets-file`.

## Inspector production Origin troubleshooting

The plain-text `Origin not allowed` response comes from the Worker's own origin middleware, before OAuth and `createMcpHandler`. Cloudflare's inner handler uses a separate hostname check. The production configuration deliberately does not assume an Inspector browser origin; `.dev.vars` only configures the local Worker.

Determine the actual request first: in Inspector's browser, open Developer Tools → Network, retry the connection, select the failed request to the Worker (or its OPTIONS preflight), then read **Request Headers → Origin**. The Inspector page URL is only a clue: a proxy may forward a different Origin. If a local proxy hides the outbound request, use Inspector's network report to read the forwarded Origin; a proxy response alone does not establish which Origin the Worker received. Share only the Origin value, HTTP status, and plain error text—never Authorization, cookies, complete callback URLs, HAR exports, or Copy as cURL output containing tokens.

Once confirmed, add only that HTTP(S) origin to `wrangler.jsonc` under `vars.MCP_CORS_ORIGIN`. For example, **only if the captured Origin equals it**, use `"MCP_CORS_ORIGIN": "http://localhost:6274"`. If you actually use both browser origins, the explicitly configured value may be `"http://localhost:6274,http://127.0.0.1:6274"`. No loopback origins, ports, or schemes are implicitly authorized. No wildcard is supported. A single origin in existing `.dev.vars` continues to work.

The outer middleware matches exact origins, including scheme and port. The Cloudflare handler receives the corresponding hostnames plus a single CORS response origin chosen from the validated request. Responses vary on Origin. Preflight allows POST and supported MCP headers; it returns metadata without granting tool access. Bearer tokens, audience, scope, and GitHub allowlisting are still required for initialization and tool requests.

After editing the confirmed value and reviewing it, run:

```sh
npm run typecheck
npm test
npx wrangler deploy --config wrangler.jsonc --env=""
```

The last command deploys and uses the existing Cloudflare secrets; do not upload development env files. It has not been run as part of this fix. Retry Inspector against `https://legendkeeper-companion.pink-void.workers.dev/mcp`, complete OAuth, verify initialization and all three tools. Before declaring production fixed, verify an unapproved origin still receives 403 and a configured origin without a token receives 401. A successful OPTIONS request alone does not establish MCP authentication.

## OAuth consent POST with an opaque Origin

MCP Origin/CORS validation applies only to `/mcp` and `/mcp/...`, matching the provider's protected route boundary. It does not gate the OAuth `/authorize` form. A browser can submit that legitimate form with `Origin: null`; the provider validates the hidden consent handle, its matching Secure/HttpOnly/SameSite=Lax `__Host-` browser cookie, and the short-lived server-side transaction through `approveConsent()` or `denyConsent()`. Consent handles are consumed before beginning upstream login. Missing, forged, mismatched, expired, and replayed state fails locally without redirecting to GitHub. Fetch metadata headers are not trusted as authentication or CSRF evidence.

The canonical HTTPS origin check remains global. The GitHub callback still requires provider-validated upstream state and its browser cookie, followed by GitHub identity allowlisting; client and upstream PKCE remain unchanged. This fix neither adds `null` to `MCP_CORS_ORIGIN` nor changes which browser origins may access MCP. Unknown routes remain unavailable. See the provider's [documented consent protections](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md).

For the confirmed `/authorize` POST failure, no new Inspector origin setting is needed. Review and redeploy the code with `npx wrangler deploy --config wrangler.jsonc --env=""`, then restart authorization from the client to obtain fresh consent state. The expected Allow response is a 302 redirect to GitHub, followed by the existing callback and token flow. Separately inspect an actual `/mcp` request's Origin if that endpoint reports an Origin error after authorization.

## Consent CSP and dynamically registered client redirects

The consent form posts to `/authorize` on the Worker. After approval the redirect chain is GitHub → Worker `/callback` → the provider-validated client redirect URI. If GitHub immediately redirects an already signed-in/authorized user, Chrome may enforce the original consent document's `form-action` across the entire chain, including a dynamically registered client's callback. That destination is not confined to GitHub or this Worker. A CSP violation naming the original form action does not alone identify which redirect hop was blocked; see [MDN's redirect behavior note](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action).

The consent document omits `form-action`, matching the provider's [official consent header pattern](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md). It retains `default-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, and all other security headers. The provider's initial anti-framing CSP is replaced using `Headers.set`, preserving its framing restriction and avoiding intersecting policies. No CSP meta tag, callback-domain list, or wildcard source is added. Error pages, which have no forms or OAuth navigation, retain `form-action 'self'`. MCP Origin/CORS settings are unchanged.

Security tradeoff: `default-src` does not restrict form destinations. Omitting `form-action` removes defense against exfiltration through injected forms; it is not a domain allowlist. The consent template therefore keeps a fixed local action, escapes all client-controlled metadata, disallows a base URI, and blocks scripts and other content by default. Cloudflare's actual consent handle/cookie validation, one-use transactions, PKCE, browser-bound upstream state, exact registered redirect validation, and GitHub identity checks remain essential. Redirects and grants come from provider-validated server-side state, never from posted client IDs or redirect URIs. Removing this directive does not authorize arbitrary redirects on the server or grant anonymous MCP access.

Tests exercise actual dynamic registration, the consent POST, browser-bound upstream callback, registered-client return, PKCE code exchange, and authenticated MCP initialization using the bundled Worker and in-memory KV, with only GitHub HTTP calls mocked. They check two different registered callback origins, reject a substituted unregistered redirect, missing upstream cookies, wrong PKCE verifiers, replayed state/consent, and unapproved MCP origins. They also assert the emitted CSP retains content/framing restrictions and has no form-action directive. These are not browser CSP execution tests or deployed ChatGPT verification.

After reviewing the fix, deploy using `npx wrangler deploy --config wrangler.jsonc --env=""`. Start a fresh ChatGPT authorization: earlier blocked redirects may already have consumed consent/state. In Chrome check the consent GET has one CSP, no form-action in either response headers or HTML, and no independently injected Cloudflare CSP. Click Allow once; test both an already-authorized GitHub session and a fresh GitHub login, then confirm return to the client, successful MCP initialization, and real tool reads. Test Deny as well, since it also returns directly to a dynamic client URI. Keep DevTools traces private: callback queries, cookies and tokens must not be shared.

## Reading full character profiles

SDK 4.1.0's `documents.list()` returns `Promise<Page>`, so `read_page` first awaits it, then iterates the Page. Iterating the Promise caused a TypeError before any document blocks were read. Earlier unit mocks returned an async generator directly and missed that contract mismatch. The official [pagination and documents guide](https://www.legendkeeper.com/developers/guide/) confirms this pattern. `resources.get()` normally includes document summaries, but the reader independently enumerates `documents.list()` and does not depend on every resource having that field.

`documents.list()` returns the complete collection in one Page in this SDK version; Page iteration handles continuation where supported. `getBlocks({resourceId, documentId})` returns the whole page tree and its server-rendered `text`, including multiple text-bearing blocks. It has no block cursor. Page and blank documents are readable; blank reads do not convert document types. Map, board, time and unknown types are returned in `skippedDocuments` with their identifiers, names and types rather than claimed to be empty text. A genuinely empty document has `text: ""`; absent or malformed text produces a sanitized error. A failed document read returns an error, never successful partial biography content.

To verify a real character safely, obtain its resource ID from `list_pages`, then run on your machine:

```sh
node --env-file-if-exists=.env --env-file-if-exists=.dev.vars scripts/check-read-page.mjs RESOURCE_ID
```

Replace `RESOURCE_ID` with that character's ID. The probe uses the same read-only handler as STDIO and the Worker. It prints only success, document counts, and whether an Overview exists and has text, plus sanitized error diagnostics if necessary. It does not print IDs, names, private text, keys, or raw responses. Localhost diagnostics now include an allowlisted failing operation (`resources.get`, `documents.list`, or `documents.getBlocks`). Production diagnostics remain disabled. To inspect the actual biography locally, call `read_page` in your authenticated local Inspector; keep its output private.

After reviewing and running the probe, redeploy with `npx wrangler deploy --config wrangler.jsonc --env=""`, then verify `read_page` for that same resource through authenticated ChatGPT. Tests and a successful mock response do not establish production content retrieval.

## Optional second user with Google sign-in

See [Google sign-in setup and verification](GOOGLE_SIGN_IN.md) for the exact Google Cloud client type and callbacks, consent configuration, secrets, verified-sub discovery, compatibility details, and live-check limits. GitHub and the production configuration remain unchanged until a separately approved rollout.

## Two isolated LegendKeeper accounts on the same Worker

The remote endpoint is shared, but credentials and SDK clients are isolated per request:

| Verified OAuth principal | LegendKeeper secret | Accessible content |
| --- | --- | --- |
| GitHub ID `180304956` | Existing `LEGENDKEEPER_API_KEY` | Your key’s account/project only |
| Google `ALLOWED_GOOGLE_SUB` | New `LEGENDKEEPER_API_KEY_HUSBAND` | Your husband’s key’s account/project only |

After Cloudflare validates the bearer token, `resolveMcpPrincipal` checks the token context’s user ID, encrypted identity props, current allowlist, exact `/mcp` audience, and `mcp:read` scope. Only then does the API handler select the matching secret and construct a new LegendKeeper SDK client. The SDK resolves its project using that same key. OAuth tokens hold identity, never LegendKeeper keys. Neither tool arguments, resource IDs, email addresses, request headers, nor query parameters select credentials. A missing assigned key returns HTTP 503 before any LegendKeeper request; the other key is never tried. Legacy GitHub grants continue to work unchanged. No global SDK client, shared project cache, or mutable credential state is introduced.

All three tools (`search_campaign`, `list_pages`, `read_page`) use this request’s SDK instance. Supplying a foreign resource ID still sends the caller’s own key and project to LegendKeeper; a resource outside that key’s permissions is inaccessible. Search terms and pagination cursors cannot change this credential binding. As before, the actual accessible project/content is governed by the permissions of the correctly configured LegendKeeper key. Verify the two secrets belong to the intended separate accounts/projects; the Worker cannot infer an account owner from a secret’s variable name.

The example production secret file now lists all six names with empty placeholders; the real ignored `.secrets.production.json` has not been changed. For the existing live Worker, do not bulk-upload that template or replace the working GitHub key. After local verification and separate approval, add only the three new secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LEGENDKEEPER_API_KEY_HUSBAND`) using private Cloudflare secret entry, configure `ALLOWED_GOOGLE_SUB`, and review deployment separately. `wrangler.jsonc`, production infrastructure, and live secrets remain unchanged by this implementation.

To verify without sharing campaign data, first run `npm test` and `npm run typecheck`; all automated accounts, keys, IDs, and page contents are synthetic, with no live requests. The suite checks both actual OAuth flows, refresh, all three tools, foreign IDs/cursors, spoofed credential hints, missing credentials, and concurrent users on one Worker/KV store.

For private live verification before deployment, follow [the local two-account procedure](GOOGLE_SIGN_IN.md#test-both-accounts-privately-before-deployment). Keep real keys only in ignored local environment files, keep diagnostic logging disabled, and inspect results only on your own computer. The procedure records pass/fail outcomes rather than exporting campaign responses, names, IDs, browser traces, or tokens. Real Google credentials and both LegendKeeper keys are needed to verify upstream permissions; the automated suite alone cannot establish the ownership of real keys.

## Editing pages (SDK 4.1.0)

The existing `/mcp` endpoint and read tools remain available. Six additional tools are registered. IDs always distinguish a resource (page in the hierarchy) from a document (tab inside that resource). All schemas reject extra fields on the new tools.

| Tool | Inputs | Effect |
| --- | --- | --- |
| `read_document_blocks` | `resourceId`, `documentId` | Read full rich block tree, block IDs, text and version. Requires `mcp:read`. |
| `append_page` | `resourceId`, `documentId`, `expectedVersion`, `content` | Atomically append one hidden-title text container containing new paragraphs. Preserves existing blocks and other tabs. |
| `edit_page_block` | `resourceId`, `documentId`, `expectedVersion`, `blockId`, `content` | Patch the text runs of exactly one paragraph, heading or quote. Replaces formatting inside its text runs; preserves block kind, children and unrelated content. |
| `replace_page_content` | `resourceId`, `documentId`, `expectedVersion`, `mode: "replace_entire_document"`, `content` | Destructively replace only this tab with plain-text paragraphs. Requires an explicit user replacement request. Never an append/edit fallback. |
| `create_page` | `name`; optional `parentId`, `content`, `tags`, `aliases` | Atomically create a resource and one Overview page document with initial content. |
| `update_resource` | `resourceId`; any of `name`, `tags`, `aliases` | Patch only supplied metadata fields. Tags/aliases replace the respective arrays; `[]` clears them. No moving or deletion. |

IDs are nonempty strings up to 128 characters; versions up to 256. Content is a nonempty plain-text string up to 100,000 characters. Names and aliases are 1–500 characters; tags and aliases have at most 100 entries. Blank-line separators create multiple paragraphs in append, create and replacement. Content is not Markdown or HTML; rich text is read intact but new rich formatting is not exposed in this first implementation. Replacement cannot clear a document to an empty string.

Inspect blocks first and pass the returned version as `expectedVersion`. Before writing, the server retrieves the resource, document type and latest blocks. Stale input fails before mutation; every document mutation also sends `If-Match` to close the read/write race. A 412 means read again, review changes and retry deliberately. Missing/duplicate block IDs and unsupported block kinds fail safely. No automatic ID assignment, whole-document edit fallback, deletion, or moving is exposed. Unsupported blocks remain untouched during append/edit. Full replacement intentionally removes old content and may be refused by upstream protection of hidden/admin-only content.

SDK 4.1.0 supports atomic block insert/update and document replacement, as verified against its installed types, implementation and bundled OpenAPI contract and the [official SDK guide](https://www.legendkeeper.com/developers/guide/). Resource metadata updates have no `If-Match` support: patches preserve omitted fields, but simultaneous changes to the same name/tags/aliases field can overwrite each other. Create plus initial documents is one request; no partial resource creation followed by a content write. SDK retries are disabled in both server entrypoints. On a timeout or unknown failure, inspect the target before retrying to avoid duplicate content/resources. Successful responses include affected IDs and resulting blocks/version or resource metadata; use a fresh inspection to verify persisted content.

### Write authorization and reconnecting

Remote reads still require `mcp:read`. Every write handler additionally requires `mcp:write` from the provider-validated token context; arguments cannot grant it. Identity allowlists, audience validation, per-user secret selection, browser-origin checks and refresh-token handling remain in place. Write tools are visible to read-only clients but execution is denied before SDK access. Mutations carry MCP annotations; content/metadata replacement is marked potentially destructive.

Clients must request `mcp:read mcp:write` (plus `offline_access` for refresh access). The consent screen offers write access only when requested, unchecked by default, and explains that it permits creation, editing and replacement. Read-only consent remains available. Existing read-only tokens and refresh grants do not acquire write access automatically. Reconnect or reauthorize the ChatGPT connector with the write scope; if its existing grant persists, remove/re-add the connection using the same endpoint, then complete fresh consent. A refresh token cannot elevate its original scopes.

Local STDIO stays read-only by default. Explicitly set `LEGENDKEEPER_ENABLE_WRITES=true` in the private `.env` to enable its write handlers. STDIO uses possession of the local API key, not remote OAuth. Never put keys or tokens in prompts, tracked files, command arguments, or shared traces.

### Review and deployment

No production deployment, live secret change or live LegendKeeper write was performed for this upgrade. Preserve the existing Worker configuration, KV and secrets. After review and explicit deployment approval, from the repository root run:

```sh
npm install
npm run typecheck
npm test
npx wrangler deploy --config wrangler.jsonc --env=""
```

This updates the existing Worker at `https://legendkeeper-companion.pink-void.workers.dev/mcp`; do not create a second Worker or bulk-upload secret templates. No new secrets are needed for write scopes. Existing uncommitted Google sign-in/account-isolation work is preserved in this workspace and must be reviewed as part of any deployment from this tree.

Connect Inspector using Streamable HTTP, complete fresh OAuth, initialize and list tools: expect nine including the original three. Test a read-only token's write denial, then a write-enabled token in a controlled document. Repeat discovery from ChatGPT after reauthorization; see the [official OpenAI custom MCP guidance](https://developers.openai.com/api/docs/guides/custom-mcp-server). ChatGPT write-tool availability depends on its plan/workspace/client restrictions; local tests and deployment alone do not verify ChatGPT editing. Do not bypass those restrictions.

For authorization failures, check requested/granted scopes, allowlisted identity and exact `/mcp` audience; keep the existing origin policy. A scope denial is different from upstream LegendKeeper permission failure. For SDK failures, check the API key's project and edit permissions privately; member keys may need a writable parent to create pages. Public errors deliberately omit raw upstream bodies and credentials. A conflict requires a fresh read, not blind retries.

### Perrin Quade manual verification (live writes require separate approval)

1. Search for Perrin Quade and confirm resource `ng9bwvqp` in the Memory Market hierarchy. Call `read_page` and confirm Overview `iipp4vpj`, General `fkxt16w5`, At the Market `l1gvpd6a`. Never replace the Overview.
2. Inspect each document with `read_document_blocks`; privately retain versions and full block trees. These are reads only. Confirm At the Market's current state rather than assuming it is still empty.
3. Prepare an append to `{ "resourceId": "ng9bwvqp", "documentId": "l1gvpd6a", "expectedVersion": "<fresh inspected version>", "content": "Companion verification marker <unique value>" }`. Obtain explicit approval before executing it, including the cleanup approach below.
4. After approval, append once, then inspect At the Market again. Confirm exactly one new container with the marker, and unchanged preexisting blocks. Reinspect Overview and General and compare their content to the saved reads. Record only pass/fail outside private local inspection.
5. Cleanup: delete only the returned appended container in the LegendKeeper UI after confirming its ID/content. No MCP deletion tool is exposed. Do not restore a whole old snapshot, since that could overwrite intervening manual edits. Inspect again to confirm the marker is gone and unrelated content remains. Cleanup is a manual step requiring access to the LegendKeeper editor.

Automated tests use synthetic SDK HTTP responses and in-memory OAuth KV, including the reference resource/document IDs; they never modify this live resource. Live permission checks, production refresh behavior and ChatGPT discovery/execution remain manual verification steps.
