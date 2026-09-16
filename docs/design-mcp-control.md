# MCP 中间层控制设计（dsh_mcp_search + dsh_mcp_call + 私有 catalog）

> 状态：已实施（P0-P4 + v0.4.1 采集链路修复 + v0.4.2 按状态过滤/面板开关 + v0.6.0 改名与 5 项新特性，见 §12） · 基于 2026-08 全部实测结论 · 关联 README「工作原理」

## 1. 背景与目标

现有插件（dsh-mcp-skill-panel）已实现**人工** MCP 启停面板。本设计新增**模型自主按需使用 MCP** 的形态 2（中间层代理）：

- 模型面：`dsh_mcp_search`（按需检索目录，返回 top-K 精确 schema）+ `dsh_mcp_call`（保活启用 → 插件内执行 → 空闲回收）
- **可见性由用户启停决定**（v0.4.2）：用户打开的 server 工具进上下文（memory 高灵敏召回）；用户停用的 server 对模型隐藏、经中间层按需调用；AI 临时启用的 server 不污染上下文
- MCP 默认全停 → 模型按能力需要临时启用 → 用完自动回收

### 实测依据（2026-08）

| 项 | 数据 | 来源 |
|---|---|---|
| enable 耗时 | python 1.7s / npx 6~10s（server 启动主导） | 时序探针 |
| disable 耗时 | ~30ms；注销（模型视图消失）~214ms | 时序探针 |
| 调用模式 | 11 次调用集中 35s 窗口，同 MCP 连击间隔 ≤2s | 子代理实测（bilibili+识图 / calcmcp 数学题） |
| 单次调用 | calcmcp/chrome <1.5s；mimo 识图 ~5s（外部推理，与连接无关） | 同上 |
| 结论 | **保活远优于瞬态**，窗口建议 30s | 数据分析 |

## 2. 架构总览

```
┌─ 模型可见面（恒定 2 工具）──────────────────────┐
│  dsh_mcp_search(关键词) → top-K 精确 schema    │
│  dsh_mcp_call(server, tool, args) → 执行结果   │
└───────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌─ 私有 catalog ────────────────┐  ┌─ 控制层（dsh_mcp_call 执行体）─────┐
│  server → 工具 schema 快照     │  │  保活启用（loader.update）          │
│  · tools/change 增量采集       │  │  → 等注册（tools/change+轮询）      │
│  · 惰性采集兜底（临时启用快照） │  │  → ctx.tools.execute               │
│  · last-good 持久化 catalog.json│  │  → 引用计数 → 空闲 30s 自动回收    │
└───────────────────────────────┘  └────────────────────────────────────┘
        │                                       │
        ▼                                       ▼
┌─ 每回合装配过滤（按 server 状态）──────────────────┐
│  监听 system-prompt/assemble Waterfall             │
│  → 停用 / AI 临时启用的 server 的 mcp__* 过滤      │
│  → 用户打开的 server 工具保留（模型可见）           │
└───────────────────────────────────────────────────┘
```

## 3. 关键机制确认（已核实源码）

| 机制 | 结论 | 证据 |
|---|---|---|
| 模型工具装配 | `systemPrompt.tools(provider)` 可叠加注册；dsh-tools 内置 provider 注入全部可见 schema | dsh-tools `ctx.systemPrompt.tools((c) => this.wireSchemas(c.scope))` |
| **可见性过滤** | 装配后走 `system-prompt/assemble` **Waterfall**——监听者可改写 `assembly.tools`，过滤 `mcp__*` 即实现「全开但模型不可见」 | dsh-system-prompt `assemble()` 末尾 waterfall |
| loader 启停 | `loader.resolve(id).update({disabled})` 实时 dispose/restart | 已实测 |
| 注册事件 | `tools/change`（工具注册/注销时 root emit）——需 `ctx.root.on` 监听 | 已实测 + 源码 |
| 插件内执行 | `ctx.tools.execute({callId, name, arguments, agent, signal})`——正式插件环境（沙箱门面无 execute） | 源码 + 探针边界发现 |
| scope 读取 | `tools.schemas/get(scopeOf(agent.ctx))`——agent 对象会落回全局视图 | 已实测 |

