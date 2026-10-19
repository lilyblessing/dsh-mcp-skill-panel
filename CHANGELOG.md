# 📋 变更日志

> 本文件由 README.md「📋 变更日志」章节迁出（2026-10-19 README 重构），历史条目原样保留。

## 0.7.0（未发布）

- 🔗 **PTC 中间层适配**：DSH `0.2.1-rc.2` `mode: ptc` 下，中间层内层派发（`dsh_mcp_call` 执行 MCP 工具）带 `parent` / `rootCallId`，符合 registry 的 nested 调用约定；模型直调的拦截行为不变。
- 🙈 **PTC 下 `tools:sdk` 段遮蔽**：PTC 模式 MCP 工具位于 `tools:sdk` 提示词段（不走 `assembly.tools`），本插件的遮蔽对该段同样生效；`middleLayerHides` 默认值改为 `'all'`。
- 🧩 **适配 `dsh-agent-preset-registry@0.2.1`**：模块级 `livePresetMounts` / `standingMountFor` 已被上游移除，挂载句柄改走实例级 registry generations（旧宿主仍回退模块级通路，三段式降级）。
- 📦 **peer 放宽**：`@deepseek-ai/dsh-scope` 增加 `^0.2.0-rc.2` 分支（`^0.1.2-rc.1 || ^0.2.0-rc.2`）。
- 📝 **README 重构**：精简至 ≤200 行；深度设计迁入 `docs/architecture.md` / `docs/prompt-cache.md` / `docs/api.md`；变更日志迁出至本文件。

## 📋 变更日志（历史，迁自 README）

### v0.6.0（2026-09-16）— 首个公开发布

> 本节条目折叠自发布前的内部开发线（该开发线从未对外发布，发布时统一按 v0.6.0 计），因此条目内保留了当时的迭代顺序与提交号。

#### 安全加固：`/mcp/applyPending` 的显式确认 + AI 临时启用可辨识

- 🔒 **逃生舱加闸门**：`POST /mcp/applyPending`（README §92–96 定义的那个「**用户点击**『立即应用待生效变更』按钮、已知晓费用」的强制生效出口）原先只校验 method + 面板令牌，**「用户已知晓费用」这个前提在服务端并不存在** —— 任何能发 HTTP 的调用方（包括模型自己）一发裸 POST 就能单方面作废 next-session 的「零缓存失效」承诺。实测（2026-09-14）：模型经此端点把 next-session 下的 obsidian 行在当前会话直接打开，README §92 描述的两条生效边界（新会话首次请求前 / DSH 重启）被绕过。
  现在要求请求体显式 `{ "confirm": true }`，缺了即 400 并附费用说明（「该操作会让当前会话下一轮 100% miss 前缀缓存，费率约为 hit 的 5–12.5 倍」）。
- 🔒 **面板按钮加二次确认**：`views.tsx` 的「立即应用待生效变更」原先单击即发 POST（只有事后提示），现改为先弹确认对话框（写明缓存代价），确认后才带 `confirm: true` 发请求。
- ✨ **AI 临时启用可辨识**：`McpRow` 新增 `aiOwned`（= autoManage 且 `controller.isAiEnabled(server)`），卡片在「用户打开」之外显示独立徽标 **「AI 临时启用 / AI (temp)」** + 悬停说明。此前两者外观完全相同（都只是 `modelVisible=true`），模型误用面板 API 打开某行时与用户自己打开的行**分不清**，是上面那次误操作不易被发现的原因。

##### ✅ 验证清单（补充项）

| 检查项 | 操作 | 预期 |
| --- | --- | --- |
| 逃生舱确认 | 裸 `POST /mcp/applyPending`（无 body） | 400，错误文案含「需要显式确认」 |
| 逃生舱确认（正向） | 面板点「立即应用待生效变更」→ 确认对话框 | 弹费用说明；确认后生效并返回 `confirmed: true` |
| AI 临时启用徽标 | 调 `dsh_mcp_call` 唤醒一个已关闭的 server | 该行出现「AI 临时启用」徽标，~15–30s 后随回收消失 |

