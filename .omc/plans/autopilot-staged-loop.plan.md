> Revision: 2 (post Architect review)

# Plan: claudecodeui 阶段式可选托管

## RALPLAN-DR

### Principles

1. **非侵入包装**：不修改 `queryClaudeSDK` 函数签名；autopilot 逻辑作为"后处理编排层"包裹在外部。cleanup 链路（removeSession / cleanupTempFiles / complete 事件）在 autopilot 模式下由 orchestrator 接管，属于必要最小侵入，非 autopilot 路径行为 100% 不变。
2. **阶段独立可选**：每个阶段（执行续传、评审修复、提交）是独立开关；关闭某阶段 = 该阶段退化为手动，不影响其他阶段。
3. **安全优先、可中止**：abort 必须立即终止整个状态机；三步 abort 协议保证精准取消当前活跃 query；所有计数器有硬上限；commit 禁止 push。
4. **可观测透明**：每次状态迁移产生 WS 事件 + 持久化历史记录，前端可实时展示。
5. **最小依赖**：不引入外部状态机库（XState 等），用纯函数 reducer + 事件串行化队列，降低包体积和学习成本。

### Decision Drivers

1. **改动隔离度**：autopilot 是高风险新功能，必须与现有 chat 流程完全解耦，出 bug 不影响正常使用。
2. **SDK 复用成本**：resume 同 sessionId 是唯一官方续会话方式，completion probe 和 review 都要走它。
3. **可测试性**：状态机必须纯函数可测，不依赖 WS/SDK 实例即可单元测试全部迁移。
4. **并发安全**：多个异步事件（abort、sdk_complete、probe_done）可能并发到达，必须有串行化保证。

### Viable Options

| 维度 | Option A: 独立模块 `server/modules/autopilot/` | Option B: 内嵌 `claude-sdk.js` Hook 化 |
|------|----------------------------------------------|----------------------------------------|
| 隔离度 | 高：独立目录，独立测试 | 低：与 SDK 逻辑耦合 |
| 改动范围 | 新增 ~6 文件，`claude-sdk.js` 仅加 ~30 行事件钩子 | 修改 `claude-sdk.js` 200+ 行 |
| 可回滚性 | 删目录即回滚 | 需逐行 revert |
| 复杂度 | 需定义清晰接口 | 直接访问内部变量，初期快 |
| **结论** | **选择 A** | 淘汰：耦合度过高，违反 Principle 1 |

| 维度 | Option A: 纯函数 reducer + 事件队列 | Option B: XState actor model |
|------|-------------------------------------|------------------------------|
| 包体积 | 0 新依赖 | +xstate ~45KB |
| 并发处理 | 显式 FIFO 队列 + 单线程消费，简单可控 | 内置 invoke/cancel，但需学 actor DSL |
| 可测试性 | 极高（纯函数输入输出 + 队列可 mock） | 高（但需 mock interpret + service） |
| 学习曲线 | 团队已熟悉 Redux 模式 | 需学 XState DSL + actor 概念 |
| 副作用管理 | orchestrator 显式执行 sideEffects[]，失败时 dispatch error 事件回 reducer | XState invoke 自动管理，但 debug 困难 |
| **结论** | **选择 A** | 淘汰：引入新依赖不符合 Principle 5；团队无 XState 经验；显式队列在此规模下足够 |

**为什么 reducer+queue 优于 XState（补充论证）**：autopilot 状态机仅 ~10 个状态、~20 条迁移，副作用种类有限（resume query、发 WS 事件、git commit）。XState 的 actor model 在状态 >50 或嵌套并行状态时优势明显，但在此规模下其 DSL 开销和 debug 复杂度反而是负担。显式 FIFO 队列 + cancelled flag 足以解决并发问题。

---

## 架构选型（决策表）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 状态机模块位置 | `server/modules/autopilot/` 独立模块 | 隔离度高，可独立测试/回滚，不污染 claude-sdk.js |
| 状态机驱动方式 | 纯函数 reducer + FIFO 事件队列 + orchestrator 执行副作用 | 零依赖、极高可测试性、显式并发控制 |
| completion probe | resume 同 sessionId 起新 query（接口预留 strategy 参数） | 官方 SDK 姿势，保持上下文连续 |
| 评审执行方式 | resume 同 sessionId 内联 query（prompt 触发 code-reviewer 规则） | 避免 WS 重入复杂度，reviewer 能看到完整改动上下文 |
| commit 服务 | 新建 `server/modules/autopilot/services/commit.service.ts`，内部调用 `git.js` 已有的 spawnAsync 模式 | 职责分离；复用验证逻辑但不耦合路由层 |
| 前端 UI | 在现有 chat 面板 settings 区域新增 "Autopilot" 折叠卡片 | 最小 UI 改动，用户无需切换页面 |
| 配置 | env 变量（服务端默认值）+ DB user_settings 表（前端可改） | 兼顾运维和用户自定义 |
| orchestrator 发 resume 方式 | 调用 `queryClaudeSDK(prompt, opts, ws)` 复用现有逻辑 | 自动获得 canUseTool、消息转发、session 管理；设 `autopilot: undefined` 防递归 |

