# Google sign-in for the second authorized person

Implementation is local and has not been deployed. Production configuration, KV bindings, existing secret values, Git history, and LegendKeeper content are unchanged.

## Google Cloud setup

Create an OAuth 2.0 client with application type **Web application** in Google Auth Platform. This is a server-side authorization-code flow; do not use Desktop, Android, or a browser-only client. Authorized JavaScript origins are unnecessary.

Register these exact Authorized redirect URIs (no trailing slash):

| Environment | Redirect URI |
| --- | --- |
| Production | `https://legendkeeper-companion.pink-void.workers.dev/callback/google` |
| Optional local development and subject discovery | `http://localhost:8787/callback/google` |

Keep the GitHub callback `/callback` and its OAuth application unchanged. Google redirects to the Worker; ChatGPT's redirect URI is validated separately by the Cloudflare OAuth provider. Do not register ChatGPT's callback as a Google callback.

For personal Google accounts, configure **External**, initially **Testing**. Set an app name (e.g. LegendKeeper Companion), support email, and developer contact email. Add the new user's account as a test user (and yours only if testing Google yourself). Internal is appropriate only for accounts within the same Google Workspace organization. Request only **`openid`** in Data Access. Email, profile, Google API scopes, and upstream offline access are unnecessary.

Google exempts basic OIDC-only requests from the usual test-user restriction and seven-day authorization expiry. The test-user list therefore does not make this private: the Worker's exact verified-sub allowlist enforces access. No sensitive/restricted scopes are requested; verification is ordinarily unnecessary for this personal app. Branding/domain requirements or Workspace policy may still apply to your particular project. You can keep the personal app in Testing; publishing it is not needed for the implementation.

