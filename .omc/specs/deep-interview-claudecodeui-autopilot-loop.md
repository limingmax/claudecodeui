# Deep Interview Spec: claudecodeui 阶段式托管自动化

## Metadata
- Interview ID: di-claudecodeui-autopilot-20260518
- Rounds: 5
- Final Ambiguity Score: 15%
- Type: brownfield (基于 claudecodeui)
- Generated: 2026-05-18
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 0.35 | 0.322 |
| Constraint Clarity | 0.85 | 0.25 | 0.213 |
| Success Criteria | 0.80 | 0.25 | 0.200 |
| Context Clarity | 0.78 | 0.15 | 0.117 |
| **Total Clarity** | | | **0.852** |
| **Ambiguity** | | | **0.148 (15%)** |

## Goal
在 claudecodeui 内新增一个**"阶段式可选托管"自动化模式**，把用户当前"输入需求 → /deep-interview → 执行 → 中断/继续循环 → 评审 → 修复 → 提交（不push）"流程中**除 deep-interview 问答外的所有人工值守环节**自动化掉。模式由用户在前端按阶段开关启用，开启后服务端状态机驱动 Claude Code SDK 在各阶段间自动流转。

## Constraints
- **Provider 范围**：MVP 仅覆盖 Claude（走 `server/claude-sdk.js`），后续可扩 cursor/codex/gemini
- **deep-interview 阶段保持人工**：用户回答问题不算"值守成本"，不自动化
- **执行阶段含两类自动化**：
  - (a) "完成度探针"：SDK generator 自然结束后，用 resume 同 sessionId 发一个短 query：「上一任务是否已完成？只回答 COMPLETED 或 NOT_COMPLETED」。COMPLETED → 转评审；NOT_COMPLETED → 自动追问"继续"
  - (b) "网络中断续传"：generator 抛错（中转站/网络）→ 自动 resume 同 sessionId 发"继续"，最多 N 次（带指数退避）
- **评审-修复闭环**：调用 `oh-my-claudecode:code-reviewer` 类似的内部 agent / skill 评审；reviewer 报告含 high/critical 严重度问题 → 切回执行阶段（带 reviewer 报告作为新需求）→ 评审；reviewer 仅含 low/medium 或无问题 → 出环
- **提交阶段**：自动 `git add` 已变更的工程文件 + `git commit`，严格遵 `C:\Users\Docker\.claude\CLAUDE.md` 规定的 commit 规范：conventional commit subject + 可选 body + trailers (Constraint / Rejected / Directive / Confidence / Scope-risk / Not-tested)。**禁止 push**
- **CLAUDE.md 冲突显式 override**：CLAUDE.md 有"不要自动提交代码"规则；本功能视用户开启提交阶段托管开关 = 用户明确授权 commit，是定向 override 而非违反
- **上限护栏（默认值 + 可配置，环境变量 + settings.json）**：
  - `AUTOPILOT_MAX_CONTINUE`：默认 5（"继续"轮次）
  - `AUTOPILOT_MAX_REVIEW_FIX`：默认 5（评审-修复闭环轮次）
  - `AUTOPILOT_MAX_NETWORK_RETRY`：默认 3（generator 抛错重试）
  - `AUTOPILOT_NETWORK_BACKOFF_MS_BASE`：默认 2000（指数退避基数）
  - 达上限 → 停下、发 push 通知 + WS 事件、保留状态供人工接管
- **可观测性**：每次状态机迁移（continue / 完成度探针结果 / review→fix / commit）都发 WS 事件 + 写入会话历史，前端可看进度条
- **安全可中止**：原 `abort-session` 必须立即停掉整个自动化状态机（不只是当前 SDK query）

## Non-Goals
- 不自动 push 到远端
- 不为 deep-interview 的 Q&A 本身做自动化
- 不替代项目现有的 chat WS 协议（在上面加层，不重写）
- 不引入新的 LLM provider；仅基于现有 claude-agent-sdk
- 不做跨会话的"批处理队列"（用户答案是阶段托管 vs 队列后台）
- 不做主分支保护逻辑（push 已禁，分支策略由用户在 commit 前自己定）

