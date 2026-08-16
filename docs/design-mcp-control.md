# MCP 中间层控制设计（mcp_search + mcp_call + 私有 catalog）

> 状态：设计稿（待审阅） · 基于 2026-08 全部实测结论 · 关联 README「工作原理」

## 1. 背景与目标

现有插件（dsh-mcp-skill-panel）已实现**人工** MCP 启停面板。本设计新增**模型自主按需使用 MCP** 的形态 2（中间层代理）：

- 模型面恒定两个工具：`mcp_search`（按需检索目录，返回 top-K 精确 schema）+ `mcp_call`（保活启用 → 插件内执行 → 空闲回收）
- 任何 MCP 工具 schema **永不进入模型上下文**（零长尾污染）
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
│  mcp_search(关键词) → top-K 精确 schema        │
│  mcp_call(server, tool, args) → 执行结果       │
└───────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌─ 私有 catalog ────────────────┐  ┌─ 控制层（mcp_call 执行体）─────────┐
│  server → 工具 schema 快照     │  │  保活启用（loader.update）          │
│  · tools/change 增量采集       │  │  → 等注册（tools/change+轮询）      │
│  · 惰性采集兜底（临时启用快照） │  │  → ctx.tools.execute               │
│  · last-good 持久化 catalog.json│  │  → 引用计数 → 空闲 30s 自动回收    │
└───────────────────────────────┘  └────────────────────────────────────┘
        │                                       │
        ▼                                       ▼
┌─ 每回合装配过滤（模型永不见 mcp 工具）───────────┐
│  监听 system-prompt/assemble Waterfall         │
│  → assembly.tools 过滤 mcp__* 前缀             │
└───────────────────────────────────────────────┘
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

- 注册 `ctx.root.on('system-prompt/assemble', ...)`：`assembly.tools = assembly.tools.filter(t => !t.name.startsWith('mcp__'))`，然后 `return next()`
- 每回合装配时执行，实时生效；tools registry 不受影响（`tools.execute` 照常）
- **影响范围**：autoManage 模式下所有 MCP 工具对模型不可见（含用户手动启用的）——这是设计意图（统一入口）
- 待实测项：Waterfall 监听修改 `assembly` 对象后 `next()` 的传导（预期可修改共享 payload；实测确认）

### B. 私有 catalog

- **数据**：`{ [serverName]: { tools: [{name, description, parameters}], fetchedAt, source: 'live'|'cached' } }`
- **采集通道**：
  1. 增量快照（主）：`tools/change` 后，对 enabled server 用 `tools.schemas(scopeOf(agent.ctx))` 分组快照（preset 层共享，任一 agent 的 scope 即可）
  2. 惰性采集兜底：`mcp_search` 命中 catalog 缺失的 server → 临时 enable → 等注册 → 快照 → 若原 disabled 则立即 disable
- **持久化**：`~/.dsh/dsh-mcp-skill-panel/catalog.json`（0600），启动加载 + 变更写回（复用状态文件模式）
- **检索**：关键词分词 + 打分（name 权重最高 > description > 参数名），顺序扫描（工具数 ≤1000 时毫秒级；超过再考虑索引）→ top-K（默认 5，上限 10）
- **面板联动**：state 端点 mcp 行的 `tools/tokens` 优先显示 catalog 值（停用态也能看到「目录中有 173 个工具」）

### C. mcp_search 工具

- 参数：`{ query: string, server?: string, limit?: number }`
- 行为：
  - 带 `server`：列出该 server 的全部工具（精简名 + 一句话描述）
  - 带 `query`：全文检索 top-K，返回**完整 schema**（name/description/parameters）
  - 无 query 无 server：返回能力摘要表（见 E）
- 输出：JSON 文本（render 为 text）

### D. mcp_call 工具（控制层）

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
- 用途：mcp_search 空查询时返回；辅助模型「知道有哪些 MCP」

## 5. 配置项（Config 扩展）

```ts
{
  autoManage: boolean          // false（默认）：现状，纯面板；true：形态 2 激活
  keepAliveMs: number          // 默认 30_000，空闲回收窗口
  searchLimitDefault: 5        // mcp_search top-K 默认
  searchLimitMax: 10
  serverSummary?: Record<string, string>  // 能力摘要表
}
```

autoManage=false 时：不注册 mcp_search/mcp_call、不过滤装配、回收器不启动——**零行为变化**（向后兼容）。

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
| `system-prompt/assemble` 改写传导未实测 | P0 验证项；若不可行则退化为「瞬态模式」（每次调用启用-执行-关闭，接受 spawn 延迟） |
| 保活期间其他会话模型回合恰好装配（过滤前） | 过滤是全局装配点，启用与装配无关——无此风险（过滤机制成立时） |
| 工具重名/多 server 同名工具 | 完整 id `mcp__<server>__<tool>` 唯一；server 名冲突时 loader 行反查报错 |
| mcp_call 参数透传失败（实测案例 B 第 6 次失败） | 返回 server 原始错误文本，模型自行重试（与直接调用体验一致） |
| catalog 采集的 scope 依赖 | 任一会话存在即可采集；无会话时惰性采集通道（临时启用）兜底 |
| 回收误关用户手动启用的 | owner 标记：仅回收 AI 启用的 |

## 8. 实施计划

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | 验证 `system-prompt/assemble` 过滤传导（动态探针：装配过滤 + 确认模型请求工具列表无 mcp__） | 通过则形态 2 成立；失败则评估瞬态方案 |
| P1 | catalog：采集/检索/持久化/惰性采集 + 单测 | 停用态面板显示目录工具数；检索命中 |
| P2 | mcp_call + 保活回收 + mcp_search + 能力表 + autoManage 接线 | 复测两个案例（bilibili+识图 / calcmcp 数学题）全链路 |
| P3 | owner 标记、并发计数、面板联动、README | 回归：手动启停不受影响；重启保持 |
| P4 | 发布（版本 bump + 产物 + 文档） | dump-config + 安装验证 |

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