References: [Google server OIDC flow](https://developers.google.com/identity/openid-connect/openid-connect), [web application setup and redirects](https://developers.google.com/identity/protocols/oauth2/web-server), [Google audience and Testing exceptions](https://support.google.com/cloud/answer/15549945?hl=en), [personal-use verification exception](https://support.google.com/cloud/answer/13464323?hl=en).

## Configuration names

| Name | Storage | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Cloudflare secret | Google web application client ID |
| `GOOGLE_CLIENT_SECRET` | Cloudflare secret | Google web application client secret |
| `LEGENDKEEPER_API_KEY_HUSBAND` | Cloudflare secret | Husband’s separate LegendKeeper key; used only by the authorized Google identity |
| `ALLOWED_GOOGLE_SUB` | Nonsecret Worker variable | Exactly one verified Google subject, case-sensitive; never an email |
| `GOOGLE_SUB_DISCOVERY` | Optional local variable, default false | Local-only subject inspection; leave absent in production |

Existing `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `LEGENDKEEPER_API_KEY`, `ALLOWED_GITHUB_USER_ID=180304956`, and `MCP_BASE_URL` stay unchanged. No new storage binding or infrastructure is required. Local values go in ignored `.dev.vars`; production credentials belong only in Cloudflare secrets. The example file contains names only.

The husband’s LegendKeeper key must come from his own separate account/project. The existing `LEGENDKEEPER_API_KEY` remains assigned exclusively to GitHub; there is no shared-key mode or fallback.

Google is optional so the current production configuration can still run GitHub alone. The Google selection appears once both Google credentials exist, but no Google grant is issued until `ALLOWED_GOOGLE_SUB` exactly matches. `wrangler.jsonc` is deliberately unchanged: adding the Google secrets, husband’s LegendKeeper secret, and allowlist is a later, separately approved configuration/deployment step. Never put credential values in that file or shell arguments.

## Obtain the husband's verified subject safely

Use local development so production does not need an enrollment mode:

1. Register the localhost Google redirect above. On the computer running the local Worker, fill in ignored `.dev.vars` with the Google client credentials, `MCP_BASE_URL=http://localhost:8787`, `GOOGLE_SUB_DISCOVERY=true`, and an empty `ALLOWED_GOOGLE_SUB`. Keep the existing local GitHub configuration because the consent page retains its existing configuration check. Set `MCP_CORS_ORIGIN` for your Inspector browser origin as documented in README.
2. Run `npm run dev` locally (no `--remote`) and start the MCP Inspector using the existing README instructions against `http://localhost:8787/mcp`. Initiate OAuth from Inspector, approve the read-only scope, and select Google. Do not visit the callback directly: it requires the SDK's valid consent transaction, state, and browser cookie.
3. Have your husband sign into his own Google account in that browser. After validating Google's signature, issuer, audience, expiry, issued-at, and nonce, the local callback displays only **Verified Google sub**. It never issues an MCP grant in discovery mode. An Inspector callback is not expected during this inspection.
4. Copy only that subject into `ALLOWED_GOOGLE_SUB`, turn `GOOGLE_SUB_DISCOVERY=false`, restart the local Worker, set `LEGENDKEEPER_API_KEY_HUSBAND` to his own key in ignored `.dev.vars`, and repeat sign-in to test normal MCP authorization. Never put your key in his secret slot. Do not copy ID tokens, authorization codes, access tokens, client secrets, or browser traces into chat or logs. Do not use JWT decoder websites or email-based enrollment.
5. After review and separate deployment approval, configure that exact nonsecret subject and the two Google secrets plus `LEGENDKEEPER_API_KEY_HUSBAND` for production. Both people then connect independently to `https://legendkeeper-companion.pink-void.workers.dev/mcp`: you select GitHub; he selects Google. Each ChatGPT account authorizes its own MCP client grant.

Discovery requires a loopback base hostname, the explicit flag, and an empty allowlist. A production base URL never displays an unknown subject, even with the flag accidentally enabled. All HTML subject output is escaped, uncached, and uses no-referrer headers. Nothing automatically adds a subject to an allowlist.

## Implementation and compatibility

The existing combined `OAuthProvider` API and installed SDK 1.2.3 are retained. The current [Cloudflare authorization-server reference](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md) and the installed SDK types guide the implementation; no split-server migration or SDK upgrade is needed.

The same `parseAuthRequest`, `describeConsent`, `beginConsent`, `approveConsent`/`denyConsent`, `beginUpstream`, `finishUpstream`, and `completeAuthorization` helpers own consent, redirects, browser cookies, state, client PKCE, and grant issuance. Saved upstream data binds the provider, verifier, and Google nonce to the transaction. Each callback checks the saved provider before exchanging any code; old GitHub transactions without a provider field remain compatible. The fixed Google token and JWKS endpoints cannot be replaced by token-supplied URLs. JOSE validates RS256 signatures and standard claims; the implementation additionally requires the nonce, subject, issued-at, and appropriate authorized party.

Encrypted identity props use `github:<id>` or `google:<sub>`. Existing GitHub numeric user IDs and grants remain compatible. Google SDK user IDs use `google/<percent-encoded-sub>` because SDK 1.2.3 forbids colons in user IDs. Both the SDK user ID and encrypted identity props must agree with the current allowlist; Google subjects can never impersonate legacy numeric GitHub IDs. No upstream identity-provider tokens are persisted. LegendKeeper keys are not stored in OAuth grants or token props.

MCP audience remains the exact canonical `/mcp` URL; `mcp:read` is still required on every request. `offline_access` still controls the MCP provider's refresh-token flow; this does not require a Google refresh token. Removing an allowlisted subject blocks its existing MCP access at the resource guard. Consent CSP, escaped client metadata, exact registered redirects, and existing ChatGPT-compatible form redirect behavior remain intact. The only tools are `search_campaign`, `list_pages`, and `read_page`; there are no write capabilities.

## Verification and remaining live checks

Automated tests exercise the real Cloudflare OAuth SDK and MCP handler with in-memory KV and mocked upstream HTTP. Google tokens are signed with generated RSA keys and validated through the actual JOSE code. Cases cover existing GitHub authorization, allowlisted and unknown Google subjects, missing allowlist, issuer/audience/expiry/nonce/signature failures, unsigned tokens, authorized-party checks, provider substitution in both directions, browser-bound state, replay, client PKCE, refresh rotation, cross-client refresh denial, anonymous requests, audience/scope enforcement, read-only tool exposure, rejected write calls, consent CSP, and registered ChatGPT-style redirects. Local subject discovery is also tested to issue no grant and reveal no tokens.

The additional isolation tests run two OAuth users against the same test Worker and KV store, with separate synthetic LegendKeeper keys/projects. They verify all three tools in both directions, foreign resource IDs/searches/cursors, spoofed identity and credential arguments/headers/query parameters, concurrent requests, refresh identity binding, and missing keys without fallback. Every mock LegendKeeper HTTP call must use GET and the selected identity’s key/project. These tests do not use real campaign data.

Commands: `npm test` and `npm run typecheck`.

Without live Google credentials we cannot verify Cloud Console registration, real Google code exchange/PKCE and JWKS responses, the husband's actual subject, project branding/Workspace restrictions, or real browser sign-in. Node tests verify the registered ChatGPT redirect behavior but cannot reproduce Chrome's redirect-chain CSP enforcement or ChatGPT's full live connector flow. These require a local credentialed test, then an explicitly approved deployment and separate smoke test in each ChatGPT account. No live credentials are needed for the automated suite.

## Identity-to-credential binding

Only the context returned after OAuthProvider validates the MCP bearer token can select credentials. `resolveMcpPrincipal` checks the context’s user ID against its encrypted identity props and the appropriate allowlist, then validates the audience and read scope. The API handler maps the resulting GitHub principal to `LEGENDKEEPER_API_KEY`, or the Google principal to `LEGENDKEEPER_API_KEY_HUSBAND`. Missing or contradictory identity, wrong audience/scope, and unknown users never reach secret selection. Missing assigned credentials return 503 and never use the other person’s key.

A fresh LegendKeeper SDK instance is created for each MCP request with only that selected key. Its project discovery and every read use that same key; there is no global account cache. Inputs select only the search/page/cursor within the caller’s authorized LegendKeeper context. They cannot choose an account. LegendKeeper enforces resource access with the supplied key; the two secrets must actually belong to the intended separate accounts/projects.

## Test both accounts privately before deployment

1. Run `npm test` and `npm run typecheck` for the synthetic, no-network regression suite. Do not substitute real keys or data into test fixtures.
2. On your local machine, configure ignored `.dev.vars` with the existing GitHub identity/key, Google credentials and verified husband’s `sub`, and his separate `LEGENDKEEPER_API_KEY_HUSBAND`. Set `GOOGLE_SUB_DISCOVERY=false`, `MCP_DEV_DIAGNOSTICS=false`, and `MCP_BASE_URL=http://localhost:8787`. Register local OAuth callbacks as described above and in README. Use `npm run dev` without `--remote`; local KV must not use a remote binding.
3. Open separate browser profiles/Inspector OAuth sessions for GitHub and Google, both using the local `/mcp` endpoint. Privately select an existing harmless page in each account; do not modify campaign content. In each session, check `list_pages` with a small limit, `search_campaign` with a harmless known term, and `read_page` for that account’s chosen page. Confirm locally that only the correct account’s results appear. Record only pass/fail, not the returned content.
4. In each session, try `read_page` with the other account’s resource ID, a search for its harmless page, and the other session’s pagination cursor if one exists. The foreign page must be inaccessible, the search must disclose no foreign content, and a foreign cursor must fail or remain within the caller’s account. IDs and cursors stay local; do not paste them here or capture browser network traces. Make requests from both sessions concurrently and verify refresh/reconnect still selects each person’s account.
5. In the local environment only, unset `LEGENDKEEPER_API_KEY_HUSBAND`, restart, and verify Google MCP requests receive 503 while GitHub still works. Restore it, then unset `LEGENDKEEPER_API_KEY` and confirm the reverse using the already-authorized Google session (starting new consent still requires the existing GitHub configuration). Restore both afterward. Verify a client without a bearer token gets 401.
6. Keep credentials and responses on the local computer: do not export Inspector sessions, screenshots, HTTP traces, token responses, resource names/IDs, search text, or page content. Report only the outcome of each check. No diagnostic endpoint exposes the selected key.

The tests cannot verify the ownership, project permissions, or separation of the real LegendKeeper keys without these credentialed checks. A later approved deployment is required to test both actual ChatGPT accounts at the production endpoint. No deployment, secret update, commit, or push is performed here.
