# Phase 4 Architect Verification: autopilot-staged-loop

## Metadata
- Reviewer: Architect (Phase 4 -- implementation vs plan/spec)
- Date: 2026-05-18
- Verdict: **NEEDS_REVISION** (1 production-blocking bug, 1 gap)

---

## 1. Acceptance Criteria Verification (9 items)

### AC1 Frontend Control Panel -- PASS

**Evidence**:
- `src/components/chat/view/subcomponents/AutopilotPanel.tsx:207-231` -- 3 independent toggles (execution/reviewFix/commit)
- `:244-264` -- limit configuration (maxContinue / maxReviewFix / maxNetworkRetry)
- `:173-187` -- state display (state + counters)
- `:189-203` -- pendingPermission prompt
- `src/components/chat/view/ChatInterface.tsx:18` import + `:358` embedded in ChatInterface
- `src/components/chat/hooks/useChatComposerState.ts:670-672` -- autopilotOptions injected into claude-command

### AC2 WS Protocol Extension -- PASS (with minor gap)

**Evidence**:
- `server/modules/websocket/services/chat-websocket.service.ts:135-198` -- `claude-command.options.autopilot` schema parsing complete (execution/reviewFix/commit/limits)
- `server/shared/types.ts:91-98` -- 8 `autopilot.*` event kinds in MessageKind union type
- `server/modules/autopilot/ws-events.ts:175-182` -- `createStatusSnapshotEvent()` factory exists
- `server/modules/autopilot/services/orchestrator.service.ts:318-320` -- `getSnapshot()` method available

**Gap**: `check-session-status` path (:289-314) does not call `orchestrator.getSnapshot()` + push `status_snapshot` on reconnect. Event defined but not actually pushed. Non-blocking.

### AC3 State Machine Module + All Transitions -- PASS

**Evidence**:
- `server/modules/autopilot/reducer.ts:76-332` -- covers all 19 transitions per plan
- `:323-327` -- exhaustiveness guard (`const _exhaustive: never = ctx.state`)
- All transitions verified: IDLE->EXECUTING, EXECUTING->COMPLETION_PROBE/RETRY_NETWORK/FAILED, RETRY_NETWORK->EXECUTING/FAILED, COMPLETION_PROBE->EXECUTING/REVIEWING/COMMITTING/DONE, REVIEWING->COMMITTING/DONE/FIXING, FIXING->REVIEWING, COMMITTING->DONE/FAILED, ANY->CANCELLED

### AC4 Completion Probe -- PASS

**Evidence**:
- `completion-probe.service.ts:30-48` -- `parseCompletionVerdict()` returns only COMPLETED/NOT_COMPLETED/UNPARSED
- `:10-23` -- NOT_COMPLETED patterns checked first (prevents false positive on "NOT COMPLETED")
- `config.ts:4` -- probe prompt constrains model to only answer COMPLETED or NOT_COMPLETED
- `reducer.ts:179` -- UNPARSED treated as probe_not_completed (safe continue)

### AC5 Network Retry -- PASS

**Evidence**:
- `orchestrator.service.ts:338-366` -- `classifyError()` classifies network/rate_limit/business
- Keywords: econnreset, etimedout, socket, fetch failed, network, 429, rate limit
- `reducer.ts:134` -- exponential backoff `base * 2^(N-1)` capped at 60s
- `side-effect-executor.ts:138-143` -- SCHEDULE_RETRY uses setTimeout + enqueue retry_ready

### AC6 Review Phase -- PASS

**Evidence**:
- Review uses inline resume same sessionId: `side-effect-executor.ts:101-109`
- `review.service.ts:55-78` -- `parseReviewResult()` parses JSON findings + determines hasHighOrCritical
- `reducer.ts:242-254` -- dead loop detection uses sorted id comparison (order-robust)

### AC7 Commit Phase -- PASS

