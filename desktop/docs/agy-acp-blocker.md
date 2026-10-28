> Historical pre-consent evidence. Superseded on 2026-10-28: the user authorized one ACP OAuth consent; authenticate and session/new succeeded. Current implementation and limitations: [agy-engine.md](agy-engine.md). No new API/Vertex authentication or billing was used.

# ACP 1.4.3: actual authentication blocker, 2026-10-28

The official ACP route was investigated beyond architecture: the signed server
was downloaded into the isolated worktree cache, launched, and given initialize
and session/new requests. No authenticate or session/prompt request was sent.
The unsafe headless adapter remains disabled at de9f459. Runtime sources are
unchanged; no usable integration or native permission-barrier claim is made.

## Provenance and launch

The live official ACP registry now lists 1.4.3 (earlier web-index result 1.2.1 was
stale). Distribution:
https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-arm64.zip
Registry: https://raw.githubusercontent.com/agentclientprotocol/registry/refs/heads/main/antigravity-acp/agent.json

Archive SHA256 matches registry:
c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b

Server SHA256:
1251927db3e21f3d693fd042d6890d82f65eb00587e97f1f3d8f0d798e7f0954
Harness SHA256:
9e8fdc6e20a3262ca0a771850ca4a8414ca839a642cc964ec5c547cc2c33c200

Both files pass codesign --verify --strict. Server signer: Google LLC,
TeamIdentifier EQHXZ8M8AV. REA artifact evidence:
ev_66b5759b0d4572dda93fb4416e1702e536ca4c4018457476eb091c454b4999f1
(archive inventory only, not policy execution evidence).

The binary launches directly as agy_acp_server.par, speaking newline JSON-RPC
on stdin/stdout. --helpfull exposes no supported noninteractive-auth selector.
Observed initialize: protocolVersion 1; agent version 1.4.3; load/resume, images,
audio, embedded context, HTTP/SSE MCP, append system prompt capabilities.
These are advertised capabilities, not end-to-end tested behavior.

## Exact blocker

session/new with a private temp cwd and no MCP servers returned -32000,
Authentication required: No authentication method selected. The error offers
an authenticate call or auth.type in the ACP settings file.

Crucially, the shipped artifact's embedded Python source establishes that:

- The consumer OAuth manager uses keychain account antigravity-acp, intentionally distinct
  from the CLI's antigravity account, under service gemini.
- Its fallback file is <GEMINI_HOME>/antigravity-acp/acp_token.json. There is no
  migration from the CLI token in that manager.
- The shared credential manager’s get_access_token silently reuses/refreshes its own
  token if available, otherwise immediately starts interactive browser login.
- connection._ensure_oauth_logged_in and authenticate invoke that method;
  session/new with oauth-personal selected can also trigger it. There is no
  observed silent-only option. Identity/onboarding failures can clear that
  server's stored credentials, another reason not to invoke it speculatively.

Known source-marker byte offsets in the pinned server (to reproduce inspection):
account declaration 67355825; get_access_token 67802857; shared service 67806410;
_ensure_oauth_logged_in 67941713; policy.safe_defaults 68018800;
_permission_handler 68046291. These are embedded-source observations, not a
claim that strings alone prove native tool dispatch.

Local existence-only checks found no default ACP token file. A targeted
`security find-generic-password -s gemini -a antigravity-acp` metadata query,
with stdout/stderr discarded and NO -w/-g password flags, returned 44 (item not
found in the keychain search). No credential content was requested/read/copied.
This is absence in the checked default locations, not a search of every possible
custom GEMINI_HOME/keychain. The launched server used default HOME and no custom
GEMINI_HOME; its response independently confirms no selected auth method.

Therefore proceeding requires a one-time official ACP OAuth sign-in/consent
using the desired Google account, unless the user identifies an already
configured ACP profile. That is separate consent for this surface, not a request
for an API key or necessarily a new paid account. Existing CLI login alone does
not satisfy this 1.4.3 implementation. Do not copy CLI tokens across stores.

## Permission evidence and limits

Shipped source constructs safe_defaults policies before agent creation, grants
read-only tools, and sends mutating/high-risk tools through its permission
handler. The handler awaits client request_permission and returns false for deny
or cancelled outcomes. However, auto_edit/yolo modes, session-cached allow-always
and applicable enterprise auto-proceed policy can bypass prompts. Therefore
Botling must verify the actual session mode and policy before prompt submission;
ACP support or default mode alone is not proof of complete mediation.

Eight offline checks ran the pinned artifact's actual embedded permission-handler
function with synthetic helpers and ACP peers: shell, file-write, subagent and
MCP-shaped calls each stayed pending until a response and returned false for
both deny and cancel. No networking or child processes were permitted in that
probe. It does NOT test which native calls reach the handler, read restrictions,
MCP startup, subagent policy inheritance, process cleanup during active tools,
or the native harness honoring the result. Those checks require the authenticated
session and an established pre-task barrier first. No real task smoke was run.

## Next concrete step and choices

1. Authorize/complete the official ACP sign-in for the same Google subscription,
   then validate session policy, reject/timeout/cancel and native tool coverage
   before submitting a benign temp-workspace task. Only after that enable the
   ACP client and implement routing/workers. The sign-in itself must not be
   treated as permission to weaken tool policy or use paid API/Vertex billing.
2. Keep agy disabled if separate ACP consent is unwanted. SDK+API/Vertex remains
   a different, separately billed/authenticated alternative, not a token-reuse fix.

No login, account setting, global install, Botling installation/restart, merge,
package, shared checkout change, Claude launch or model request was performed.
Downloaded binaries remain only under desktop/.cache/agy-acp-dev (gitignored).
Evidence fixtures and reproducible probes are in docs/evidence/agy-acp/.