#### 诚实上报未注册行 + 配置物化误判修复

- 🐛 **假绿缺陷修复**：行「启用 + 在跑 + live 注册工具数 = 0」时，面板此前回落显示目录快照工具数，把故障现场渲染成健康 —— 实测 codegraph 显示 `running=true / tools=4`，而 Host 注册表 `mcp__* = 0`、`mcp_call` 两次 60s 超时（真因：工作区缺 `.codegraph` 索引，子进程空转）。现在 `unregistered=true` + `tools=0` + `status=failed`，卡片徽标显示「未注册工具 / Not registered」并附悬停说明；目录快照只回落到工具列表（工具级禁用 UI 仍可用），**停用行照旧回落快照**（保留「可被 mcp_search 检索」语义）。
- 🐛 **配置意图物化被外部改动误判吞掉**（配置意图的持久化路径此前实际不可用）：`rowDisabledState` 对**没有 `disabled` 键**的行返回 `null`，而状态文件里的 `lastApplied` 记的是 live `entry.disabled = false` → `null !== false` → 启动物化判成「文件被外部改过」→ **整行跳过，配置永不落地且零提示**（实测：preset 文件 mtime 不变即为铁证）。修复：① 外部改动分支不再跳过，改为「对齐 `lastApplied` → 继续走配置物化」（启停与配置正交，该分支不写 `disabled`，用户对启停的改动仍被尊重）；② `writeRowConfigIntent` 的 `lastApplied` 改读盘取文件事实，不再沿用面板快照。
- 🔧 **`row-display` 拆为零宿主依赖模块**：`computeStatus` / `rowDisplay` 原埋在 `collect.ts`，selftest 只能经 `index.js` 触达（连带加载 `@deepseek-ai/*`，repo 侧不完整 → 测不到）。现独立产物 `lib/row-display.js`（零 import），selftest 直接加载；`verify` 增加产物存在性 + 零 import 闸门。
- 🔧 **部署基准修正**：`scripts/deploy-link.mjs` 的 `hostScope` 原为 `profiles/node_modules/@deepseek-ai`（pnpm 扁平层），该层在一次 junction 事故后**170/240 项断链**（含 `dsh-agent-presets`/`dsh-tools`/`dsh-scope`）→ 指向它的部署目录**冷启动全部 MODULE_NOT_FOUND**（运行中的进程因模块已入内存而不暴露）。改为 `profiles/web/node_modules/@deepseek-ai`（同源 0.1.5-rc.2，241 项全通）。另：脚本提示从 `Remove-Item -Recurse` 改为**移动语义**（junction 事故约束）。

#### 「更多配置」：行挂载配置可在面板编辑

- ✨ 每个 MCP 行新增「更多配置…」按钮 → `RowConfigModal`；可编辑字段白名单 9 项：`transport` / `command` / `args` / `env` / `cwd` / `url` / `headers` / `toolCallTimeoutMs` / `failOnStartupError`。典型用途：codegraph 这类**按 cwd 认项目**的 server（缺 cwd → 子进程在会话工作区找不到索引 → 拒绝注册工具）。
- ✨ **三段式生效**：① `entry.update({config})` 热应用（standing 行实测 1.2s 干净生效、不丢行）；② 意图写 `state.json`（运行期唯一安全写面）；③ 启动早期 `syncPresetFiles` 物化进预设行 `config:` 块（`apply:false` 可只记意图、下次重启生效）。
- 🔌 新端点：`GET|POST /api/mcp-skill-panel/mcp/rowConfig`（body `{server, set?, unset?, apply?}`）、只读 `GET /debug/rowConfig`（全量挂载配置 + 模块身份读数）。
- 🔧 `preset-text.ts` 独立产物 + `scripts/selftest-rowconfig.mjs`（15 项；曾当场抓出两个真 bug：`\s{N}` 缩进误匹配导致重复插键、新块插入位置把行间空行顶到 `config:` 上方）。