---

## Orchestrator 并发模型

### 事件串行化队列

```typescript
interface AutopilotEventQueue {
  enqueue(event: AutopilotEvent): void;
  /** 当前是否正在处理事件（保证单线程消费） */
  readonly processing: boolean;
}

interface AutopilotSessionHandle {
  state: AutopilotState;
  currentQuery: QueryInstance | null;  // 当前活跃的 SDK query 实例
  eventQueue: AutopilotEventQueue;
  counters: { continue: number; reviewFix: number; networkRetry: number };
  cancelled: boolean;
  config: AutopilotConfig;
  sessionId: string;
}

// 全局注册表
const activeAutopilotSessions: Map<string, AutopilotSessionHandle> = new Map();
```

**队列消费逻辑（伪代码）**：

```typescript
class EventQueue implements AutopilotEventQueue {
  private queue: AutopilotEvent[] = [];
  processing = false;

  constructor(private handle: AutopilotSessionHandle, private executor: SideEffectExecutor) {}

  enqueue(event: AutopilotEvent): void {
    this.queue.push(event);
    if (!this.processing) {
      this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      if (this.handle.cancelled) {
        this.queue = []; // 丢弃剩余事件
        break;
      }
      const event = this.queue.shift()!;
      const { newState, sideEffects } = autopilotReducer(this.handle.state, event);
      this.handle.state = newState;
      // 逐个执行副作用；副作用失败 → dispatch error 事件（入队尾）
      for (const effect of sideEffects) {
        if (this.handle.cancelled) break;
        try {
          await this.executor.execute(effect, this.handle);
        } catch (err) {
          this.enqueue({ type: 'sdk_error', payload: { kind: 'business', error: err } });
        }
      }
    }
    this.processing = false;
  }
}
```

**关键保证**：
- `drain()` 是 async 但同一时刻只有一个 drain 在跑（`processing` flag）
- 新事件在 drain 执行中到达时入队尾，等当前副作用完成后按序处理
- `cancelled` flag 一旦置 true，队列立即清空，不再执行任何副作用

### 句柄管理：currentQuery 更新

每次 orchestrator 通过 `queryClaudeSDK` 发起 resume 时：
1. `queryClaudeSDK` 内部 `addSession()` 会用新 queryInstance 覆盖 `activeSessions` Map 中的 instance
2. orchestrator 同步更新 `handle.currentQuery = newQueryInstance`
3. 这保证 abort 时 `handle.currentQuery.interrupt()` 始终指向正确的活跃实例

**实现方式**：orchestrator 的 `SideEffectExecutor.execute()` 在执行 `RESUME_QUERY` 副作用时，拿到 queryInstance 引用后立即写入 handle：

```typescript
case 'RESUME_QUERY':
  const instance = await queryClaudeSDK(effect.prompt, {
    ...effect.options,
    sessionId: handle.sessionId,
    autopilot: undefined, // 防止递归触发 autopilot
  }, effect.ws);
  handle.currentQuery = instance; // 立即更新句柄
  break;
```

> **注意**：`queryClaudeSDK` 是 async 函数，返回时 `for await` 循环已结束。orchestrator 需要一个变体或回调来在 query 创建后、消费前拿到 instance。具体实现：在 `queryClaudeSDK` 的 autopilot 分支中，通过 `options.onQueryCreated?.(queryInstance)` 回调通知 orchestrator。这是对 `queryClaudeSDK` 的唯一签名扩展（可选回调，不破坏现有调用方）。

### 三步 Abort 协议

```typescript
async function abortAutopilot(sessionId: string): Promise<void> {
  const handle = activeAutopilotSessions.get(sessionId);
  if (!handle) return;

  // Step 1: 标记 CANCELLING，拒收新事件
  handle.cancelled = true;
  handle.eventQueue.enqueue({ type: 'abort' }); // reducer 会迁移到 CANCELLED

  // Step 2: 中断当前活跃 query
  if (handle.currentQuery) {
    try {
      await handle.currentQuery.interrupt();
      // SDK interrupt() 是 async，会让 for-await 循环抛出 InterruptError
      // 等待最多 3s 让 generator 退出
    } catch (e) {
      // interrupt 本身失败 → 强制继续 cleanup
    }
  }

  // Step 3: Cleanup
  // - 清理 temp 文件
  // - 从 activeSessions Map 移除
  // - 发送 WS 事件 autopilot.cancelled
  // - 从 activeAutopilotSessions 移除 handle
  removeSession(sessionId);
  activeAutopilotSessions.delete(sessionId);
  ws.send(createNormalizedMessage({ kind: 'autopilot.cancelled', sessionId }));
}
```

