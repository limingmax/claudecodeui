# Architect Review: autopilot-staged-loop.plan.md

## Metadata
- Reviewer: Architect
- Date: 2026-05-18
- Plan: `autopilot-staged-loop.plan.md`
- Spec: `deep-interview-claudecodeui-autopilot-loop.md`

---

## A. Steelman Antithesis (strongest counterarguments)

### Antithesis D (strongest): Reducer is the wrong abstraction for multi-step async I/O

**Argument:**

The plan chooses "pure function reducer + explicit event dispatch" (Principle 5), citing zero dependencies and Redux familiarity. But the autopilot state machine has these core characteristics:

1. **Every transition triggers async side effects**: `EXECUTING -> COMPLETION_PROBE` requires sending a resume query and awaiting results; `RETRY_NETWORK` requires waiting for backoff delay then resuming; `REVIEWING` requires awaiting a reviewer query completion.
2. **Side effects can fail and need rollback**: The resume call itself may throw, leaving state already transitioned but side effect incomplete.
3. **Concurrent race conditions**: abort can arrive mid-side-effect; network timeout and SDK complete may fire near-simultaneously.

A pure function reducer can only return `{ newState, sideEffects[] }`, but **who executes sideEffects, how to guarantee ordering, how to handle side-effect failure consistency** -- all of this falls on `orchestrator.service.ts`. In practice, the orchestrator IS the real state machine; the reducer degrades to a lookup table.

**What Planner missed:**
- The plan does not define how orchestrator serializes events. If `sdk_complete` triggers a probe, and `abort` arrives before probe returns -- reducer computes CANCELLED, but the probe query is already in flight. Who aborts it?
- The plan does not define a "side-effect execution failure" rollback strategy. The reducer is pure, but orchestrator's `executeSideEffects()` is not.
- XState's actor model natively solves these (invoke/cancel service). The plan dismisses it with "45KB bundle size", but orchestrator will reinvent XState's invoke/cancel semantics without formal guarantees.

**Conclusion:** The reducer itself is not wrong, but the plan **severely underestimates orchestrator complexity** and provides no design for concurrent event serialization or side-effect lifecycle management. This is not an "implementation detail" -- it is the architectural core.

### Antithesis B (secondary): completion probe should not resume the same sessionId

**Argument:**

Each resume on the same sessionId sends full conversation history to the API. For a medium task producing 50K tokens of dialogue, 5 continue rounds + 5 probes = 10 resumes, each carrying full history:

- 1st probe: 50K context
- 5th probe: ~250K context (each continue round generates new content)
- Token cost and latency grow linearly

The plan mentions this in "Risk 3" but the mitigation is "monitor token budget, force exit at <20%" -- this is **post-hoc damage control**, not an architectural solution.

**Better alternative:** completion probe uses an independent short session + carries a summary of the last assistant message (~500 tokens). The probe only needs to know "what did Claude last say" to judge completion. This keeps each probe at a fixed ~600 tokens regardless of round count.

**What Planner missed:**
- The plan assumes probe needs full context to judge completion, but the probe prompt is "Has the previous task been completed? Answer only COMPLETED or NOT_COMPLETED" -- this judgment only needs the last round of output.
- The trade-off: if Claude answers NOT_COMPLETED, the subsequent "continue" still needs to resume the original sessionId (correct), but the probe itself does not.

---

## B. Real Architectural Tensions

### Tension 1: `removeSession` timing vs autopilot continuation

**Two sides:**
- Goal A: After `queryClaudeSDK`'s `for await` loop ends, `removeSession` must execute (:691), otherwise `activeSessions` Map leaks and abort points to a completed query instance.
- Goal B: Autopilot needs to continue using the same sessionId to send resume after `sdk_complete`, and resume needs `addSession` to register the new query instance.

**Plan's implicit resolution:** Step 4 says "insert conditional branch before `ws.send(complete)`" -- but `removeSession` is at :691 (BEFORE complete at :699!). The plan's insertion point description says ":699 (after complete event)", but actually removeSession at :691 has already executed.

