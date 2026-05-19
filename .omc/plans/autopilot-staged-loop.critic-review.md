## Verdict: APPROVE

## 强制判据评估

### 1. Principle-Option 一致性: PASS

Principles 与最终选择自洽：
- P1（非侵入包装）：选择独立模块 + options 内部扩展（非签名变更），cleanup 链路接管有显式 WHY 注释说明"必要最小侵入"。Principle 1 已修订为"cleanup 链路由 orchestrator 接管属于必要最小侵入"，不存在悄悄违背。
- P2（阶段独立可选）：WS 协议 `AutopilotOptions` 三个独立 bool 开关，reducer 按开关路由（probe_completed 事件按 reviewFix/commit 开关分支），一致。
- P3（安全优先可中止）：三步 abort 协议代码级设计 + cancelled flag + 队列清空，与 Principle 完全对齐。
- P5（最小依赖）：选择纯函数 reducer + FIFO 队列，淘汰 XState，一致。

### 2. Alternatives Fairness: PASS

两组对比表（独立模块 vs Hook 化、reducer vs XState）的 con 描述客观：
- Hook 化的 con "耦合度过高、200+ 行修改、需逐行 revert" 是真实代价，非假弱点。
- XState 的 con "45KB 包体积 + 团队无经验 + 此规模下 DSL 开销 > 收益" 有补充论证段落（~10 状态 ~20 迁移），淘汰理由站得住。
- Architect 的 Antithesis D（reducer 是错误抽象）在 v2 中通过完整的 EventQueue 实现伪代码 + 并发模型章节充分回应。

### 3. Risk Mitigation Clarity: PASS

| 风险 | 缓解措施 | 可观测触发信号 |
|------|----------|---------------|
| R1 CLAUDE.md 冲突 | commit trailer `Directive: autopilot-commit` + 前端提示文案 | commit message 中可 grep |
| R2 评审死循环 | MAX_REVIEW_FIX 硬上限 + findings 列表对比"完全相同"则出环 | `autopilot.limit_reached` WS 事件 |
| R3 token 膨胀 | `extractTokenBudget` 返回 used/total → 剩余 <20% 强制出环；config `AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD` 可配 | `autopilot.limit_reached` 事件 + 日志 |
| R4 Permission 等待 | `toolApprovalTimeoutMs: 0` 永不超时 + `pendingPermission` 字段 + 文档声明限制 | WS `autopilot.state_changed` 含 pendingPermission |
| R5 并发安全 | 前端禁用手动发送 + 服务端 orchestrator 持锁拒绝非 abort command | 锁拒绝时可记日志 |
| R6 进程崩溃 | MVP 限制声明 + autopilot_history 表审计 | 文档明确 |

所有风险均有具体措施 + 可观测信号，无虚词。

### 4. Testable Acceptance Criteria: PASS

Trace 表（Spec AC → 计划步骤 → 测试 case）：

| Spec AC# | 计划步骤 | 测试覆盖 |
|----------|----------|----------|
| AC1 前端控制区 | Step 6 AutopilotPanel.tsx | E2E 最小可行 |
| AC2 WS 协议扩展 | Step 5 + WS 协议扩展章节 | 集成测试: WS 重连推送 snapshot |
| AC3 状态机模块 + 全部迁移 | Step 1-4 | 单元测试: reducer.test.ts 覆盖全部 19 条迁移 |
| AC4 完成度探针 | Step 3 completion-probe.service.ts | 集成测试: COMPLETED/NOT_COMPLETED/UNPARSED 三 case |
| AC5 网络中断续传 | Step 3 side-effect-executor + 错误分类树 | 集成测试: ECONNRESET 重试 + 指数退避验证 |
| AC6 评审阶段 | Step 3 review.service.ts | 集成测试: high/critical 回流 + low 出环 |
| AC7 提交阶段 | Step 3 commit.service.ts | 集成测试: commit 不 push + trailers 验证 |
| AC8 WS 事件 | Step 5 ws-events.ts | 集成测试: 各事件触发验证 |
| AC9 单元/集成测试 + typecheck + lint | Step 2 + Step 7 | 测试计划章节完整列出 |
| (隐含) 文档 | 未在步骤中显式列出 | — |