**SDK `interrupt()` 行为假设**：
- `interrupt()` 是 async，调用后 SDK 内部会让当前 `for await` 循环的 generator 抛出错误（类似 `AbortError` 或 generator return）
- **验证步骤**：实现前需写一个最小 repro 脚本确认 `query.interrupt()` 后 `for await` 是同步退出还是需要等下一个 yield point
- 如果是异步退出（需等 yield），abort 协议 Step 2 需加 `await Promise.race([generatorExitPromise, timeout(3000)])`

### 与现有 `abortClaudeSDKSession` 的协作

现有 `abortClaudeSDKSession` (:743-771) 对 autopilot session 的行为需修改：

```javascript
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return false;

  // 新增：如果是 autopilot session，委托给 orchestrator
  const autopilotHandle = activeAutopilotSessions.get(sessionId);
  if (autopilotHandle) {
    await abortAutopilot(sessionId);
    return true;
  }

  // 原有逻辑不变（非 autopilot session）
  await session.instance.interrupt();
  session.status = 'aborted';
  await cleanupTempFiles(session.tempImagePaths, session.tempDir);
  removeSession(sessionId);
  return true;
}
```

---

## 状态机

### 状态枚举

```typescript
enum AutopilotState {
  IDLE = 'IDLE',
  EXECUTING = 'EXECUTING',
  WAITING_PERMISSION = 'WAITING_PERMISSION',  // 新增：等待用户工具审批
  RETRY_NETWORK = 'RETRY_NETWORK',
  COMPLETION_PROBE = 'COMPLETION_PROBE',
  REVIEWING = 'REVIEWING',
  FIXING = 'FIXING',
  COMMITTING = 'COMMITTING',
  DONE = 'DONE',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}
```

### Permission 策略：选择方案 P2（显式声明 frozen）

**决策**：不新增 `WAITING_PERMISSION` 状态到迁移表。

**理由**：
- SDK 内部 `canUseTool` → `waitForToolApproval` 是一个 Promise，阻塞在 `for await` 循环内部。从 orchestrator 视角看，EXECUTING 状态没有前进，但也没有异常——它只是"慢"。
- 新增状态会引入 EXECUTING ↔ WAITING_PERMISSION 的频繁迁移（每个工具调用都可能触发），噪音过大。
- SDK 现有 `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`（默认 55s）超时后返回 deny，模型会收到 tool denied 信息并自行决定下一步（换策略或报错）。

**风险与缓解**：
- **风险**：55s 默认超时太短，autopilot 场景下用户可能不在屏幕前，导致频繁误 deny。
- **缓解**：autopilot 启用时，orchestrator 在调用 `queryClaudeSDK` 时通过 options 传入 `toolApprovalTimeoutMs: 0`（永不超时），让 permission 请求无限等待直到用户响应或用户 abort。
- **前端配合**：`autopilot.state_changed` 事件的 payload 中增加 `pendingPermission?: { tool: string, requestedAt: number }` 字段（从 SDK 的 permission_request WS 事件中提取），前端据此显示"等待审批: xxx 工具"提示。
- **如果用户长时间不响应**：不自动 fail，保持 EXECUTING 状态。用户唯一退出方式是 abort。这符合"安全优先"原则——宁可等也不自动 deny 危险操作。

> 注：状态枚举中保留 `WAITING_PERMISSION` 定义是为了前端 UI 显示用途（作为 EXECUTING 的子状态标签），但状态机迁移表中不使用它作为独立节点。

### 迁移表

| From | Event | To | Guard / 副作用 |
|------|-------|----|----------------|
| IDLE | `start` | EXECUTING | 初始化计数器；发 WS `autopilot.state_changed` |
| EXECUTING | `sdk_complete` | COMPLETION_PROBE | 发 resume query（completion check prompt） |
| EXECUTING | `sdk_error(network)` | RETRY_NETWORK | networkRetry++ ≤ MAX；计算退避延迟 |
| EXECUTING | `sdk_error(business)` | FAILED | 发 WS `autopilot.failed` + notification |
| RETRY_NETWORK | `retry_ready` | EXECUTING | resume 同 sessionId + "继续" |
| RETRY_NETWORK | `limit_reached` | FAILED | 发 WS `autopilot.limit_reached` |
| COMPLETION_PROBE | `probe_completed` | REVIEWING / COMMITTING / DONE | 按开关路由 |
| COMPLETION_PROBE | `probe_not_completed` | EXECUTING | continueCount++ ≤ MAX；resume + "继续" |
| COMPLETION_PROBE | `probe_unparsed` | EXECUTING | 视为 NOT_COMPLETED（安全续） |
| COMPLETION_PROBE | `limit_reached` | DONE | continueCount 超限，停下通知用户 |
| REVIEWING | `review_pass` | COMMITTING / DONE | 按 commit 开关路由 |
| REVIEWING | `review_fail(high/critical)` | FIXING | reviewFixCount++ ≤ MAX |
| REVIEWING | `review_limit_reached` | DONE | 未解决项写入 commit body |
| FIXING | `fix_complete` | REVIEWING | — |
| COMMITTING | `commit_success` | DONE | 发 WS `autopilot.completed` |
| COMMITTING | `commit_error` | FAILED | — |
| * (any) | `abort` | CANCELLED | 三步 abort 协议（见并发模型章节） |