#### preset 行句柄 + 临时拉起闭环 + 已安装能力表

- ✨ **preset 行句柄通路**（`627e627`）：dsh 0.1.2-rc.1 起 preset 行挂 standing 组合、不在 `ctx.loader.entries()`/`resolve()` 里。经 `livePresetMounts()` / `standingMountFor(agentCtx)` 拿 `PresetTree` 句柄，恢复 rc.8 原设计 —— 全关 + 模型经 `mcp_search`/`mcp_call` 按需临时拉起、用完 30s 回收。实测：`mcp_search` 命中已关的 calcmcp → `mcp_call(symbolic_tool)` 成功 → 面板转 running 但 `modelVisible=false` → 35s 后自动关回。
- ✨ 能力表（catalog）采集改走 `snapshotEnabled` 并覆盖 preset 行（`7672450` / `c0855f9`）；关前补采加等待上限与前置守卫（`1db832f` / `2161bba`）；prune 的 alive 集合纳入 standing 行（0.6.0）—— 关掉的 server 仍可被 `mcp_search` 检索。
- ✨ `mcp_search` 分层检索（`18576e4`，防上下文膨胀 + 给出该调哪个工具的指引）；摘要分支 `count` 改用工具总数（`b8b87f9`）。
- 🔧 `existingRowIds` 覆盖 standing 行，防 `mcp/add` 写重复行；`applyStateResidue` 遍历纳入 standing 行（否则对 preset 行恒 0 应用，`desired` 永远悬着）；新增 `/debug → standingDiag` 自证面。

#### 按模型覆盖：补齐 provider/模型目录数据源

- 🧭 **`GET /models` 目录端点**（读端点，**无鉴权**，与其它读端点一致）：数据源是宿主 llm 服务（`ctx.inject` 捕获的 `routeServices.llm`）的 `listProviders()` / `listModels(provider)`；**60s TTL + 单飞**（`MODELS_TTL_MS = 60_000`）把这条开放端点的扇出上界锁死为 60s 一次（`listModels` 会逐个 provider 打到 adapter，可能触达网络）；结果按 provider 字典序。三条降级路径都**不抛**：`llm` 缺失 / `listProviders()` 抛错 → `providers: []`；单个 `listModels()` 抛错 → 只该 provider `models: []`。
- 🖱️ **覆盖卡改可折叠的 provider/模型目录**：provider 行与模型行都能设置三态覆盖（键 = `provider` / `provider/model`），因此**任意 provider/模型都可预置规则，不必先切到它**；目录拉取失败 → 降级为「只列键」的旧行为；未被目录吃掉的键落在「其它键」区，运行期 ∪ 持久化的覆盖键仍然全部可见、可删。
- 🔗 **`active` 与 `/state` 的 `autoManageActive` 同源**：两处都走 `src/model-route.ts` 的 `activeRouteView`（`{ on, source, provider, model }`，`source` 取值 `'model'` / `'provider'` / `'master'` / `'no-route'`）—— 面板高亮与 gate 生效依据不会再各写一份。
- ⚠️ **诚实边界**：面板是**进程级** settings.section，**可用时**透传当前会话（0.6.0）→ 高亮与读数跟随你正在用的会话；**取不到会话时**回退：`/state` 不带 `session`，host 侧按 `roots[0]` 解析（卡片始终显示解析出的 `sessionId` 供核对）。

#### 会话透传：面板跟随当前会话（可用时）