## 4. 组件设计

### A. 可见性过滤（模型侧核心）

- 注册 `ctx.root.on('system-prompt/assemble', ...)`：按 server 状态过滤 `assembly.tools`（v0.4.2），然后 `return next()`
- 判定：`isMcpVisible(serverName)` = 非 AI 临时启用 且 loader entry 非 disabled。**用户打开的 server（含预设默认启用）工具保留进上下文**（memory 高灵敏召回、filesystem 直接读写）；**停用的 server 过滤**（经 dsh_mcp_search/dsh_mcp_call 按需调用）；**AI 临时启用（dsh_mcp_call 保活中）的 server 仍过滤**（按需不污染、无上下文抖动）
- 每回合装配时执行，实时生效；tools registry 不受影响（`tools.execute` 照常）
- **用户手动打开 = 清除 AI 标记**：toggleMcp 启用方向调用 `controller.markUserEnabled()`（清 aiEnabled/计数/lastUsed + state.json ai owner），转为「用户打开」语义 —— 模型立即可见、回收器不再回收
- ✅ **已实测（2026-08-17 动态探针）**：`ctx.on('system-prompt/assemble')` 可收到事件（emit ctx 向下传播到后代 ctx），监听器改写 `assembly.tools` 后经 `next()` 传导成立。standing scope 基线 96 工具（含 56 个 `mcp__*`）→ 全过滤后 40 工具（0 个 `mcp__*`），非 MCP 工具原样保留；按状态过滤路径（用户打开保留 / 停用过滤）随 v0.4.2 部署验证

### B. 私有 catalog

- **数据**：`{ [serverName]: { tools: [{name, description, parameters}], fetchedAt, source: 'live'|'cached' } }`
- **采集通道**：
  1. 增量快照（主）：`tools/change` 后，对 enabled server 用 `tools.schemas(scopeOf(agent.ctx))` 分组快照（preset 层共享，任一 agent 的 scope 即可）
  2. 惰性采集兜底：`dsh_mcp_search` 命中 catalog 缺失的 server → 临时 enable → 等注册 → 快照 → 若原 disabled 则立即 disable
- **持久化**：`~/.dsh/dsh-mcp-skill-panel/catalog.json`（0600），启动加载 + 变更写回（复用状态文件模式）
- **检索**：关键词分词 + 打分（name 权重最高 > description > 参数名），顺序扫描（工具数 ≤1000 时毫秒级；超过再考虑索引）→ top-K（默认 5，上限 10）
- **面板联动**：state 端点 mcp 行的 `tools/tokens` 优先显示 catalog 值（停用态也能看到「目录中有 173 个工具」）

### C. dsh_mcp_search 工具

- 参数：`{ query: string, server?: string, limit?: number }`
- 行为：
  - 带 `server`：列出该 server 的全部工具（精简名 + 一句话描述）
  - 带 `query`：全文检索 top-K，返回**完整 schema**（name/description/parameters）
  - 无 query 无 server：返回能力摘要表（见 E）
- 输出：JSON 文本（render 为 text）

### D. dsh_mcp_call 工具（控制层）