**Failure scenarios:**
- If autopilot conditional branch intercepts only at :699, then :691's `removeSession` has already deleted the session from the Map. If user sends abort-session during probe, `getSession()` returns undefined, abort silently fails.
- If the conditional branch is moved before :691, then the non-autopilot path's removeSession logic needs reorganization.

### Tension 2: `canUseTool` permission prompts vs full automation

**Two sides:**
- Goal A (safety): MVP does not enable bypassPermissions; encountering a permission prompt pauses and waits for user approval.
- Goal B (automation): Autopilot's value is "human not present", but permission prompts block the state machine indefinitely.

**Plan's implicit resolution:** Risk 4 mentions adding `WAITING_PERMISSION` state + frontend approval UI. But:
- `WAITING_PERMISSION` is not in the state enum (the plan's enum does not have it)
- `canUseTool`'s `waitForToolApproval` has a 55s timeout (:34); after timeout it returns deny. In autopilot mode, deny = tool execution failure = SDK may error or change strategy -- this path is completely uncovered by the plan.
- If autopilot in REVIEWING phase (reviewer query) triggers a tool permission request, the permission_request event goes to ws -- but the frontend may think "currently reviewing" rather than "currently executing", causing UI state inconsistency.

---

## C. Synthesis

The current main path direction (independent module + reducer) is correct, but needs supplementation:

1. **Orchestrator must have an explicit event queue + serialization guarantee**: All external events (sdk_complete, sdk_error, abort, permission_timeout) are enqueued; orchestrator processes them one by one; new events arriving during processing are queued. This solves Antithesis D's core problem without introducing XState.

2. **Completion probe should be configurable with two modes**:
   - Mode A (default): resume same sessionId (maintains context continuity, suitable for complex tasks)
   - Mode B: independent short session + summary (suitable for token-sensitive scenarios)
   - MVP does not need both implemented, but architecturally `completion-probe.service.ts`'s interface should reserve a `strategy` parameter.

3. **`removeSession` conditional branch must be at :691, not :699**: In autopilot mode, skip removeSession; orchestrator handles unified cleanup when the entire automation flow ends.

---

## D. Principle Violation Check

| Principle | Violating Step | Description | Fix |
|-----------|---------------|-------------|-----|
| P1 "Non-invasive wrapping: do not modify queryClaudeSDK signature or core streaming loop" | Step 4 | Inserting a conditional branch at :691 to skip `removeSession` IS modifying the core streaming loop's cleanup logic. While the signature is unchanged, behavioral semantics change (session no longer cleaned up on complete). | Accept this as necessary minimal invasion, but explicitly note in Principle 1 "cleanup logic excepted", or change to orchestrator re-calling addSession after complete. |
| P3 "abort must immediately terminate the entire state machine" | Step 5 | Plan only says "abort-session branch adds `orchestrator.abort(sessionId)` call", but does not specify: (a) if orchestrator is currently executing a side effect (e.g., waiting for probe query return), how to interrupt the in-progress SDK query; (b) if orchestrator has sent resume but new query has not yet registered in activeSessions, abort will miss it. | Must maintain "current active query instance" reference in orchestrator; abort must simultaneously call `instance.interrupt()` + set cancelled flag to prevent subsequent side-effect execution. |
| P4 "Every state transition produces a WS event" | Step 3-4 | Plan does not explain how streaming messages from orchestrator's resume reach the frontend. Originally `queryClaudeSDK`'s `for await` loop handles forwarding messages to ws -- but orchestrator's resume is a new `query()` call; who consumes its message stream? | Must clarify: when orchestrator sends resume, either reuse `queryClaudeSDK` (recursive call) or have an independent message consumption loop. The former is simpler but needs recursion depth protection. |

---

## E. Code-Level Risks

### E1. `claude-sdk.js:691` insertion point ordering (FATAL)

**Current code (:690-706):**
```javascript
// :691 - Clean up session on completion
if (capturedSessionId) {
  removeSession(capturedSessionId);  // <-- session deleted first
}
// :696 - Clean up temporary image files
await cleanupTempFiles(tempImagePaths, tempDir);  // <-- then clean temp files
// :699 - Send completion event
ws.send(createNormalizedMessage({ kind: 'complete', ... }));  // <-- finally send complete
notifyRunStopped({ ... });
```

**Risk:** Plan says "insert conditional branch at :699", but by then session is already deleted at :691. If autopilot wants to continue:
- abort during probe -> `getSession()` returns undefined -> abort silently fails
- `reconnectSessionWriter` called during autopilot -> session not found -> reconnect fails

**Must fix:** Conditional branch must be BEFORE :690 (immediately after `for await` loop ends). In autopilot mode, skip removeSession + cleanupTempFiles + complete event; all handled by orchestrator.

### E2. resume same sessionId concurrency safety (HIGH RISK)

**Current state:** `query()` returns async generator. SDK has no lock for concurrent resume calls on the same sessionId.

**Risk scenario:**
1. Orchestrator sends completion probe (resume sessionId=X)
2. Probe query is being consumed in `for await`
3. User sends abort -> `abortClaudeSDKSession` calls `session.instance.interrupt()`
4. But `activeSessions` stores the **original query instance** (Step 4 says store orchestrator reference at :236, but does not say update instance)
5. interrupt() acts on old instance (already completed); probe's new instance is unaffected

**Must fix:** Plan must clarify: every time orchestrator sends resume creating a new query instance, it must update the `instance` field in `activeSessions` Map, otherwise abort cannot interrupt the currently active query.

### E3. `canUseTool` and autopilot cooperation (MEDIUM RISK)

**Current state (:535-604):** `canUseTool` closure captures `ws` and `capturedSessionId`. When orchestrator sends resume creating a new query, the new query's `canUseTool` needs:
- Same `ws` reference (for sending permission_request)
- Correct sessionId

**Risk:** If orchestrator directly calls `query({ prompt, options: sdkOptions })`, it needs to reconstruct complete sdkOptions (including canUseTool closure). Plan does not specify this. If orchestrator reuses `queryClaudeSDK` function, canUseTool is naturally correct -- but Step 4's description implies orchestrator calls SDK directly.

**Recommendation:** Clarify that orchestrator sends resume by calling `queryClaudeSDK(prompt, { sessionId, ...originalOptions, autopilot: undefined }, ws)`, reusing existing options construction logic. Set `autopilot: undefined` to prevent recursive autopilot triggering.

### E4. abort vs state machine multi-query problem (HIGH RISK)

**Current state (:743-771):** `abortClaudeSDKSession` does three things: `interrupt()` + set status='aborted' + `removeSession()`.

**Risk:** If autopilot is in REVIEWING (has sent new resume query), which instance does the sessionId in activeSessions Map correspond to?
- If original query instance (already completed) -> interrupt is ineffective
- If orchestrator updated instance -> interrupt is correct, but removeSession causes orchestrator's subsequent operations to fail finding the session

**Must fix:** abort handling for autopilot sessions must be:
1. Set orchestrator.cancelled = true (prevent subsequent side effects)
2. interrupt the currently active query instance
3. Do NOT immediately removeSession -- wait for orchestrator's CANCELLED state handling to complete before cleanup

### E5. `activeSessions` pure in-memory + process crash (LOW RISK, MVP acceptable)

**Current state:** `activeSessions` is `new Map()` (:31); process restart loses everything.

**Risk:** Autopilot reaches 4th review-fix round, process crashes -> all state lost, user does not know progress.

**Plan handling:** Plan has `autopilot_history` table persisting transition history, but does not explain how to recover state machine from history. MVP can accept "crash = failure, user manually restarts", but should explicitly state this in documentation.

### E6. WS reconnect and autopilot state catch-up (MEDIUM RISK)

**Current state (:820-825):** `reconnectSessionWriter` only replaces writer's underlying ws connection; does not replay historical messages.

**Risk:** Client disconnects for 30s then reconnects; during that time autopilot moved from EXECUTING to REVIEWING. After reconnect, client does not know current state.

**Plan handling:** Plan's WS event design has no "state snapshot" event. `check-session-status` (:206-225) only returns `isProcessing: boolean`, not autopilot state.

**Recommendation:** Add `autopilot.status_snapshot` event; on reconnect, orchestrator proactively pushes complete current state (state + counters + lastEvent).

### E7. commit message generation query method (LOW RISK)

**Plan says:** "commit message generated by an additional Claude query", but does not specify resume vs new session.

**Analysis:**
- Resume same sessionId: Pro is Claude has full change context, can write meaningful trailers; Con is more history bloat.
- New session + git diff as prompt: Pro is no history growth; Con is need to fit diff into prompt (may be large).

**Recommendation:** Use new session + `git diff --staged` output as prompt context. Commit message generation does not need conversation history, only needs to see the changes. This also avoids resume's token bloat problem.

---

## F. Verdict

**NEEDS_REVISION**

The plan's overall direction is correct (independent module, reducer, non-invasive), but 3 mandatory fixes block entry to Critic review:

### Mandatory Fixes

1. **Step 4 insertion point must be corrected to before :690** (current :699 is wrong)
   - Location: Plan "Step 4: claude-sdk.js integration point" first row
   - Change to: Conditional branch after `for await` loop ends, BEFORE `removeSession` (i.e., before line :690)
   - In autopilot mode, skip removeSession / cleanupTempFiles / complete event; orchestrator takes full control of subsequent lifecycle

2. **Step 3 orchestrator must add event serialization + active query instance management design**
   - Location: Plan "Step 3: Orchestration Engine" `orchestrator.service.ts` description
   - Must clarify:
     - (a) Event queue: all external events enqueued, processed sequentially; new events during processing are queued
     - (b) `currentQueryInstance` field: updated every time resume creates a new query
     - (c) abort handling: set cancelled flag -> interrupt currentQueryInstance -> wait for current side-effect to exit -> removeSession
     - (d) How orchestrator sends resume: by calling `queryClaudeSDK(prompt, opts, ws)` reusing existing logic (including canUseTool, message forwarding), NOT directly calling SDK `query()`

3. **State enum must add `WAITING_PERMISSION` or explicitly define permission timeout strategy**
   - Location: Plan "State Enum" + "Risk 4"
   - Choose one:
     - (a) Add `WAITING_PERMISSION` state + corresponding transitions (as Risk 4 describes), and complete in transition table
     - (b) Explicitly state MVP strategy: in autopilot mode, permission timeout (55s) -> deny -> SDK handles it -> if it causes error then follow FAILED path. Document that "autopilot is not suitable for tasks requiring frequent permission approvals"

### Recommended Improvements (non-blocking)

- Completion probe should consider independent short session mode (reduce token bloat)
- Commit message generation should use new session + git diff (not resume)
- Push `autopilot.status_snapshot` on WS reconnect
- Explicitly state that process crash makes autopilot state unrecoverable (MVP limitation)

---

## References

- `server/claude-sdk.js:14` -- SDK query import
- `server/claude-sdk.js:31` -- activeSessions Map (in-memory)
- `server/claude-sdk.js:235-243` -- addSession implementation
- `server/claude-sdk.js:250-252` -- removeSession implementation
- `server/claude-sdk.js:535-604` -- canUseTool closure (permission handling)
- `server/claude-sdk.js:611-626` -- query instance creation
- `server/claude-sdk.js:642-688` -- for await streaming consumption loop
- `server/claude-sdk.js:690-706` -- post-complete cleanup sequence (removeSession -> cleanupTempFiles -> ws.send complete)
- `server/claude-sdk.js:709-735` -- error catch block
- `server/claude-sdk.js:743-771` -- abortClaudeSDKSession implementation
- `server/claude-sdk.js:820-825` -- reconnectSessionWriter
- `server/modules/websocket/services/chat-websocket.service.ts:117-118` -- claude-command entry
- `server/modules/websocket/services/chat-websocket.service.ts:150-176` -- abort-session handling
- `server/modules/websocket/services/chat-websocket.service.ts:206-220` -- check-session-status + reconnect
- `server/services/notification-orchestrator.js:1-36` -- notification infrastructure