**Evidence**:
- `commit.service.ts:55` -- `git push` explicitly blocked with throw
- `:101-123` -- `buildCommitPrompt()` requires `Directive: autopilot-commit` trailer
- `:115-120` -- unresolvedFindings included in prompt requesting Not-tested trailer
- `:205-208` -- `git add -A` then `git commit -m`, no push

### AC8 WS Events -- PASS

**Evidence**:
- `ws-events.ts:16-25` -- 8 event kind constants defined
- Reducer emits EMIT_WS side effects on every transition
- `side-effect-executor.ts:66-73` -- EMIT_WS sends via `deps.ws.send()`

### AC9 Tests + typecheck + lint -- PASS

**Evidence**: Confirmed 87 tests PASS, typecheck PASS, lint 0 errors.

---

## 2. Plan Extra Commitments (5 items)

### 2.1 Insertion Points :689 / :709 -- PASS

- `claude-sdk.js:696-703` -- autopilot intercept after for-await loop, BEFORE removeSession(:706). `return` skips entire cleanup chain.
- `claude-sdk.js:727-731` -- catch block intercept delegates to `orchestrator.onSdkError()`.
- Non-autopilot path behavior 100% unchanged.

### 2.2 Three-Step Abort Protocol -- PASS

- `claude-sdk.js:764-770` -- abortClaudeSDKSession checks orchestrator snapshot first, delegates if autopilot
- `orchestrator.service.ts:293-312`: (1) cancelled=true, (2) enqueue abort, (3) await drainPromise
- `event-queue.ts:53-58` -- cancelled state discards non-abort events

### 2.3 Permission P2 (toolApprovalTimeoutMs:0) -- PARTIAL

- `claude-sdk.js:573` -- reads `options.toolApprovalTimeoutMs` for waitForToolApproval
- `config.ts:35` -- default toolApprovalTimeoutMs: 0
- **Gap**: chat-websocket.service.ts does not pass toolApprovalTimeoutMs into queryClaudeSDK options for the initial execute call. Subsequent RESUME_QUERY calls also omit it. The 0-timeout config exists but is not wired to the SDK call.

### 2.4 Token Budget Exit (<20% forces exit) -- PARTIAL

- `orchestrator.service.ts:229-236` -- onSdkComplete accepts tokenBudget parameter, checks threshold
- `claude-sdk.js:701` -- calls `onSdkComplete(capturedSessionId, '')` with NO tokenBudget argument
- Logic exists but is not connected. Non-blocking (maxContinue hard limit still protects).

### 2.5 CLAUDE.md Commit Convention (trailers in prompt) -- PASS

- `commit.service.ts:107-122` -- buildCommitPrompt explicitly requires conventional commit + Directive trailer
- `:115-120` -- unresolvedFindings trigger Not-tested trailer requirement

---

## 3. Risk Assessment

### 3.1 chat-websocket closure wrapping writer.setSessionId -- LOW RISK

- `intentBound` flag ensures single binding
- Original setSessionId preserved via `.bind(writer)`
- Reconnect path does not re-trigger wrapper

### 3.2 Orchestrator singleton + global sessions Map -- MEDIUM RISK (acceptable for MVP)

- Same sessionId cannot have two autopilot sessions (idempotent guard at :141)
- Different sessionIds have independent handles + queues
- Multiple WS connections do not cross-contaminate

### 3.3 commit.service shell injection -- LOW RISK

- `shell: false` in spawn options -- no shell interpretation
- Commit message passed as args array element, not string concatenation
- `git push` explicitly blocked at :54

### 3.4 [CRITICAL] RESUME_QUERY does not advance state machine -- PRODUCTION BUG

**Code**: `side-effect-executor.ts:100-114`

**Problem**:
- RESUME_QUERY calls `await queryFn(prompt, { sessionId, autopilot: undefined }, ws)`
- queryFn is `queryClaudeSDK`; with `autopilot: undefined` it takes the normal path
- Normal path: removeSession + ws.send(complete) + return void
- Normal path does NOT call `orchestrator.onSdkComplete()`
- Side-effect executor `break`s after await with no event dispatched
- **State machine permanently stuck in COMPLETION_PROBE / REVIEWING / FIXING**