## Acceptance Criteria
- [ ] 前端 chat 面板新增"自动化模式"控制区，每个阶段（执行 / 评审-修复 / 提交）有独立开关，可全开/全关/任选；deep-interview 阶段无开关（恒人工）
- [ ] WS 消息协议扩展：`claude-command` 的 `options` 接受 `autopilot: { execution: bool, reviewFix: bool, commit: bool, limits?: {...} }` 字段
- [ ] 服务端新增"自动化状态机"模块（建议 `server/modules/autopilot/` 或挂在 `claude-sdk.js` 后处理层），覆盖以下转换：
  - `EXECUTING` → SDK generator 异常 → `RETRY_NETWORK`（重试 ≤ `AUTOPILOT_MAX_NETWORK_RETRY`，带退避，超限 → `FAILED`）
  - `EXECUTING` → SDK 自然 complete → `COMPLETION_PROBE`（resume + "completion check"）
  - `COMPLETION_PROBE` → 返回 `NOT_COMPLETED` → `EXECUTING`（resume + "继续"，计数 ≤ `AUTOPILOT_MAX_CONTINUE`）
  - `COMPLETION_PROBE` → 返回 `COMPLETED` → 评审开关开 ? `REVIEWING` : 提交开关开 ? `COMMITTING` : `DONE`
  - `REVIEWING` → 评审报告无 high/critical → 提交开关开 ? `COMMITTING` : `DONE`
  - `REVIEWING` → 评审报告有 high/critical → `FIXING`（计数 ≤ `AUTOPILOT_MAX_REVIEW_FIX`，超限 → `DONE`，把未解决项写入 commit message）
  - `FIXING` → 完成 → `REVIEWING`
  - `COMMITTING` → 成功 → `DONE`；失败 → `FAILED`
  - 任何状态 + 用户 `abort-session` → `CANCELLED`
- [ ] "完成度探针"实现：用相同 sessionId resume + prompt 强约束「只能回答 COMPLETED 或 NOT_COMPLETED」；解析鲁棒（大小写/中文等价词），无法解析视为 `NOT_COMPLETED` 安全续
- [ ] "网络中断续传"实现：捕获 `for await (const message of queryInstance)` 抛出的异常，区分网络/中转错误（按 message 关键字 / SDK error code）vs 真错；网络类自动 resume + "继续"
- [ ] 评审阶段：服务端发起新 query（resume 同 sessionId 或新会话，由架构决定），prompt 触发"按 `oh-my-claudecode:code-reviewer` 规则评审本次改动"；解析输出找 high/critical 字样
- [ ] 提交阶段：调用现有 `server/routes/git.js` 的提交接口（如有）或新增 `commitWithCC` 服务；commit message 由一次额外 Claude query 生成，必须包含 trailers；**确认不 push**
- [ ] WS 事件：新增 `autopilot.state_changed`、`autopilot.iteration`、`autopilot.limit_reached`、`autopilot.completed`、`autopilot.failed`，前端有可视化
- [ ] 单元测试覆盖状态机所有迁移；集成测试覆盖：网络异常重试、completion probe 解析、评审循环出环、commit 不 push
- [ ] 通过 `npm run typecheck` 与 `npm run lint`
- [ ] 文档：在 README / 设置页加一段 autopilot 使用说明

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "全自动 = 一键托管完整链路" | 阶段式 vs 全链路 vs 队列三选一 | 用户选阶段式，可逐阶段开关 |
| "中断主要是 token/permission" | 多选中端点 | 实际是网络/中转站故障导致 generator 截断；token / permission 不算中断 |
| "需要复杂启发式判'完成'" | Contrarian 反问：可不可以一律切评审让 reviewer 兜底 | 用户改为"完成度探针" — 单 query 让 Claude 自报，更经济也更可信 |
| "评审通过 = 所有问题都修" | 严重度分级方案 | 仅 reviewer 报告 high/critical 才回流 fixing；low/medium 留作 follow-up |
| "上限要硬编码" | 配置 vs 硬编码 | 默认值适中 + 全部可配置（env + settings.json） |
| "auto-commit 违反 CLAUDE.md" | 是否冲突 | 用户开启提交托管开关 = 显式授权，定向 override，非违反 |