注：AC 中"文档：在 README / 设置页加一段 autopilot 使用说明"在计划步骤中未显式列为独立 Step，但属于 trivial 补充，不构成阻塞缺陷。

### 5. Concrete Verification Steps: PASS

每个 Step 均可独立验证：
- Step 1-2: `npm run typecheck` + `npm test -- reducer.test.ts`
- Step 3: 集成测试 mock SDK
- Step 4: 修改后 `npm run typecheck` + 现有测试不回归
- Step 5: WS 事件 schema 验证 + abort 测试
- Step 6: 前端组件渲染测试
- Step 7: 完整集成测试套件
- Step 8: migration 执行 + 表结构验证

## 重点核查

### 9 条 AC 覆盖
全部 9 条 AC 在计划中有对应实施步骤（见上方 trace 表）。文档 AC 缺独立步骤但不阻塞。

### WS 事件 payload 与 createNormalizedMessage 兼容性
`createNormalizedMessage` 接受 `NormalizedMessageInput`（kind + provider + 任意扩展字段）。计划 Step 5 修改 `server/shared/utils.ts` 扩展 kind 类型联合。新事件以 `autopilot.` 前缀命名空间隔离，现有前端忽略未知 kind 不报错。兼容。

### 配置项冲突检查
- env 变量：服务端默认值来源（`AUTOPILOT_MAX_*` 系列）
- DB user_settings：前端可改的覆盖层
- 无 settings.json 文件层（spec 提到 settings.json 但计划改为 DB，更合理）
- 优先级：DB > env > 硬编码默认值。无冲突。默认值合理（5/5/3）。

### commit 消息生成细节
计划 Step 3 commit.service.ts 明确：生成含 trailers 的 commit message。`AUTOPILOT_COMMIT_TRAILERS` 配置项控制是否包含 trailers。Risk 1 指定 `Directive: autopilot-commit` trailer 标记授权链路。对于"failed reviewer findings 写到 Not-tested 或 Directive"——计划在迁移表 `review_limit_reached → DONE` 写"未解决项写入 commit body"，具体 trailer 字段未指定（Not-tested vs Directive），但这属于实现细节级别，不阻塞。

### 评审死循环检测
计划写"对比 findings 列表，若与上轮完全相同 → 出环"。未指定比较方式（字符串/hash）。实际实现中 JSON.stringify 后比较或 hash 均可，属于 review.service.ts 内部实现细节。高频 false-positive 场景（findings 顺序不同但内容相同）需排序后比较——这是实现注意事项，不构成计划缺陷。

### token 膨胀缓解
`extractTokenBudget` 在 :292 已存在，返回 `{ used, total }`。计划引用 `AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD = 0.2`，orchestrator 在每次 sdk_complete 事件后检查 `(total - used) / total < threshold` 即可。阈值可配（env 变量）。充分。

### auto-commit 与 CLAUDE.md 冲突追溯
Risk 1 明确：commit trailer `Directive: autopilot-commit` + 前端开关提示文案。授权链路：用户开启 commit 开关 → WS 传 `autopilot.commit: true` → commit.service 写 trailer。可追溯。

## ADR 完整性: PASS

计划包含完整 ADR 章节：
- Decision: 独立模块 + 纯函数 reducer + FIFO 事件队列
- Drivers: 改动隔离度、可测试性、零新依赖、并发安全
- Alternatives considered: Hook 化 + XState（含淘汰理由）
- Why chosen: 可回滚、100% 单测覆盖、透明可调试
- Consequences: 需定义接口契约、options 扩展、初期多 ~7 文件
- Follow-ups: provider adapter 扩展、bypassPermissions 白名单、probe 独立 session 模式

全部必含项齐全。

## 评估结论

计划 v2 在 Architect 两轮审查后已充分回应所有必改项：插入点订正（:689）、并发模型完整设计（EventQueue + 三步 abort + currentQuery 管理）、Permission 策略明确（P2 frozen + toolApprovalTimeoutMs:0）。五项强制判据全部通过。ADR 完整。可交付执行。