### 错误分类树

```
sdk_error
├── network（关键字: ECONNRESET, ETIMEDOUT, socket hang up, 502, 503, 504, fetch failed）
│   └── → RETRY_NETWORK
├── rate_limit（429, rate limit）
│   └── → RETRY_NETWORK（退避加倍）
└── business（其他所有）
    └── → FAILED
```

### 计数器与配置映射

| 计数器 | 环境变量 | 默认值 | 前端可改 |
|--------|----------|--------|----------|
| continueCount | `AUTOPILOT_MAX_CONTINUE` | 5 | Yes |
| reviewFixCount | `AUTOPILOT_MAX_REVIEW_FIX` | 5 | Yes |
| networkRetryCount | `AUTOPILOT_MAX_NETWORK_RETRY` | 3 | Yes |
| backoffBase (ms) | `AUTOPILOT_NETWORK_BACKOFF_MS_BASE` | 2000 | No |
| toolApprovalTimeoutMs | `AUTOPILOT_TOOL_APPROVAL_TIMEOUT_MS` | 0 (永不超时) | No |

---

## 文件级步骤

### Step 1: 状态机核心（可独立 PR）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `server/modules/autopilot/types.ts` | AutopilotState enum, AutopilotSessionHandle, AutopilotConfig, Event 类型, EventQueue 接口 |
| 新增 | `server/modules/autopilot/reducer.ts` | 纯函数 `autopilotReducer(state, event) → { newState, sideEffects[] }` |
| 新增 | `server/modules/autopilot/event-queue.ts` | EventQueue 实现：FIFO 队列 + 单线程 drain + cancelled 短路 |
| 新增 | `server/modules/autopilot/config.ts` | 从 env + DB 读取配置，导出 `getAutopilotConfig(userId?)` |
| 新增 | `server/modules/autopilot/index.ts` | 模块入口，re-export |

- 并行：可与 Step 2 并行
- 预计 diff：~250 行

### Step 2: 状态机单元测试

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `server/modules/autopilot/tests/reducer.test.ts` | 覆盖迁移表每条路径 |
| 新增 | `server/modules/autopilot/tests/event-queue.test.ts` | 并发事件串行化、cancelled 短路、副作用失败回注 |
| 新增 | `server/modules/autopilot/tests/config.test.ts` | env 覆盖、默认值 |

- 并行：可与 Step 1 并行
- 预计 diff：~300 行

### Step 3: 编排引擎（依赖 Step 1）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `server/modules/autopilot/services/orchestrator.service.ts` | `AutopilotOrchestrator` 类：管理 activeAutopilotSessions Map，创建 handle + EventQueue，执行副作用 |
| 新增 | `server/modules/autopilot/services/side-effect-executor.ts` | SideEffectExecutor：执行 RESUME_QUERY / SEND_WS / GIT_COMMIT 等副作用，更新 handle.currentQuery |
| 新增 | `server/modules/autopilot/services/completion-probe.service.ts` | 封装 probe query 发送 + 结果解析（COMPLETED/NOT_COMPLETED/UNPARSED），接口预留 `strategy` 参数 |
| 新增 | `server/modules/autopilot/services/review.service.ts` | 封装 reviewer query + 解析 severity |
| 新增 | `server/modules/autopilot/services/commit.service.ts` | 封装 git add + commit（复用 git.js 的 spawnAsync 模式），生成含 trailers 的 commit message |

- 预计 diff：~400 行
- 关键接口：`orchestrator.start(sessionId, toggles, limits, ws)` / `orchestrator.abort(sessionId)`

### Step 4: claude-sdk.js 集成点（依赖 Step 3）

