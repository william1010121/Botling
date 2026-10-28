# Antigravity transport feasibility, 2026-10-28

Runtime remains disabled at de9f459. This investigation changes no adapter,
permissions, account settings, credentials or installed app. No model/API request
or Claude process was launched. Mixed-head/worker implementation is deferred.

## Decision

Prioritize Google's separate Antigravity ACP server for a subscription-preserving
integration feasibility test. Do not conclude that paid API access is the only
route. SDK is a real alternative with an explicit callback, but its documented
cloud endpoints use API/Vertex authentication rather than the CLI personal login.
Neither route is yet proven safe/usable end to end in Botling.

### Existing login / ACP candidate

Official Zed and JetBrains setup supports personal Google Free/Pro/Ultra accounts
with auth.type=oauth-personal. The authentication page describes shared sign-in
among IDE extensions, CLI and App. The ACP registry identifies Google's separate
antigravity-acp 1.2.1 binary, with a macOS arm64 archive on dl.google.com and
command agy_acp_server.par. This is NOT agy --input-format stream-json.

ACP v1 defines initialize, session setup, streamed session/update, request_permission
with explicit allow/reject choices, and cancellation. The permission request is
optional in the protocol: supporting ACP alone does not prove every restricted
action is gated. Nor does a generic session mode example establish Antigravity's
actual mode behavior. No ACP runtime was installed/launched and no credential
reuse was tested here; the current authorization specifically permitted the
verified SDK development installation.

Candidate architecture: Botling implements an ACP client, launches the official
server, negotiates capabilities before any prompt, routes permission requests to
existing approval cards (reject/cancel by default), and retains session IDs.
Expose only app-approved filesystem/terminal/MCP capabilities. Before enabling:
verify the actual server's per-session policy and inheritance for tools/MCP/
subagents, existing-login reuse without prompting, rejection/timeout/cancellation,
and absence of side effects before approval. A mere request_permission fixture
is insufficient. If server-side tools bypass client mediation or mutable global
rules can weaken the selected policy, keep it disabled.

Sources:
- https://antigravity.google/docs/ide/extensions/zed/
- https://antigravity.google/docs/ide/extensions/jetbrains/
- https://antigravity.google/docs/install/ (IDE auth and programmatic auth sections)
- https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
- https://agentclientprotocol.com/protocol/v1/tool-calls (permission is MAY)
- https://agentclientprotocol.com/protocol/v1/session-modes

### Python SDK evidence

Downloaded the official documentation-named PyPI google-antigravity 0.1.22 wheel;
the docs link the same Google-Antigravity/antigravity-sdk-python project as package
metadata. Verified the macOS arm64 wheel against PyPI SHA256:
1db8f5ef2eb3a821c7780d8a5c634c4d9b90d401a02de6d640c2fa69a2545b62

Installed wheel and dependencies with --only-binary=:all: in a private temp venv:
/Volumes/My-SSD/botling-work/installed/botling-2-dev-trial-20261026.1/development-data/tmp/botling-agy-sdk-gwcmt1m0/venv
No global or Botling plugin install. Python 3.13.11. No Agent was instantiated.

The attached offline_probe.py clears inherited environment and blocks network
connect and child-process creation before importing SDK. Twelve checks passed:
eight synthetic tool names (read/write/shell/web/delegation/custom/unknown/MCP)
wait for wildcard ask_user callback and refuse when it returns false; callback
exception denies; missing callback rejects; missing Gemini API key rejects; no
LocalAgentConfig OAuth auth field. The first probe attempt failed because our
Popen monkeypatch broke a type annotation; correcting the test guard to patch
Popen.__init__ allowed the tests to run. No SDK/runtime failure was inferred.

Wheel source evidence (paths relative to google/antigravity):
- hooks/policy.py:699-769: callback awaited; false/exception denies, but unmatched
  policy permits. Specific allow can override wildcard ask. Defaults are NOT
  all-tools approval: confirm_run_command blocks shell while allowing other tools.
- hooks/policy.py:837-927: policies serialized into harness config; dynamic rules
  use PolicyDecisionRequest/Response. Unknown rule ID denies in
  connections/local/event_processor.py:724 onward.
- connections/local/local_connection.py:1381-1386,1520 onward: policy config is
  included in initialization before the prompt transport is used.
- connections/local/hook_router.py:180 onward: pre-tool hook reports allow/deny
  for built-in and MCP targets.
- connections/local/event_processor.py:1068 onward: separate confirmation events
  are auto-accepted because the implementation relies on the earlier pre-tool
  hook. Client ToolRunner invocation itself is not an independent policy fence.

Therefore the callback is a genuine pre-tool decision facility, not proof of
ALL effects being intercepted. Native harness dispatch coverage, child/subagent
inheritance and startup of MCP/hooks require runtime evidence; initialization
and arbitrary host callback code are not contained by a tool policy. Do not
use default policies or claim the offline test validates the native harness.

Candidate SDK architecture: pinned private Python sidecar, explicit no-auto-allow
policies, bounded approval callback to Botling, app-owned custom tool wrappers
with independent checks, restricted capabilities and no arbitrary startup MCP/
hooks; then separate native-harness safety/lifecycle verification.

Auth source: models.py:110-170 validates Gemini API key or Vertex project/location
(or express API key); local_connection_config.py:237-306 constructs those
endpoints. No OAuth/keyring account provider appears in these configuration types.
The auth docs' introduction broadly mentions unified sign-in including SDK, but
its specific Programmatic authentication section lists API key, Vertex/ADC and
local models. The package agrees with that specific list. Thus existing CLI
personal-login reuse is NOT established for this SDK version; do not extract a
token or repurpose it as an API key.

Sources:
- https://antigravity.google/docs/sdk/overview/
- https://antigravity.google/docs/sdk/policies/
- https://antigravity.google/docs/install/#programmatic-authentication
- https://pypi.org/pypi/google-antigravity/0.1.22/json
- https://github.com/google-antigravity/antigravity-sdk-python

### CLI bidirectional findings

Local agy --help has text/stream-json input, interactive prompt and remote-control,
not a documented approval-control/ACP flag. Headless docs explicitly reject
control_request/control_response. Remote Control DOES provide bidirectional
human tool approvals through the official browser/TUI using the existing account;
it is not a documented third-party machine API. No daemon or remote tunnel was
started. Scraping TUI or private remote endpoints would not establish a robust
Botling permission barrier.

- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/reference
- https://antigravity.google/docs/remote-control/

## Options / tradeoffs

1. Official ACP server: best candidate to retain existing plan/account; additional
   transport and policy verification required, no proven Botling integration yet.
2. SDK + Gemini API/Vertex: explicit programmable policy callback; separate API
   identity/quota/billing (including any eligible free API quota), not evidence of
   subscription credit reuse. User authorization required before paid calls or
   new authentication; no API key requested in this investigation.
3. SDK + local model: documented no-key path, local compute/model setup and
   different model quality; does not deliver the user's current agy cloud account.
4. Official CLI/Remote Control UI: usable outside Botling with its own approvals,
   but not the requested integrated engine.

Recommendation: verify ACP account/policy capability before choosing option 2.
Do not merge or enable the blocked CLI adapter based on SDK/ACP documentation.