- 参数：`{ server, tool, arguments }`（server 用 catalog 里的 serverName）
- 执行体：
  1. 解析 loader entry（`include:agent-presets:mcp-<server>` 的完整 id 映射——从 loader entries 按 serverName 反查）
  2. **保活启用**：若 disabled → `update({disabled:false})`；引用计数 +1
  3. **等注册**：轮询 `tools.get('mcp__<server>__<tool>', scopeOf(exec.agent.ctx))`（间隔 50ms，超时 = server 的 toolCallTimeoutMs 或默认 60s）+ `tools/change` 事件加速
  4. **执行**：`ctx.tools.execute({callId: 'mcp-call-'+random, name, arguments, agent: exec.agent, signal})`——signal 用 AbortController 合并（超时 + 调用方取消）
  5. **计数与回收**：执行完成计数 -1；空闲回收器（`ctx.interval`，每 10s 扫描）对「启用且计数=0 且 lastUsed 超过 keepAliveMs（默认 30_000）且非用户手动启用」的 server 执行 disable
  6. 返回 execute 结果（isError 时返回错误文本）
- **并发**：同 server 引用计数（多会话同时调用不误关）；**所有权**：仅回收「AI 启用的」（状态文件 owner 标记 ai|user，复用 toggle 持久化通道）
- 失败路径：enable 失败 / 注册超时 / execute 失败 → 明确错误文本 + 计数回滚 + 若本次启用则立即恢复原状态

### E. 能力摘要表（静态配置）

- Config 新增：`serverSummary: Record<string, string>`（内置默认 + 用户可覆盖），如：
  - `cheatengine: 游戏进程内存读写与调试`
  - `mimo-image: 图片理解与描述（小米 MIMO 多模态）`
  - `chrome: 浏览器自动化（导航/点击/截图/控制台）`
- 用途：dsh_mcp_search 空查询时返回；辅助模型「知道有哪些 MCP」

## 5. 配置项（Config 扩展）

```ts
{
  autoManage: boolean          // false（默认）：现状，纯面板；true：形态 2 激活
  keepAliveMs: number          // 默认 30_000，空闲回收窗口
  searchLimitDefault: 5        // dsh_mcp_search top-K 默认
  searchLimitMax: 10
  serverSummary?: Record<string, string>  // 能力摘要表
}
```

autoManage=false 时：不注册 dsh_mcp_search/dsh_mcp_call、不过滤装配、回收器不启动——**零行为变化**（向后兼容）。

### 5.1 面板可写配置（state.json，v0.6.0 起）

面板/HTTP 写侧统一落 `~/.dsh/dsh-mcp-skill-panel/state.json` 的 `config` 段（读侧 getter 优先于 cordis `Config`）—— **`toolBudget` / `autoManageByRoute` / `middleLayerHides` 不在 cordis `Config` 里**，措辞上不要写成「cordis config 项」：

| 配置项 | 取值 | getter / 读写端点 | 说明 |
|---|---|---|---|
| `autoManage` | `false` / `true` | `GET\|POST /config` | 形态 1 ↔ 形态 2 总开关 |
| `applyMode` | `immediate` / `next-session` | `stateApplyMode` / `GET\|POST /config` | 手动开关生效时机 |
| `toolBudget` | 正整数 / 缺省 | `stateToolBudget` / `GET\|POST /config`（`null`=清除） | 工具数红线，见 §12.3 |
| `autoManageByRoute` | `Record<string, boolean>` | `stateAutoManageByRoute` / `POST /config` 的 `routeOverride` 单条增删 | 按模型分流，见 §12.4 |
| `middleLayerHides` | `'disabled'` / `'all'` | `stateMiddleLayerHides` / `GET\|POST /config` | 中间层隐藏范围，见 §12.5 |

> 重挂边界：`autoManage` / `middleLayerHides` / `routeOverride` 任一改动会让中间层重挂（`tools/change` → 该轮前缀缓存 miss）；`applyMode` / `toolBudget` 改动**不**重挂。

## 6. 与现有代码的关系

| 现有件 | 复用/扩展 |
|---|---|
| loader resolve/update、状态文件、`ctx.root.on` 事件订阅 | 直接复用 |
| toggle 持久化（state.json） | 扩展 owner 标记（ai/user） |
| 面板 state 端点 | mcp 行 tools/tokens 改读 catalog 优先 |
| 分域缓存/事件失效 | 不变 |