## Technical Context (brownfield 关键事实)
- **`server/claude-sdk.js`**：
  - `queryClaudeSDK(command, options, ws)` — 入口；`for await` 在 :642–688 流式消费 SDK；`complete` 事件在 :699 发出
  - `activeSessions` Map 存 `{ instance, status, writer, ...}`，是状态机外存的天然候选
  - `sdkOptions.hooks.Notification`（:509）已挂；可加 `Stop` hook 但用户答案让状态机更可控
  - `permissionMode` / `bypassPermissions` 模式可由 autopilot 在执行阶段自动设
  - `resume: sessionId`（:221）就是续会话的官方姿势
- **`server/modules/websocket/services/chat-websocket.service.ts`**：
  - 处理 `claude-command` / `abort-session` / `claude-permission-response` / `check-session-status`
  - 自动化状态机要在这层之前/之上做拦截或包装
- **`server/services/notification-orchestrator.js`**：
  - 已有 `notifyRunStopped` / `notifyRunFailed`；autopilot 限额触达 / 失败 / 完成走这里
- **`shared/utils.ts` `createNormalizedMessage`**：所有 WS 消息工厂，新增事件类型走它
- **`server/routes/git.js`**：commit 路径预计在这；按需新增 `commit (no push)` 路由或服务
- **关键路径行号**：`claude-sdk.js:642`（迭代消费起点）、`:690`（generator 结束清理点）、`:709`（错误分支）、`:728`（notifyRunFailed）

## Ontology (Key Entities)
| Entity | Fields | Relationships |
|--------|--------|---------------|
| `AutopilotSession` | id, claudeSessionId, state, limits, counters{continue, reviewFix, networkRetry}, toggles{execution, reviewFix, commit}, history[] | 1-to-1 `activeSessions[claudeSessionId]` |
| `AutopilotState` (enum) | EXECUTING / RETRY_NETWORK / COMPLETION_PROBE / REVIEWING / FIXING / COMMITTING / DONE / FAILED / CANCELLED | — |
| `AutopilotTransition` | from, to, reason, payload, ts | belongs to `AutopilotSession.history` |
| `ReviewReport` | severityCounts{high, critical, medium, low}, findings[], rawResponse | drives FIXING decision |
| `CompletionProbeResult` | verdict (COMPLETED / NOT_COMPLETED / UNPARSED), rawResponse | drives EXECUTING→REVIEWING decision |

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds)</summary>

### Round 1 — Goal Clarity
**Q:** 你要的"全自动"本质上是哪种交互形态？（全会话托管 / 阶段式可选托管 / 后台任务队列）
**A:** 阶段式可选托管
**Ambiguity:** 58%

### Round 2 — Constraints + Criteria（双问，多选）
**Q1:** "中断后发继续"主要哪几种场景？
**A1:** 网络中断 / 中转站问题导致请求中途结束
**Q2:** 哪几个阶段默认必须自动？
**A2:** Interview 人工；执行 / 评审-修复 / 提交（不push）都自动
**Ambiguity:** 40%

### Round 3 — Criteria（评审闭环终止条件）
**Q:** 评审 + 修复 闭环什么时候算结束？
**A:** reviewer 报告无高严重度问题即停
**Ambiguity:** 30%

### Round 4 — Contrarian Mode（挑战"完成判定"框架）
**Q:** 执行 → 评审 的切换信号怎么定？（一律切 / 关键字 / 轮数上限 / 人工确认）
**A:** 在停下来时问 Claude 是否完成，强约束只回答完成/未完成；完成 → 进下一环节，未完成 → 发继续
**Ambiguity:** 22%

### Round 5 — Constraints（护栏 + commit 规范，双问）
**Q1:** 最多 N 轮上限怎么定？
**A1:** 可配置（默认适中）
**Q2:** 提交阶段（不 push）的提交信息规范？
**A2:** 严格遵 CLAUDE.md 的 commit 规范
**Ambiguity:** 15% ✅
</details>