| 操作 | 文件 | 插入点 | 说明 |
|------|------|--------|------|
| 修改 | `server/claude-sdk.js` | **:689（`for await` 循环 `}` 闭合后、:690 `removeSession` 之前）** | 若 `options.autopilot` 存在，跳过整个 cleanup 链路，委托 orchestrator |
| 修改 | `server/claude-sdk.js` | :709（catch 块入口） | 若 autopilot active，调用 `orchestrator.onSdkError(sessionId, error)` 而非直接走 notifyRunFailed |
| 修改 | `server/claude-sdk.js` | queryClaudeSDK options 参数 | 新增可选字段 `onQueryCreated?: (instance) => void` 和 `toolApprovalTimeoutMs?: number` |

**精确插入位置与包装方式（:689 正常完成路径）**：

```javascript
    } // :688 - for await 循环结束

    // >>> AUTOPILOT 拦截点（:689 之后，:690 之前）<<<
    // WHY NOT :699: removeSession 在 :691 已经把 session 从 activeSessions 删除，
    // 后续 abort 会因 getSession() 返回 undefined 而静默失败，
    // reconnectSessionWriter 也会找不到 session。必须在 cleanup 链路之前拦截。
    if (options?.autopilot && capturedSessionId) {
      // autopilot 模式：不走原 cleanup 链路，由 orchestrator 全权接管后续生命周期
      // orchestrator 会在整个自动化流程结束后统一执行 removeSession + cleanupTempFiles + 发终态事件
      const orchestrator = getAutopilotOrchestrator();
      orchestrator.onSdkComplete(capturedSessionId);
      return; // 跳过下方 removeSession / cleanupTempFiles / ws.send(complete) / notifyRunStopped
    }

    // --- 以下为非 autopilot 原有逻辑，100% 不变 ---
    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }
    // ... cleanupTempFiles, ws.send(complete), notifyRunStopped ...
```

**错误分支拦截（:709 catch 块）**：

```javascript
  } catch (error) {
    console.error('SDK query error:', error);

    // >>> AUTOPILOT 错误拦截 <<<
    if (options?.autopilot && capturedSessionId) {
      // autopilot 模式：错误由 orchestrator 分类处理（network → retry, business → FAILED）
      // 不走原 removeSession / notifyRunFailed 链路
      const orchestrator = getAutopilotOrchestrator();
      orchestrator.onSdkError(capturedSessionId, error);
      return;
    }

    // --- 以下为非 autopilot 原有逻辑，100% 不变 ---
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }
    // ...
```

**`queryClaudeSDK` 签名变更说明**：

原签名：`async function queryClaudeSDK(command, options, ws)`

options 新增可选字段（向后兼容，不传则行为不变）：
- `autopilot?: AutopilotOptions` — 启用 autopilot 模式
- `onQueryCreated?: (instance: QueryInstance) => void` — query 实例创建后回调，供 orchestrator 更新 handle.currentQuery
- `toolApprovalTimeoutMs?: number` — 覆盖默认 55s 工具审批超时（autopilot 传 0 = 永不超时）

> **兼容性声明**：函数签名形式不变（仍是 3 参数），但 options 对象内部扩展了字段。所有现有调用方不传这些字段时行为 100% 等同现状。这是对 Principle 1 "不修改签名"的精确解读——签名指参数列表形式，options 内部扩展是预期的扩展点。

### Step 5: WS 协议扩展 + abort 集成（依赖 Step 3）

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `server/modules/websocket/services/chat-websocket.service.ts` | `abort-session` 分支：检查 activeAutopilotSessions，若存在则委托 `abortAutopilot()`（三步协议） |
| 修改 | `server/shared/utils.ts` | NormalizedMessageInput 类型扩展 autopilot 事件 kind |
| 新增 | `server/modules/autopilot/ws-events.ts` | autopilot WS 事件构造工厂函数 |
| 修改 | `server/claude-sdk.js` :743-771 | `abortClaudeSDKSession` 增加 autopilot 委托分支（见并发模型章节） |

- 预计 diff：~100 行

### Step 6: 前端 UI（可与 Step 5 并行）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/components/AutopilotPanel.tsx` | 折叠卡片：3 个阶段开关 + 限额配置 + 当前状态/迭代可视化 + permission 等待提示 |
| 修改 | `src/components/ChatPanel.tsx`（或等效） | 嵌入 AutopilotPanel |
| 修改 | WS 消息处理 hook | 监听 `autopilot.*` 事件更新 UI 状态 |

- 预计 diff：~200 行

### Step 7: 集成测试 + 端到端验证（依赖 Step 4-5）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `server/modules/autopilot/tests/orchestrator.integration.test.ts` | mock SDK，验证完整流程 |
| 新增 | `server/modules/autopilot/tests/abort-races.test.ts` | abort 竞态专项测试（见测试计划） |
| 新增 | `server/modules/autopilot/tests/commit.service.test.ts` | 验证 commit 不 push |

- 预计 diff：~300 行