新增文件：`src/catalog.ts`（采集/检索/持久化）、`src/mcpcall.ts`（控制层+回收器）、`src/filter.ts`（装配过滤）；`src/index.ts` 接线。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `system-prompt/assemble` 改写传导（已解除） | ✅ P0 探针实测通过：`assembly.tools` 改写经 Waterfall `next()` 传导，`mcp__*` 56→0；无需瞬态退路 |
| 保活期间其他会话模型回合恰好装配（过滤前） | 过滤是全局装配点，启用与装配无关——无此风险（过滤机制成立时） |
| 工具重名/多 server 同名工具 | 完整 id `mcp__<server>__<tool>` 唯一；server 名冲突时 loader 行反查报错 |
| dsh_mcp_call 参数透传失败（实测案例 B 第 6 次失败） | 返回 server 原始错误文本，模型自行重试（与直接调用体验一致） |
| catalog 采集的 scope 依赖 | 任一会话存在即可采集；无会话时惰性采集通道（临时启用）兜底 |
| 回收误关用户手动启用的 | owner 标记：仅回收 AI 启用的 |

## 8. 实施计划

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | 验证 `system-prompt/assemble` 过滤传导（动态探针：装配过滤 + 确认模型请求工具列表无 mcp__） | ✅ 通过（2026-08-17 探针：96→40 工具，`mcp__*` 56→0） |
| P1 | catalog：采集/检索/持久化/惰性采集 + 单测 | ✅ 已提交（c42f5ab）+ selftest-mcp.mjs 单测 |
| P2 | mcp_call + 保活回收 + mcp_search + 能力表 + autoManage 接线 | ✅ 已提交（c42f5ab）+ **案例复测通过（2026-08-16）**：案例 1 chrome→bilibili→mimo 识图全链路；案例 2 calcmcp 8 次连击零重复 spawn（进程恒 1）+ 30s 空闲自动回收（进程退出 + ai owner 清除） |
| P3 | owner 标记、并发计数、面板联动、README | ✅ 面板联动已提交（0894214）；owner/并发计数随 P2；README 已定稿 |
| P4 | 发布（版本 bump + 产物 + 文档） | ✅ v0.4.0 已发布 + 安装验证；**采集链路修复**（见 §11）随 v0.4.1 |

## 9. 测试方案

- **P0 探针**：动态插件注册 `system-prompt/assemble` 过滤 → 触发一次模型装配（或调用 systemPrompt.assemble 直接验证）→ 断言 assembly.tools 无 mcp__*
- **案例复测**（P2 后）：
  1. chrome 打开 bilibili → 提取封面 → mimo 识图（验证跨 server 链路 + 保活回收）
  2. calcmcp 数学题极值（验证连击场景：5~7 次调用在 30s 窗口内零重复 spawn）
- **回归**：autoManage=false 行为零变化；手动面板启停/持久化/事件失效全部原样

## 10. 决策记录

- **保活 30s 而非瞬态**：11 次调用 35s 窗口、连击 ≤2s（实测）；瞬态每次 spawn 1.7~10s 不可接受
- **过滤走 assemble Waterfall 而非 systemPrompt.tools provider**：provider 是并集（只能加不能减），Waterfall 可改写既有输出
- **catalog 自建而非引入 Lens**：数据源（tools registry 快照）现成，~300-400 行；Lens 需自建 MCP 客户端且与 loader 体系割裂
- **过滤监听挂 ctx（后代 ctx 可收 root 事件）**：P0 探针证实 `ctx.on('system-prompt/assemble')` 在动态插件沙箱可用（事件自 emit ctx 向下传播），正式插件用 `ctx.root.on + ctx.effect` 双保险（root 监听不随 fiber 清理，需 effect 归还 disposer）

## 11. 采集链路事故与修复（v0.4.1 实测记录）

