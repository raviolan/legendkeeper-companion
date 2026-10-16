# LegendKeeper Companion MCP

A private, read-only MCP server for one LegendKeeper account. It keeps the local STDIO integration and adds an OAuth-protected Cloudflare Worker endpoint at `/mcp`.

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

   Fill the three empty JSON values in the editor and save. Do not use `.dev.vars` or `.env` as the production secret input: those contain local settings and possibly local OAuth credentials. The production input file is Git-ignored. Never paste secret values into commands, chat, or source code.

   When explicitly ready to publish, run:

   ```sh
   npx wrangler deploy --config wrangler.jsonc --env="" --secrets-file .secrets.production.json
   ```

   This command **publishes** the Worker and configures its secrets. It uses the top-level production configuration, including the existing `OAUTH_KV` namespace. The `secrets.required` list guards against missing secret names. Local `.dev.vars`/`.env` values are development inputs, not deployed runtime bindings. `ALLOWED_GITHUB_USER_ID` and `MCP_BASE_URL` are ordinary configuration. Remove the production secret input after a successful deployment or keep it only in approved private storage.

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
- Rotate/revoke the LegendKeeper API key in LegendKeeper, then replace the Cloudflare `LEGENDKEEPER_API_KEY` secret.

## Security and tool surface

The remote server exposes exactly `search_campaign`, `list_pages`, and `read_page`. All are marked read-only. OAuth uses authorization code with PKCE, the provider's browser-bound consent helpers, a GitHub OAuth identity check, and a numeric user-ID allowlist. The API handler checks the validated token audience, allowlisted user, and `mcp:read` scope for each MCP request. The MCP route is unavailable without a valid OAuth access token. No write, update, or delete tools are registered.

## MCP protocol compatibility

The Worker uses `agents` 0.28.1 and `@modelcontextprotocol/server` 2.3.1. Its handler explicitly enables `legacy: 'stateless'`, the [official compatibility mode](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) for published 2025 clients alongside MCP 2026-07-28. Setting `legacy: 'reject'` disables that lane and causes Inspector 2.11.0's `2025-11-25` initialization to fail with -32022. No protocol headers or response bodies are rewritten by application code. These three read-only tools need no sessionful server-to-client requests.

Retest in two terminals: `npm run dev` and `npm run inspector:remote`. Select Streamable HTTP, connect to `http://localhost:8787/mcp`, and complete OAuth. Confirm initialization negotiates `2025-11-25`, then use List Tools and check for `search_campaign`, `list_pages`, and `read_page`. OAuth completion alone does not verify MCP compatibility.

`node --test tests/mcp-protocol.test.mjs` bundles the actual Worker with a test-only authorization fixture, in-memory KV, and a Cloudflare entrypoint class stub. It exchanges a PKCE authorization code for a real provider-issued token, checks unauthenticated rejection, initializes with Inspector's protocol, sends the initialized notification, and lists all three read-only tools. It also checks modern discovery. It does not open a browser, contact GitHub/LegendKeeper, or run workerd.

## Debugging LegendKeeper reads locally

The Worker passes a fetch wrapper to SDK 4.1.0 so the SDK's `config.fetch(...)` invocation preserves the Cloudflare global receiver. The SDK uses Web fetch/AbortSignal APIs; enabling Node compatibility is not needed for this read fix. The default endpoint is `https://www.legendkeeper.com`, with project discovery before resource reads.

For safe diagnostics, add `MCP_DEV_DIAGNOSTICS=true` to your private `.dev.vars`, stop Wrangler with Ctrl-C, then run `npm run dev`. In a second terminal run `npm run inspector:remote`, reconnect through OAuth, and call `list_pages` with `{"limit":1}`. Confirm it returns actual pages. Diagnostics only activate on localhost origins and require this explicit flag; production-facing tool errors stay generic. They report an allowlisted error type, cause type, HTTP status, a synthesized message, and a boolean indicating whether the API key binding exists. They never log raw SDK error messages, bodies, URLs, keys, or campaign content.

If a call still fails, share only the JSON line whose `event` is `legendkeeper_read_error`. HTTP 401 suggests an invalid/revoked LegendKeeper key; 403 suggests access restrictions; a connection error without a status suggests runtime/network/TLS/timeout failure; a project-resolution diagnostic means the SDK could not find exactly one project for the key. Keep the working LegendKeeper key in `.dev.vars` as `LEGENDKEEPER_API_KEY` (STDIO loads `.env` separately). Disable diagnostics again with `MCP_DEV_DIAGNOSTICS=false`.

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