### Step 8: 数据库 + 可观测性（可与 Step 6 并行）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `server/modules/database/repositories/autopilot-history.db.ts` | autopilot_history 表 CRUD |
| 修改 | `server/modules/database/schema.ts` | 新增 autopilot_history 表 DDL |
| 修改 | `server/modules/database/migrations.ts` | 添加 migration |

- 预计 diff：~100 行

---

## WS 协议扩展

### 入站：`claude-command` options 扩展

```typescript
interface AutopilotOptions {
  execution: boolean;
  reviewFix: boolean;
  commit: boolean;
  limits?: {
    maxContinue?: number;
    maxReviewFix?: number;
    maxNetworkRetry?: number;
  };
}

interface ClaudeCommandPayload {
  type: 'claude-command';
  command: string;
  options: {
    sessionId?: string;
    cwd?: string;
    model?: string;
    autopilot?: AutopilotOptions;  // 新增，可选
    // ... existing fields ...
  };
}
```

### 出站：新增事件

| 事件 kind | Payload | 触发时机 |
|-----------|---------|----------|
| `autopilot.state_changed` | `{ sessionId, from, to, reason, timestamp, pendingPermission? }` | 每次状态迁移 + permission 请求到达时 |
| `autopilot.iteration` | `{ sessionId, type, count, max }` | 每次计数器递增 |
| `autopilot.limit_reached` | `{ sessionId, limitType, count, max }` | 任一计数器达上限 |
| `autopilot.completion_probe_result` | `{ sessionId, verdict, rawSnippet }` | probe 解析完成 |
| `autopilot.completed` | `{ sessionId, summary: { iterations, reviewRounds, commitHash? } }` | 状态机到达 DONE |
| `autopilot.failed` | `{ sessionId, error, lastState }` | 状态机到达 FAILED |
| `autopilot.cancelled` | `{ sessionId, cancelledInState }` | abort 完成 |
| `autopilot.status_snapshot` | `{ sessionId, state, counters, lastEvent, pendingPermission? }` | WS 重连时 orchestrator 主动推送 |

### 兼容性保证

- `options.autopilot` 字段为 `undefined` 时，`queryClaudeSDK` 行为与现有完全一致
- 新增 WS 事件 kind 以 `autopilot.` 前缀命名空间隔离，现有前端忽略未知 kind 不会报错
- abort-session 对 autopilot 会话走三步协议，对非 autopilot 会话无影响
- `queryClaudeSDK` 函数签名形式不变（3 参数），options 内部扩展字段均为可选

---

## 测试计划

### 单元测试（reducer.test.ts）

每条迁移表路径 1 case：
- IDLE → start → EXECUTING
- EXECUTING → sdk_complete → COMPLETION_PROBE
- EXECUTING → sdk_error(network) → RETRY_NETWORK（计数器递增）
- EXECUTING → sdk_error(business) → FAILED
- RETRY_NETWORK → retry_ready → EXECUTING
- RETRY_NETWORK → limit_reached → FAILED
- COMPLETION_PROBE → probe_completed → REVIEWING（reviewFix=true）
- COMPLETION_PROBE → probe_completed → COMMITTING（reviewFix=false, commit=true）
- COMPLETION_PROBE → probe_completed → DONE（reviewFix=false, commit=false）
- COMPLETION_PROBE → probe_not_completed → EXECUTING（计数器递增）
- COMPLETION_PROBE → probe_unparsed → EXECUTING
- COMPLETION_PROBE → limit_reached → DONE
- REVIEWING → review_pass → COMMITTING / DONE
- REVIEWING → review_fail → FIXING（计数器递增）
- REVIEWING → review_limit_reached → DONE
- FIXING → fix_complete → REVIEWING
- COMMITTING → commit_success → DONE
- COMMITTING → commit_error → FAILED
- ANY → abort → CANCELLED

### 事件队列测试（event-queue.test.ts）

- 多事件快速入队 → 按 FIFO 顺序逐个处理
- 处理中新事件到达 → 排队等待，不并发执行
- cancelled=true → 队列清空，后续事件丢弃
- 副作用执行失败 → error 事件入队尾，不中断 drain

### 竞态测试（abort-races.test.ts）

| 场景 | 验证点 |
|------|--------|
| abort 与 sdk_complete 同时到达 | abort 先入队 → CANCELLED；sdk_complete 被丢弃（cancelled=true） |
| abort 在 probe query 进行中 | handle.currentQuery.interrupt() 被调用；probe 的 for-await 抛错不触发新状态迁移 |
| abort 与 probe_done 竞态 | 若 abort 先处理 → CANCELLED；若 probe_done 先处理 → 正常迁移，随后 abort 再迁移到 CANCELLED |
| sdk_complete 与 sdk_error 竞态 | 不可能（同一 for-await 只会走 complete 或 catch），但测试确认 reducer 对重复事件幂等 |