- 🔗 **带上当前会话**：面板此前所有请求都不带会话，host 只能按 `roots[0]` 解析 —— 多会话并存时卡片显示的是启动期那个会话的数据，而不是你正在用的那个。现在从宿主 `settings.section` 槽位的标准 props（`useSessions`）取「当前会话」，随 `/state`、`/models`（`?session=`）与 `/skill/toggle`、`/mcp/toolBulk`（body 的 `session`）一起发给 host。host 侧**一直支持**这两个参数，本次**没有新增任何端点、没有改动 gate 语义**。
- 🛡️ **取不到就完全回退**：宿主未提供该能力（或当前无会话）时，四个请求与旧版本**逐字节相同**，host 仍按 `roots[0]` 解析 —— 向后兼容、可独立回退。卡片措辞随情形切换（「跟随当前会话」/「面板绑定会话」），两种情形都把解析出的 `sessionId` 显示出来供核对。

### v0.5.5（2026-09-08）— rc.1 空面板修复（standing 组合兜底）

- 🐛 **空面板修复**：rc.1 起 preset 行挂 standing 组合、不再进 `ctx.loader.entries()`（实证 loader 156 行零 MCP），面板 `mcp[]==0` 空列表。`mcp.length===0` 时以当前会话 preset 的 standing 快照行补行（`compositionInventory` + preset 文本解析 `serverName/transport/超时`）。
- 🔧 **开关链路**：预设行开关走 `state.json desired` 意图（恒 pending 徽标），`syncPresetFiles`/`applyStateResidue` 负责物化；运行期不写 preset 文件（事故铁律不变）。
- ⚠️ **范围**：仅面板显示修复；`mcp_call` 预设行直通是后续工作（仍报「不在 loader 中」，`presetTimeoutMs` 仅补超时窄场景 + 60s 缓存）。

### v0.5.4（2026-09-08）— rc.1 兼容（无业务变更）

- 🔧 **rc.1 兼容**：`dsh.client.inject` 去残留 `@deepseek-ai/dsh-client-runtime` 一行；dsh 系 pin `0.1.0-rc.8`→`0.1.2-rc.1`（含 peer `dsh-scope`，新增 `dsh-util-values` 类型依赖）。
- 🐛 **构建修复**（rc.1 类型漂移，纯类型层、零运行时影响）：`JsonValue` 改自 `@deepseek-ai/dsh-util-values` 导入（`tools` 不再转出）；`CallId` 改名 `ToolCallId`（`dsh-llm`）。
- ✅ **确认**：`settings.section`（`runtime-inventory`/order 30）沿用 `slots.inject` 写法，与 rc.1 下正常的 `hud 1.3.0` 同构，有效不动。

### v0.5.3（2026-08-27）— 发布批次：新功能 + 测试期修复 + 工程改进

- ✨ **新功能**（承接 PR #5）：
  - MCP 快速迁移添加（粘贴 `mcpServers` JSON → 转换预览 → 全局/项目）
  - 项目级工作空间 MCP（`.dsh/mcps` 热更新 + 按会话隔离）
  - 工具级禁用（`mcp_search` 过滤 + `mcp_call` 拒绝，按工作区作用域）
  - 创建技能（全局/项目，支持上传 SKILL.md 预填）
- 🐛 **修复**：
  - `setRowFlag` 支持 `disabled` 标记反转 + 外部修改不再删除 state 条目（重启后设置丢失事故）
  - `/config` GET 恢复只读开放（面板生效时机恒显「立即生效」修复）
  - scope key 进程级共享缓存（HTTP 面板路径聚合无工具根治）+ 工具列表 catalog 兜底
  - status 徽标以真实注册工具判定（不掩盖故障现场）
- ⚡ **性能**：装配过滤空表快速通道（约 177x）
- 🔧 **工程**：CI 适配分支保护（App token 回写）；发布前独立审查整改；selftest 增补回归

### v0.5.2（2026-08-24）— 审计修复