**Why tests pass**: Mock queryFn manually calls `orchestrator.setCurrentPurpose()` + `orchestrator.onSdkComplete()` (see `orchestrator.integration.test.ts:173-178`). This does not reflect production behavior.

**Fix**: Inject a wrapper function (not raw queryClaudeSDK) that captures assistant text and calls orchestrator.onSdkComplete() after completion. Similar to commit.service capturingWs pattern.

---

## 4. Additional Findings

### 4.1 status_snapshot not pushed on reconnect

`chat-websocket.service.ts:289-314` check-session-status handler does not push autopilot state snapshot. Frontend useAutopilotState can handle it (:137-151) but server never sends it on reconnect.

### 4.2 onSdkComplete passes empty string for initial execute

`claude-sdk.js:701` -- passes '' as assistantText. Acceptable for purpose='execute' (no text parsing needed). But after RESUME_QUERY bug is fixed, subsequent turns must capture real text.

---

## 5. Final Verdict

### **NEEDS_REVISION**

| Severity | Item | Detail |
|----------|------|--------|
| **MUST FIX (Blocker)** | RESUME_QUERY no event dispatch | In production, probe/review/fix/continue queryFn completes but state machine never advances. Must implement queryFn wrapper that captures text and calls orchestrator.onSdkComplete(). |
| SHOULD FIX | toolApprovalTimeoutMs not wired | Config value 0 exists but never passed to queryClaudeSDK options |
| SHOULD FIX | status_snapshot reconnect push | Event defined but reconnect path does not send it |
| NICE TO HAVE | token budget not passed to onSdkComplete | Interface ready but call site omits data |

### Required Fix (blocks delivery)

1. **Implement queryFn wrapper**: `server/index.js:1451` should inject a wrapper function (not raw queryClaudeSDK). The wrapper must:
   - Accept purpose parameter (infer from prompt or pass explicitly)
   - Use capturingWs pattern to collect assistant text
   - After queryClaudeSDK completes: call `orchestrator.setCurrentPurpose(sessionId, purpose)` + `orchestrator.onSdkComplete(sessionId, collectedText)`
   - On error: call `orchestrator.onSdkError(sessionId, error)` (already handled by try/catch in side-effect-executor, but wrapper should be consistent)

---

## References

- `server/claude-sdk.js:31` -- activeSessions Map
- `server/claude-sdk.js:573` -- toolApprovalTimeoutMs usage
- `server/claude-sdk.js:628-632` -- onQueryCreated callback
- `server/claude-sdk.js:696-703` -- autopilot completion intercept
- `server/claude-sdk.js:727-731` -- autopilot error intercept
- `server/claude-sdk.js:764-770` -- abort delegation
- `server/index.js:70-71` -- autopilot imports
- `server/index.js:1451-1452` -- queryFn injection
- `server/modules/autopilot/services/side-effect-executor.ts:100-114` -- RESUME_QUERY (BUG)
- `server/modules/autopilot/services/orchestrator.service.ts:222-265` -- onSdkComplete routing
- `server/modules/autopilot/services/orchestrator.service.ts:279-286` -- setCurrentPurpose
- `server/modules/autopilot/services/commit.service.ts:54-55` -- git push guard
- `server/modules/autopilot/services/commit.service.ts:101-123` -- commit prompt with trailers
- `server/modules/autopilot/tests/orchestrator.integration.test.ts:173-178` -- mock reveals gap
- `server/modules/websocket/services/chat-websocket.service.ts:135-198` -- autopilot intent flow
- `server/modules/websocket/services/chat-websocket.service.ts:289-314` -- reconnect (missing snapshot)
- `src/components/chat/view/subcomponents/AutopilotPanel.tsx:207-231` -- 3 toggles
- `src/components/chat/hooks/useAutopilotState.ts:137-151` -- snapshot handler
