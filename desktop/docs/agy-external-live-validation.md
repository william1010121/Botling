# Pending external live validation — not executed

This is the next step for this integration, not evidence of acceptance. Production
`agy-capabilities.ts` remains false for both workers and mixed heads. There is no
runtime setting/environment override. Do not remove those gates to run the app.

## Executor boundary

The assigned executor is prohibited from delegating its work to another agent/bot.
That is an execution-ownership rule, not a missing user OAuth authorization. It
does not explicitly classify product engine integration tests separately from
agent delegation. This run therefore uses offline engine fixtures and does not
launch real model workers. The executor-policy owner must clarify that specific
classification, or provide an executor expressly permitted to run product-engine
probes. Do not retry through a shell or alternate environment within this run.
This corrects the broader inference in the previous worker-contract stage; it is
not a claim that the text unambiguously prohibits every product integration test.

## Minimal procedure for a permitted developer/executor

1. Use an isolated checkout of this commit, existing development dependencies,
   an owned empty temporary workspace, and separate app profile directories
   outside that workspace. No installed-app changes. Verify the official ACP
   1.4.3 server/harness and native helper hashes in `agy-engine.md`. Stop if absent
   or mismatched; no automatic download/install or relaxed hash verification.
2. Run the bounded offline prerequisite from `desktop/`:

   ```sh
   ./node_modules/.bin/vitest run test/unit/agy-runtime-gates.test.ts test/unit/agy-mixed-wiring.test.ts test/unit/agy-worker-bridge.test.ts test/unit/agy-workers.test.ts
   ```

3. Prepare a separate opt-in live test file/config (not part of normal test
   discovery). Reuse the real Bot fixture construction in `agy-mixed-wiring` and
   bridge/worker assertions in `agy-worker-bridge`; replace the fake Codex/agy
   constructors with the real adapters and real app-owned configs. Keep the
   capability override confined to that test module; never change production
   gate functions. Keep a spawn allowlist for the verified ACP and Codex runtime
   plus the pinned helper. Any Claude constructor/spawn fails the test. This
   live harness is deliberately not supplied or run as if already validated.
4. Before any model task, check existing-account metadata only. For Codex, after
   protocol initialize, request `account/read` with `{refreshToken:false}`;
   require `account.type === "chatgpt"` and the intended existing OpenAI provider,
   not an API-key/custom paid provider. Retain only the boolean result, no email,
   tokens or raw account response. Official protocol:
   https://learn.chatgpt.com/docs/app-server#1-check-auth-state . Missing/unsupported
   preflight is a blocker, never permission to inspect credential files. For ACP,
   require existing official-session authentication. Stop on OAuth/consent request;
   the official server may initiate interactive login when its cache is missing.
   Do not claim that startup is silent-only. No new login or API/Vertex billing.
5. Before any action-bearing prompt, enumerate the effective tool inventory and
   confirm every enabled action reaches the app-owned approval boundary. Unknown
   native/MCP/plugin/delegation paths fail acceptance. The staged Codex leaf
   flags are not evidence that the server honors them. Use private workspace
   canaries and deny-by-default callbacks. Never autoapprove a model request.
6. Run these bounded cases with a 90-second maximum per model turn, two workers
   maximum, explicit per-action approval, and unconditional finally cleanup:

   | Case | Required observation |
   | --- | --- |
   | Two workers, one agy and one Codex | Distinct profile/session/task/run identity; identical RPC IDs cannot cross-answer; no write before exact allow-once |
   | Deny marker-file write | Marker absent; failed/blocked result and correlated report even if provider ends successfully |
   | Allow one marker-file write | Only named private file changes; grant replay and stale task/run answers rejected |
   | Report + uncertain delivery | One correlated report; restart does not replay uncertain delivery; explicit reconcile retries report only, never task |
   | Cancel during tool execution | Active approved benign bounded command and descendants stop; no late success/handback; slot remains occupied until cleanup confirmed |
   | Worker crash + app reconstruction | Owned process identity checked; no orphan group; saved conversation retained; failed resume cannot create replacement/replay |
   | Codex to agy and reverse | Real successful handoff/handback; denial blocks success; stop revokes late return; Claude route never constructs a process |
   | Concurrency + steering | Two worker limit includes cleanup; stale events ignored; unsupported active steering explicitly rejected/queued without extra turn |

   Use only private fixtures (for example `deny-marker.txt`); never give models
   implementation work, secrets, external paths, network jobs or global edits.
   If a case cannot safely be induced, record unverified, not passed.
7. Save redacted task/run/event order, card ownership, file canary checks, process
   group disappearance and restart identity as evidence. A real pre-permission
   action, unknown tool bypass, unexpected billing/auth mode or orphan process is
   a stop condition. Independent review must approve this evidence before a
   separately assigned capability-enabling change; no package/merge/install here.

## Remaining limits

Current evidence is offline only. Codex native tool/MCP permission coverage,
server support for leaf-mode flags, account compatibility and live app-managed
cleanup are unverified. agy native subagents/external plugins/direct image blocks
remain unsupported. The staged alternative is app-owned worker tools plus peer
handoff, not native nested delegation. The mixed Codex wrapper leaves normal
Codex usage/identity/stream code untouched.