### Permission 超时测试

| 场景 | 验证点 |
|------|--------|
| toolApprovalTimeoutMs=0 + 用户不响应 | EXECUTING 状态不变，无超时 deny |
| toolApprovalTimeoutMs=0 + 用户 abort | 三步协议正常执行，interrupt 中断等待中的 permission promise |
| toolApprovalTimeoutMs=5000（测试用短超时） | 超时后 tool denied → 模型收到 deny → 可能触发 sdk_error(business) 或模型换策略继续 |

### 集成测试

| 场景 | 验证点 |
|------|--------|
| 网络异常重试 | mock SDK 抛 ECONNRESET → 自动 resume 3 次 → 第 4 次 FAILED |
| 指数退避 | 验证 retry 间隔为 2s, 4s, 8s |
| completion probe COMPLETED | mock resume 返回含 "COMPLETED" → 进入 REVIEWING |
| completion probe NOT_COMPLETED | mock 返回 "NOT_COMPLETED" → resume + "继续" |
| completion probe UNPARSED | mock 返回乱码 → 视为 NOT_COMPLETED |
| 评审循环 high/critical 触发回流 | mock reviewer 返回 high → FIXING → REVIEWING 循环 |
| 评审循环出环 | mock reviewer 返回仅 low → 进入 COMMITTING |
| commit 不 push | 验证 spawnAsync 调用列表不含 `git push` |
| abort 立即停状态机 | 任意状态 dispatch abort → CANCELLED + currentQuery.interrupt() 被调用 |
| WS 重连推送 snapshot | 模拟 reconnect → 收到 autopilot.status_snapshot 事件 |

### 端到端（最小可行）

1. 开启全部托管开关，发送一个轻量需求（如 "在 README 末尾加一行注释"）
2. 验证状态机历史落库（autopilot_history 表有记录）
3. 验证 git log 有新 commit，commit message 含 conventional format + trailers
4. 验证 `git log --oneline -1` 的 hash 未出现在任何 remote ref 中（未 push）

---

## 风险

### 1. auto-commit 与 CLAUDE.md 规则冲突

- **风险**：`~/.claude/CLAUDE.md` 明确写 "完成代码修改后，不要自动提交代码"
- **缓解**：commit.service.ts 在 commit message body 中写入 trailer `Directive: autopilot-commit`
- **前端**：commit 开关旁显示提示文案 "开启后将自动提交（不 push），覆盖默认规则"

### 2. 评审循环死循环

- **风险**：reviewer 反复报同一个 finding，fix 无法解决
- **缓解**：`AUTOPILOT_MAX_REVIEW_FIX` 硬上限（默认 5）；每轮 fix 后对比 findings 列表，若与上轮完全相同 → 出环

### 3. resume 同 sessionId 多次导致 history 暴涨

- **风险**：每次 resume 累积完整对话历史 → token 消耗线性增长
- **缓解**：监控 token budget，当剩余 <20% 时强制出环 → DONE；completion probe 接口预留 `strategy` 参数，后续可切换为独立短 session 模式

### 4. Permission 等待与自动化的矛盾

- **风险**：autopilot 模式下用户不在屏幕前，permission 请求无人响应
- **缓解（P2 策略）**：`toolApprovalTimeoutMs: 0`（永不超时），permission 请求无限等待。前端通过 `pendingPermission` 字段显示等待状态。用户唯一退出方式是 abort。
- **已知限制**：autopilot 不适合需要频繁 permission 审批的任务。文档和 UI 中明确告知用户。
- **后续迭代**：第二期可加工具白名单机制（仅 bypass 读操作 + 已知安全写操作）

### 5. 并发安全

- **风险**：同一 sessionId 同时有 autopilot orchestrator 和用户手动操作
- **缓解**：autopilot active 时前端禁用手动发送按钮；服务端 orchestrator 持有锁，拒绝非 abort 的外部 command

### 6. 进程崩溃状态丢失

- **风险**：`activeAutopilotSessions` 是纯内存 Map，进程重启全部丢失
- **缓解（MVP 限制）**：crash = failure，用户需手动重启。`autopilot_history` 表记录了迁移历史供事后审计，但不支持从历史恢复状态机。文档明确声明此限制。

---

## 可观测性

### WS 事件流

所有 `autopilot.*` 事件通过现有 WebSocketWriter 发送，前端实时消费。WS 重连时 orchestrator 主动推送 `autopilot.status_snapshot`。

### 服务端日志

```
[AUTOPILOT] session={sid} state={from}→{to} reason={reason} counter={type}:{count}/{max}
```

### 持久化

新增 `autopilot_history` 表：