**现象**：重启后停用态回填为 0；`catalog.json` 被空快照覆盖。

**根因（2026-08-16 动态探针 + 诊断端点逐步定位）**：

1. **apply ctx 的 `ctx.agents` 为空**：bundle 插件行挂载 ctx 下 `agents.roots()/list()` 恒为 0（realm 隔离），而 webServer 注入的 httpCtx 正常 —— 同一 `liveSchemas()` 在两种上下文结果不同（0 vs 53 工具）。catalog 采集从 v0.4.0 起就依赖 apply ctx 的 agents → 自动采集恒空 → 空快照写盘覆盖 last-good。
2. **last-good 守卫失效**：`if (tools.length === 0 && prev && prev.tools.length > 0 && prev.source === 'cached')` —— 磁盘加载的 `prev.source` 是 `'live'`（保存时写入的），守卫永不成立。
3. **启动早期空采集写盘**：loadCatalog（异步）完成前，初始快照 + tools/change 风暴快照均为空 → 若守卫失效则空写盘。
4. **persistCatalog 写盘竞态**：`persisting` 期间的新变更直接 return 丢弃（dirty 悬挂）。

**修复**：
- `resolveScopeSchemas()`：agent 不可得时 fallback `agentPresets.standingKeyFor()`（注册表查询，不依赖 agents 实例）
- last-good 守卫去掉 `source === 'cached'` 条件
- `loaded` 门：磁盘加载完成前跳过采集
- persistCatalog 写盘期间置 dirty 排队补写
- 新增 `/api/mcp-skill-panel/debug`（只读诊断）+ `/debug/collect`（手动触发采集），保留作运维工具

**复测结论（2026-08-16）**：修复后自动采集 `lastMcpTools: 53` ✓、磁盘写盘正常（catalog.json 93KB）、面板停用态回填正常（calcmcp 停用仍显示 3 工具）。

## 12. v0.6.0 新增特性（批量启停 / 有效统计 / 工具预算 / 按模型分流 / hides）

> 来源：PR #16（控制工具改名 `dsh_mcp_search`/`dsh_mcp_call`）+ PR #17（特性 1–5）。本节只写契约与口径；命名与旧名处理见 README「控制工具名（0.6.0 起）」注（历史留档 `decisions/`、`docs/*patch-notes*.md` 中的旧名不改）。

### 12.1 工具级批量启停（`POST /mcp/toolBulk`）

- 内核 `setToolsDisabledBulk(serverName, toolNames, disabled)`：**一次** state.json 读-改-写（绝不 N 次写盘），与单点 `setToolDisabled` 同表同分派（全局表 `state.toolDisabled[server]` / 项目表 `state.projectToolDisabled[owner][server]`），批量与单点可任意交替。
- 路由层纯函数 `resolveToolBulkTargets(known, toolNames)` 的**三态**契约：
  - **省略 / 缺字段** = `known` 全部（该 server 面板视图里的 live schemas，缺失时回退 catalog 快照）；
  - **显式数组** = 精确集合；`[]` 是合法空操作（不写盘、`changed: 0`、仍 200）；
  - **非数组**，或**非空却一条都不匹配** `known` → 400（既不静默降级为「全部」，也不静默 no-op）。
- 目录整体不可得（`row.toolList` 为空：从未启动且无 catalog 快照）→ 400，提示先启用一次让工具被发现。
- 响应 `{ serverName, disabled, disabledTools, disabledCount, changed, ignoredToolNames }`（`toolToggle` 的同形超集）：`ignoredToolNames` = 点名了但不在当前 `known` 里的项，把「以为动了 N 条、实际只动交集」的偏差显式化。
- **已知边界**：`known` 取自 **60s TTL 缓存视图** → 「省略 = 全部」指的是「当前缓存视图的全部」，缓存窗口内的目录变化不会进本次批量。

### 12.2 有效统计（工具级启用数）

