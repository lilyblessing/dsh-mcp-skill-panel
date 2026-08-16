<p align="center">
  <strong>🧩 MCP 与技能管理面板</strong><br>
  DeepSeek Harness（DSH）Web 插件 · MCP 服务器与 Skill 目录的实时启停，释放上下文占用
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
</p>

---

## ✨ 是什么

DSH Web 设置页新增「MCP 与技能管理面板」入口，把当前 agent 可见的 **MCP 服务器** 与 **Skill 目录** 变成一张可操作的清单：每个条目一个启停开关，**停用即释放上下文占用，启用无需重启**。

```
┌─ MCP 与技能管理面板 ───────────────────────────────────┐
│  MCP 服务器 │ 技能                              [刷新] │
│  ┌──────────────────────────────────────────────┐     │
│  │ cheatengine          [运行中]       [ 停用 ]  │     │
│  │ 173 个工具 · 约 9.6k token · stdio           │     │
│  └──────────────────────────────────────────────┘     │
│  ┌──────────────────────────────────────────────┐     │
│  │ calcmcp             [运行中]       [ 停用 ]   │     │
│  │ 3 个工具 · 约 0.6k token · stdio             │     │
│  └──────────────────────────────────────────────┘     │
│  ┌──────────────────────────────────────────────┐     │
│  │ officecli  [模型可见]       [ 停用 ]           │     │
│  │ source: user-dsh · Office 文档处理技能         │     │
│  └──────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

## 🎯 特性

| 特性 | 说明 |
| --- | --- |
| 🟢 **MCP 实时启停** | 停用 → loader entry 卸载（断开连接 + 注销该服务器全部 `mcp__<server>__*` 工具），工具从模型目录**立即消失**，schema token 即时释放；启用 → 重新连接 + 恢复工具，**无需重启** |
| 🧠 **Skill 启停** | 往 SKILL.md frontmatter 注入/移除 `disable-model-invocation: true`，模型 catalog 实时失效（实测停用 cheatengine 173 工具 ≈ 9.6k token 一次释放） |
| 💾 **重启保持** | MCP 状态经插件状态文件物化进预设组合文件；Skill 状态即 frontmatter 本身 —— 重启后状态不变 |
| ⚡ **响应快** | skill 开关点击即翻转（乐观更新 + 服务端确认），分域缓存 + 事件驱动失效（`tools/change` / `skills/change`），MCP 页不触发 skill 目录扫描 |
| 🤖 **AI 中间层（可选）** | `autoManage: true` 后**停用的 MCP 对模型隐藏**，需要时经 `mcp_search` / `mcp_call` 按需调用（目录检索 top-K 精确 schema、保活启用 + 空闲回收）；**用户手动打开的 MCP 保持模型可见**（memory 高灵敏召回、filesystem 直接读写）；AI 临时启用的 server 不污染上下文 |
| 🌐 **双语界面** | 设置页入口与全部文案 zh/en 双语，跟随 DSH 界面语言；明暗主题适配 |
| 🪶 **零上下文占用** | 插件自身不注册任何模型工具，不消耗模型注入面 |

## 📦 安装

```sh
dsh plugin --profile web add "github:lilyblessing/dsh-mcp-skill-panel#main"
```

产物已入库（`lib/`），git 源一行安装，无需构建授权。安装后**重启 `dsh web`**（bundle 层在启动时合成，热更新无效），设置页即出现「MCP 与技能管理面板」入口。

## 🚀 使用

1. 设置页 → **MCP 与技能管理面板**
2. **MCP 服务器** 标签页：每张卡片显示服务器名、状态徽标（运行中 / 已停用 / 无工具 / 异常）、工具数与 token 占用估算；点右上角开关启停
3. **技能** 标签页：每张卡片显示技能名、来源、描述、模型可见徽标；点右上角开关启停
4. **手动管理**（可选）：直接编辑预设组合文件（`disabled: true` 行）或 SKILL.md frontmatter（`disable-model-invocation: true`），下次重启/变更即生效

> 状态徽标含义：🟢 运行中（有工具）/ ⚪ 已停用 / 🟡 无工具（进程在跑但工具列表为空，多为 server 启动失败或空实现）/ 🔴 异常（未在运行也未停用）。

## 🖥️ 工作原理

```
┌─ Host（Node，cordis 插件）─────────────┐      ┌─ 浏览器（client bundle）───┐
│  lib/index.js                          │      │  lib/client.js             │
│                                       │      │                           │
│  webServer.register(/api/mcp-skill-    │──fetch──▶ settings.section 面板    │
│    panel/*)                            │      │  MCP/技能 双标签 + 启停开关  │
│    ├ state  清单快照（分域缓存）         │      │  按 tab 懒加载 part=mcp/skills│
│    ├ mcp/toggle  loader entry 启停     │      └───────────────────────────┘
│    └ skill/toggle  frontmatter 切换    │
└────────────────────────────────────────┘
```

- **MCP 启停**：MCP 行是 agent preset 组合（`agent.cordis.yml`）中的 loader entry（`@deepseek-ai/dsh-mcp-client`，完整 id 形如 `include:agent-presets:mcp-cheatengine`）。`loader.resolve(id).update({ disabled })` 实时 dispose/restart 该 entry。
- **MCP 持久化为何分两步**：预设树（`PresetTree`）的 `write()` 是显式 no-op，且 `dsh-agent-presets` 用 `{mtimeMs, size}` stamp 检测预设文件变化 —— **运行期写该文件会触发 standing 重挂而旧实例不清理**（serverName 全冲突、会话创建失败，0.1.0 实测事故）。因此 toggle 只写插件状态文件（`~/.dsh/dsh-mcp-skill-panel/state.json`），插件 `apply`（启动早期、standing 未挂载）时再把意图物化到预设文件 —— 此时写文件安全。
- **工具清单**：`tools.schemas(scopeOf(agent.ctx))`（agent 对象/standingKey 会落回全局视图，必须用 scope key），按 `mcp__<server>__` 前缀聚合工具数与 token 估算；聚合结果版本化复用，`tools/change` 间隙零深克隆。
- **Skill 清单**：`skills.snapshot({ scope, cwd })`；文件路径经 `skills.get(name).path` 定位。

## 🔌 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/mcp-skill-panel/state?session=<id>&part=<mcp\|skills\|all>` | 清单快照；`part` 分域拉取（前端按 tab 懒加载），缺省 all；session 省略时取首个根 agent |
| POST | `/api/mcp-skill-panel/mcp/toggle` | `{ entryId, disabled }` |
| POST | `/api/mcp-skill-panel/skill/toggle` | `{ name, disabled }` |
| GET | `/api/mcp-skill-panel/debug` | catalog 采集诊断（事件计数/快照现场/内存目录摘要），运维排障用 |
| POST | `/api/mcp-skill-panel/debug/collect` | 手动触发一次 catalog 采集 |

> 旧前缀 `/api/runtime-inventory/*`（≤0.3.1）仍兼容注册。分域缓存（60s TTL 兜底）由事件驱动精确失效：`tools/change` / `loader/partial-dispose` → MCP 域；`skills/change` → Skill 域。

## ✅ 验证清单

| 检查项 | 操作 | 预期 |
| --- | --- | --- |
| 面板入口 | 重启后打开设置页 | 出现「MCP 与技能管理面板」，MCP/技能双标签，zh/en 跟随界面语言 |
| MCP 停用 | 关掉一个服务器开关 | 卡片变「已停用」，新会话工具列表不再含 `mcp__<server>__*` |
| MCP 启用 | 再打开开关 | 工具恢复，**无需重启** |
| 持久化 | 停用后重启 dsh | 该服务器仍处于停用状态 |
| Skill 启停 | 点技能开关 | 卡片立即翻转且不回跳；模型目录同步移除/恢复 |
| 外部变化 | 会话 A 停用某 MCP，会话 B 打开面板 | 无需点刷新即为最新状态 |

## ⚠️ 已知限制

- 启停作用于 preset 层：一个服务器/技能的开关影响该 preset 下所有会话。
- 无 frontmatter 的 SKILL.md 无法切换（provider 本身会忽略此类文件）。
- 工具数/token 为估算值（`JSON.stringify(parameters).length / 4`），与模型注入面真实值近似。
- 停用后工具立即消失，但**当前回合的请求缓存**（如有）可能仍引用旧 schema；下一请求自然刷新。
- **持久化时滞**：启停实时生效；跨重启保持依赖下次启动的物化 —— 插件在「已有会话运行」期间被热更新时，本次进程不物化，下一次重启生效。
- **手动编辑预设组合文件的 mcp 行**（如手动移除 `disabled: true`）会令该行退出插件的持久化管理（下次启动尊重你的改动，不再覆盖）。
- 运行期写 SKILL.md 安全（skill-filesystem 的 watcher 本就预期文件被改）；运行期写预设组合文件会触发 dsh-agent-presets 的 stamp 重挂事故，插件刻意不做。

## 🛠️ 开发

```sh
npm run setup      # junction DSH 闭包类型到 node_modules/@deepseek-ai
npm run typecheck  # tsc 类型检查（闭包类型）
npm run build      # tsc dts + tsdown（node external 全部 @deepseek-ai/*）
npm run verify     # 产物验证（无 TOOL_RUNTIME_SCHEDULER 内联、client 包装完整）
```

node 半区 tsdown 必须 `external: [/^@deepseek-ai\//]`：内联 dsh-tools 会产生第二个 `TOOL_RUNTIME_SCHEDULER` Symbol，导致工具调度崩溃（dsh-context-doctor 同款教训）。

## 📋 变更日志

| 版本 | 内容 |
| --- | --- |
| 0.4.2 | 装配过滤按 server 状态：用户打开的 MCP 工具进模型上下文（memory 高灵敏召回），停用的对模型隐藏、经 mcp_search/mcp_call 按需调用；AI 临时启用不污染上下文；用户手动打开清除 AI 标记（防回收器误关）；面板新增 autoManage 开关 + 模型可见徽标 |
| 0.4.1 | 修复 catalog 采集链路：apply ctx 下 `agents` 为空导致自动采集恒空（fallback `standingKeyFor` 解析 scope）、last-good 守卫失效、启动早期空快照写盘、写盘竞态；新增 debug 诊断端点；案例复测通过（chrome→mimo 跨 server、calcmcp 连击零重复 spawn + 30s 回收） |
| 0.4.0 | AI 中间层（`autoManage`）：`mcp_search`/`mcp_call` 按需使用 MCP（保活启用 + 空闲回收 + 装配过滤，模型永不见 `mcp__*` schema）；私有 catalog 持久化 + 面板停用态回填目录工具数 |
| 0.3.2 | API 前缀对齐包名（旧前缀兼容）；本地目录改名 |
| 0.3.1 | MCP 聚合版本化复用；前端 fetch 乱序防护 |
| 0.3.0 | 分域端点 + 分域缓存 + 事件驱动失效（tab 懒加载） |
| 0.2.1 | skill 启停 UI 30s 滞后根因修复（已确认值覆盖陈旧 catalog） |
| 0.2.0 | 改名「MCP 与技能管理面板」+ GitHub 库 `dsh-mcp-skill-panel` |
| 0.1.1 | MCP 持久化重构（状态文件 + 启动早期物化），修复运行期写预设文件导致的会话创建失败 |
| 0.1.0 | 初版：MCP/Skill 清单 + 启停 |

## 📄 License

[MIT](./LICENSE) © lilyblessing