```sql
CREATE TABLE IF NOT EXISTS autopilot_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    event TEXT NOT NULL,
    reason TEXT,
    counters_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_autopilot_history_session ON autopilot_history(session_id);
```

### 前端可视化

- 当前阶段：状态机 state 映射为进度条 segment
- 迭代计数：显示 "续传 2/5 | 评审修复 1/5 | 网络重试 0/3"
- Permission 等待提示：显示 "等待审批: {tool} 工具"
- 剩余配额：基于 token budget 的百分比条

---

## 配置项清单

| 环境变量 | 默认值 | 含义 | 前端可改 |
|----------|--------|------|----------|
| `AUTOPILOT_MAX_CONTINUE` | 5 | "继续"轮次上限 | Yes |
| `AUTOPILOT_MAX_REVIEW_FIX` | 5 | 评审-修复闭环轮次上限 | Yes |
| `AUTOPILOT_MAX_NETWORK_RETRY` | 3 | 网络异常重试上限 | Yes |
| `AUTOPILOT_NETWORK_BACKOFF_MS_BASE` | 2000 | 指数退避基数（ms） | No |
| `AUTOPILOT_TOOL_APPROVAL_TIMEOUT_MS` | 0 | 工具审批超时（0=永不超时） | No |
| `AUTOPILOT_PROBE_PROMPT` | "上一任务是否已完成？..." | completion probe prompt | No |
| `AUTOPILOT_REVIEW_PROMPT` | (内置 code-reviewer 规则) | 评审 prompt 模板 | No |
| `AUTOPILOT_COMMIT_TRAILERS` | true | commit message 是否包含 trailers | No |
| `AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD` | 0.2 | token 剩余比例低于此值强制出环 | No |

---

## ADR (Architectural Decision Record)

- **Decision**: 采用独立模块 + 纯函数 reducer + FIFO 事件队列架构实现 autopilot 状态机
- **Drivers**: 改动隔离度、可测试性、零新依赖、并发安全
- **Alternatives considered**: (1) 内嵌 claude-sdk.js Hook 化 — 耦合度过高; (2) XState actor model — 引入不必要依赖，团队无经验，此规模下 DSL 开销 > 收益
- **Why chosen**: 独立模块可整目录删除回滚；纯函数 reducer 单元测试覆盖率可达 100%；显式 FIFO 队列在 ~10 状态规模下足以解决并发问题，比 XState invoke/cancel 更透明可调试
- **Consequences**: 需定义清晰的 orchestrator ↔ claude-sdk 接口契约；options 对象内部扩展（onQueryCreated, toolApprovalTimeoutMs）；初期多 ~7 个新文件
- **Follow-ups**: (1) 后续支持 cursor/codex/gemini provider 时，orchestrator 需抽象 provider adapter; (2) bypassPermissions 白名单机制待第二期; (3) completion probe 独立短 session 模式待 token 成本验证后决定

---

## Architect Review Response

### 必改 1：插入点订正

- **原文**：Step 4 插入点为 `:699（complete 事件后）`
- **改成**：插入点为 `:689（for await 循环 } 闭合后、:690 removeSession 之前）`。autopilot 模式下 `return` 跳过整个 cleanup 链路（removeSession / cleanupTempFiles / ws.send(complete) / notifyRunStopped）。错误分支 :709 同样拦截，委托 orchestrator.onSdkError()。
- **在哪一节**：`## 文件级步骤 > Step 4`，含精确代码示例和 WHY 注释

### 必改 2：Orchestrator 并发与生命周期设计

- **原文**：Step 3 仅描述 orchestrator 类和接口，无并发设计
- **改成**：新增完整章节 `## Orchestrator 并发模型`，包含：FIFO EventQueue 类型签名 + 实现伪代码、activeAutopilotSessions 句柄结构、currentQuery 更新机制（通过 onQueryCreated 回调）、三步 abort 协议代码级流程、SDK interrupt() 行为假设与验证步骤、abortClaudeSDKSession 的 autopilot 委托分支
- **在哪一节**：`## Orchestrator 并发模型`（新增独立章节，位于架构选型之后、状态机之前）

### 必改 3：状态枚举 / 权限策略

- **原文**：状态枚举无 WAITING_PERMISSION；Risk 4 描述模糊
- **改成**：选择方案 P2（显式声明 frozen）。EXECUTING 中 permission 等待由 SDK 内部 Promise 阻塞，状态机不迁移。`toolApprovalTimeoutMs: 0` 永不超时。前端通过 `pendingPermission` 字段显示等待状态。状态枚举保留 WAITING_PERMISSION 定义仅供 UI 标签用途，迁移表不使用。
- **在哪一节**：`## 状态机 > Permission 策略` + `## 风险 > 4. Permission 等待` + `## 测试计划 > Permission 超时测试`