- 字段：`McpRow.toolsEnabled` / `tokensEnabled`、`McpView.mcpToolsEnabledTotal` / `mcpTokensEnabledTotal`。
- 谓词与工具级禁用**同源**：`isToolDisabled(fullName, workspace)` + 会话工作区（`cwd`），得出的是「**工具级启用数**」。
- **口径边界（不得写成「实际进入上下文」）**：不扣 ① server 级隐藏（`dsh_mcp_call` 保活中的 AI 临时启用、`middleLayerHides='all'` 下的全部 server）；② project-mcp 的工作区过滤。

### 12.3 工具预算（`toolBudget`）

- 「全部工具数」（含 read/edit/bash/skill 等非 MCP 工具）取数在 `toolsAllCounts()`：
  - **优先请求面真值** `agent.session.requestHeader()?.tools`（`EpochHeader.tools` = 装配后工具表，已是全部装配过滤器跑完的结果，对 provider 上限是正确的比较对象）→ `toolsAllSource='request'`；此时 `total === enabled`（装配后已无可扣的工具级禁用）。代价是**一轮延迟**（读到的是上一次请求）。
  - 取不到（冷启动 / 无会话上下文 / 诊断装配）→ 回退**注册表**口径 `schemas.length - (mcpToolsTotal - mcpToolsEnabledTotal)`，标 `'registry'` —— 不扣 server 级隐藏与项目工作区过滤，**是近似值**。
- `toolsAllSource` 必须透出到面板与 API；UI 在卡片上标注来源；红线比较只与展示同源的那个数比。
- `toolBudget` 存 **state.json**（`state.config.toolBudget`），**不在** cordis `Config`；`POST /config` 的 `null` = 清除，只接受 >0 的有限数。数值本身只是可配置默认值/示例（如 Grok 350），不得写成断言式结论。

### 12.4 AI 中间层按模型分流（`autoManageByRoute`）

