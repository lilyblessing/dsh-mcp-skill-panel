# HTTP API 全表与配置项

> 本文件内容迁自 README.md「🧾 配置项」与「🔌 HTTP API」章节（2026-10-19 README 重构），原文保留；返回总览请看 [README.md](../README.md)。

## 🧾 配置项

面板可写的配置落在 `~/.dsh/dsh-mcp-skill-panel/state.json`（优先于 cordis `config`），可用 `GET/POST /config` 读写：

| 配置项 | 取值 | 说明 |
| --- | --- | --- |
| `autoManage` | `false`（默认）/ `true` | AI 中间层总开关（形态 1 ↔ 形态 2） |
| `applyMode` | `immediate`（默认）/ `next-session` | 手动开关的生效时机（见 [prompt-cache.md](./prompt-cache.md)） |
| `toolBudget` | 正整数 / 空 | 工具数红线：**全部工具**（含 read/edit/bash/skill 等非 MCP 工具）超过它即告警；空 = 不提示。数值只是可配置默认值，见「已知限制」 |
| `autoManageByRoute` | `{ "<provider>": bool, "<provider>/<model>": bool }` | 中间层**按模型分流**；查表序 `provider/model` → `provider` → `autoManage` 总开关。经 `POST /config` 的 `routeOverride: { key, value }` 单条增删（`value: null` = 删除该键）；任一覆盖项为真即挂载中间层 |
| `middleLayerHides` | `'disabled'` / `'all'`（默认） | 中间层隐藏范围：`'disabled'` 只隐藏停用的 server；`'all'` 所有 server 工具都不暴露，模型统一经中间层取用 |

## 🔌 HTTP API

前缀 `/api/mcp-skill-panel`（旧前缀 `/api/runtime-inventory/*` 仍兼容）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state?session=<id>&part=<mcp\|skills\|all>` | 清单快照；`part` 分域拉取，缺省 all |
| POST | `/mcp/toggle` | `{ entryId, disabled }` 启停单个 MCP |
| POST | `/mcp/toggleBatch` | `[{ entryId, disabled }]` 批量启停（400ms 合并，单次失效） |
| POST | `/mcp/applyPending` | 立即应用待生效队列（next-session 意图强制生效）；**需 body `{ confirm: true }`**，缺了即 400（该操作会让当前会话下一轮 100% miss 前缀缓存，故要求显式确认） |
| GET\|POST | `/mcp/rowConfig` | body `{ server, set?, unset?, apply? }` 读/写某 MCP 行的挂载配置（`command`/`args`/`env`/`cwd`/`url`/`headers`…）；GET **开放但 env/headers 脱敏回显**，POST **需 `x-panel-token`**；写侧占位符即「保留原值」 |
| GET\|POST | `/debug/rowConfig` | GET 只读取某 server 行的全量挂载配置 + 模块身份读数（运维排障用；env/headers 脱敏回显）；POST 为取证用写入（body `{ server, set?, unset?, update? }`，`update:false` 即 dry-run 只回报 `willWrite`，不碰运行时） |
| POST | `/mcp/toolToggle` | `{ serverName, toolName, disabled }` 工具级禁用（全名 `mcp__<server>__<tool>`） |
| POST | `/mcp/toolBulk` | `{ serverName, disabled, toolNames?, session? }` 工具级**批量**启停。`toolNames` **三态**：省略/缺字段 = 该 server 当前目录里的全部工具；数组 = 精确集合（`[]` 为合法空操作，200 + `changed:0`）；**非数组**、或非空却**一条都不匹配** → 400（不静默降级为「全部」）。目录不可得（从未启动且无快照）同样 400。响应 `{ serverName, disabled, disabledTools, disabledCount, changed, ignoredToolNames }`：`ignoredToolNames` = 点名了但不在当前目录视图里的项（60s 缓存可能已过期，据此察觉「以为动了 N 条、实际只动交集」） |
| POST | `/mcp/preview` | `{ json }` 快速迁移预览：粘贴 mcpServers JSON → 解析 + YAML patch 转换（返回 warnings） |
| POST | `/mcp/add` | `{ json, target: global\|project, workspace? }` 添加 MCP（全局写入 profile patch / 项目写入 `.dsh/mcps/mcp.json`） |
| POST | `/skill/toggle` | `{ name, disabled }` |
| POST | `/skill/add` | `{ name, description, body, target: global\|project, workspace? }` 创建技能 |
| GET | `/config` | 读取中间层与面板配置：`autoManage` / `applyMode` / `autoManageByRoute`（按模型覆盖表）/ `autoManageMounted`（中间层当前是否挂载）/ `middleLayerHides` / `toolBudget` |
| GET | `/models` | provider/模型目录（数据源 = 宿主 llm 服务）+ `active` 路由投影：`providers`（`{ provider, name, models[] }`，按 provider 字典序）/ `autoManage` / `autoManageByRoute` / `autoManageMounted` / `active`（`on` + `source` 四取值 `'model'`\|`'provider'`\|`'master'`\|`'no-route'` + `provider`/`model`）/ `session` / `cached`（本次直接取自 TTL 缓存）/ `fetchedAt`。`listModels` 会逐个 provider 打到 adapter（可能触达网络），故 **60s TTL + 单飞**（`MODELS_TTL_MS = 60_000`；并发请求共享同一在飞抓取）把这条**无鉴权读端点**的扇出上界锁死为 60s 一次；三条降级路径都不抛（`llm` 缺失 / `listProviders()` 抛错 → `providers: []`；单个 `listModels()` 抛错 → 只该 provider `models: []`） |
| POST | `/config` | `{ autoManage?, applyMode?, toolBudget?, middleLayerHides?, routeOverride? }` 写配置并持久化到 state.json。`toolBudget`：`null`=清除，只接受 >0 的有限数；`middleLayerHides`：`'disabled'`\|`'all'`；`routeOverride`：`{ key: '<provider>' \| '<provider>/<model>', value: boolean \| null }` 单条增删按模型覆盖（`null`=删除该键）。仅 `autoManage` / `middleLayerHides` / `routeOverride` 触发中间层重挂（`tools/change` → 该轮前缀缓存 miss） |
| GET | `/debug` | catalog 采集诊断 + scope 解析现场（scopeDiag），运维排障用 |
| POST | `/debug/collect` | 手动触发一次 catalog 采集 |
| GET | `/token` | 取本进程随机令牌（面板 POST 前自动获取并携带 `x-panel-token` 头） |

> **写操作鉴权（0.4.7+）**：全部 POST 要求 `x-panel-token` 头与本进程随机令牌一致，否则 401 —— 阻断跨源 / DNS-rebinding 对本地控制端点的盲写；GET 只读端点（state/config/debug/token）保持开放。令牌由客户端在 `/token` 获取并自动携带。
> 分域缓存（60s TTL 兜底）由事件驱动精确失效：`tools/change` / `loader/partial-dispose` → MCP 域；`skills/change` → Skill 域。