- reaper×call 竞态（空闲回收 await 后二次检查引用计数，杜绝在途 mcp_call 被误清归属）
- mcp_call 参数双编码归一化（normalizeArguments）与错误呈现（msgOf JSON 化，杜绝 [object Object]）
- scope 钥匙改用 agent 对象（修复重启后 mcp_call 全量「未在超时内注册」）
- 双缓存统一（getSchemasView 共享 raw schemas）；toggleSkill 确认改指数退避
- applyStateResidue 按文件分组读盘；preset 原子写；serverOfMcp 收敛
- /config 鉴权回归修复（独立审查拦截）

### v0.5.1（2026-08-23）— mcp_call 工具名前缀防御（PR #4）

- `tool` 参数误传注册全名/双重前缀自动归一化（normalizeToolName）；其他 server 注册全名立即快速失败并提示裸名
- selftest 新增 4 条回归断言；宿主端到端验证通过

### v0.5.0（2026-08-21）— Prompt Cache 优化（P0+P1）

- 中途开关必现 miss 警示条（大包红色 severe 变体、12s 自动消失）
- 生效时机选项 immediate / next-session（新会话 `agent/session-start` 或重启统一应用，当前会话零 miss）
- 开关 400ms 合并单次 toggleBatch；applyPendingMcp 增加 state.json 残留兜底；toggleBatch 单项失败不阻断整批

### v0.4.9（2026-08-20）

- 依赖对齐 DSH rc.8 系；新增 Trusted Publishing 自动发布流水线（publish.yml，OIDC 免 token）

### v0.4.8（2026-08-19）

- 构建工程自包含 + CI：14 个 `@deepseek-ai/*` 并入 devDependencies；GitHub Actions 流水线（main push 自动重建回写 lib）

### v0.4.7（2026-08-18）

- 安全与健壮性加固：toggle 校验目标行必须是 MCP 行；全部写端点加进程级 token 鉴权；readBody 限长 64KB；waitRegistered 绑定上下文销毁；build 顺序修复使 lib/types 入库

### v0.4.6 / v0.4.5

- 0.4.6：修复 0.4.5 引入的 catalog 清空事故（prune 空视图保护 + 空采集不写盘）
- 0.4.5：catalog 失效清理（行移除/改名后残留快照自动清除）

### v0.4.4（2026-08-13）

- 可维护性重构：index.ts 拆分（state/preset/collect/routes/util/mcp-entry/shared-types）；MCP entry 判定收敛；端点样板收敛；client 类型声明替换 any

### v0.4.3（2026-08-12）

- 性能优化：修复 restore 竞态；装配过滤回合内可见性 Map 缓存；schemas 500ms 窗口复用；catalog 写盘 300ms 防抖；state.json 内存态 + 写队列合并

### v0.4.2（2026-08-11）

- AI 中间层（autoManage）：mcp_search/mcp_call 按需使用；装配过滤按 server 状态；面板 autoManage 开关 + 模型可见徽标

### v0.4.1（2026-08-10）

- 修复 catalog 采集链路（standKeyFor fallback、last-good 守卫、启动早期空快照写盘、写盘竞态）；新增 debug 诊断端点

### v0.4.0（2026-08-09）

- AI 中间层初版：私有 catalog 持久化 + 面板停用态回填目录工具数

### v0.3.x（2026-08-06 ~ 08-08）

- 0.3.2：API 前缀对齐包名（旧前缀兼容）
- 0.3.1：MCP 聚合版本化复用；前端 fetch 乱序防护
- 0.3.0：分域端点 + 分域缓存 + 事件驱动失效（tab 懒加载）

### v0.2.x / v0.1.x

- 0.2.1：skill 启停 UI 30s 滞后根因修复（已确认值覆盖陈旧 catalog）
- 0.2.0：改名「MCP 与技能管理面板」+ GitHub 库 `dsh-mcp-skill-panel`
- 0.1.1：MCP 持久化重构（状态文件 + 启动早期物化），修复运行期写预设文件导致的会话创建失败
- 0.1.0：初版：MCP/Skill 清单 + 启停