- 键：`provider`（如 `grok`）或 `provider/model`（如 `grok/grok-4.6`）；查表序 **`provider/model` → `provider` → `autoManage` 总开关**。
- **落点分层（关键）**：进程级「控制工具与网关是否存在」由 `applyAutoManage` 的 `needed = on || 任一覆盖项为真` 决定；每回合「这个模型看得见什么」由装配过滤的 `gateFor` 决定。**不得**把按模型分流做成挂载/卸载开关 —— 那会触发 `tools/change` → 全会话前缀 100% miss。
- 会话侧判定 `decisionFor(agent)` → `{ on, source: 'model' | 'provider' | 'master' | 'no-route', route }`（取值见 `src/model-route.ts` 的 `routeDecision`：`'model'` = 命中 `provider/model` 精确项、`'provider'` = 命中 `provider` 项、`'master'` = 落到总开关、`'no-route'` = 未解析出模型）；`context.agent` 缺席（诊断装配）或投影服务不可得时**保守回退总开关**（`source='no-route'`），面板显式展示来源，避免「配了却没生效」的静默降级。
- **读数分层（勿混）**：`/state` 的 `autoManageByRoute` 是**运行期**表（gate 实际读的那张），`autoManageByRoutePersisted` 是 state.json 的**用户意图**。挂载失败时 `applyAutoManage` 的 catch 会清空运行期表而意图保留 → 面板覆盖卡按两表**并集**渲染，给「已持久化但当前未生效」的键挂「已保存，未生效」标记，使其可见且可删（改的只是读数面，`decisionFor` 仍只看运行期表）。
- `/config` POST 用 `routeOverride: { key, value }` 单条增删（`value: null` 删键）；只有 `autoManage` / `middleLayerHides` / `routeOverride` 变化才重挂中间层。**面板侧须带等值守卫**（点已选中的那一段不发请求）—— 否则一次无谓的 `applyAutoManage` 就是该轮前缀缓存 miss。
- 覆盖项为真时即使总开关关也会挂载中间层（否则出现「gate 打开但网关没挂」→ 覆盖模型看得到 `dsh_mcp_search` 却拉不起 preset 关态行）。
- **面板数据源（v0.6.0 补齐）**：覆盖卡的**可点范围**来自 `GET /models`（读端点，**无鉴权**，与其它读端点一致；`providers` + `active` + `cached` + `fetchedAt`，见 README 端点表）。它是本仓唯一会**扇出到 LLM adapter** 的读端点（`/state` 同样会扇出，但扇到的是 MCP server 侧），故 `MODELS_TTL_MS = 60_000` 的 TTL 缓存 + 单飞不是性能优化而是边界：把开放端点的扇出上界锁死为 60s 一次。单次抓取另有 `MODELS_FETCH_TIMEOUT_MS = 8_000` 上界 —— 无上界的话，一个**永不 settle** 的 `listModels` 会被单飞钉住，端点在该 adapter 恢复前对**所有**调用者不可用（且无报错）。超时只改本次请求的返回（空目录 + `cached:false`），不写缓存、不动 `fetchedAt`，并清掉在飞标记让下一个请求能重新抓取；迟到的真实结果仍照常写缓存（数据仍是新鲜读数）。
- **三条降级路径都不抛**（开放读端点上任何抛都会变成 500 把整张卡片打成错误态）：`llm` 缺失 → `providers: []`；`listProviders()` 抛错 → `providers: []`；单个 provider 的 `listModels()` 抛错 → **只**该 provider `models: []`。前端拉取失败 → 降级为「只列键」的旧行为，不阻断卡片。
- **`active` 与 `/state` 的 `autoManageActive` 同源**：两处都走 `src/model-route.ts` 的 `activeRouteView(decision)`（`{ on, source, provider, model }`）—— 「面板高亮哪条是当前路由」与「gate 按哪条判定」不得各写一份。
- **界线**：目录只影响**可点范围**（任意 `provider` / `provider/model` 键都能预置规则，不必先切到该模型），**不影响 gate 语义** —— 查表序、`decisionFor` 的输入、以及运行期表 / 持久化表的读数分层全部原样不变。

### 12.5 `middleLayerHides`

- 默认 `'disabled'`：只隐藏「用户停用 + AI 临时启用」的 server；`'all'`：**连已启用的 server 也从模型装配面隐藏**，模型统一经中间层取用。
- 它只改写本次装配的 `assembly.tools`：工具注册表与 `ctx.tools.execute` 通道不受影响，`dsh_mcp_call` 仍能拉起 preset 关态行（前提：中间层已挂载）。
- **与能力摘要表、行徽标的一致性**：`'all'` 时空查询摘要表按「经中间层取用」表述，不得再宣称 server「对模型可见」——否则摘要说可见、装配却全隐藏，两条信息互相矛盾。面板行徽标同理：`McpRow.modelVisibleScope`（`'direct'` / `'via-middle-layer'` / `'hidden'`）在 `'all'` 且本会话 gate 打开时给「经中间层取用」，`modelVisible`（= `scope === 'direct'`）不再可能在实际隐藏时仍为真。

### 12.6 控制工具参数契约（`arguments` 收紧）

- `dsh_mcp_call` 的 `arguments` 声明为 `type:'object' + additionalProperties:true`（dsh-tools DSL 要求 `additionalProperties` 显式给 boolean；`type:'json'` 只生成无 type 的注解节点）。
- 后果：**字符串形态的 `arguments` 被参数校验前置拒绝**（`invalid arguments: "arguments" must be an object`），不再走 `normalizeArguments` 的透明解析。这是有意的收紧，故工具描述里写明「必须传 JSON 对象本身」。
- 旧会话上下文可能残留旧习惯（先传一次字符串被拒）→ 模型看到错误后自愈；`arguments` 的对象形态是唯一受支持入口。
