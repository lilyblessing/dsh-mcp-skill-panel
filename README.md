<p align="center">
  <strong>dsh-runtime-inventory</strong><br>
  MCP 服务器与 Skill 的「运行时清单」：随时启停，释放上下文占用。
</p>

DSH Web 设置页新增「运行时清单」入口，展示当前 agent 可见的 **MCP 服务器** 与 **Skill 目录**，每个条目一个启停开关：

- **停用 MCP 服务器** → loader entry 卸载（断开连接 + 注销该服务器全部 `mcp__<server>__*` 工具）→ 工具从模型目录**立即消失**，schema token 占用即时释放（实测 cheatengine 173 工具 ≈ 9.6k token）。
- **启用 MCP 服务器** → 重新连接 + 恢复工具，**无需重启**。
- **停用 Skill** → 往 SKILL.md frontmatter 注入 `disable-model-invocation: true` → 模型 catalog 实时失效（技能从模型可见列表消失，`modelInvocable=false`）。
- **持久化**：MCP 启停状态记入插件状态文件（`~/.dsh/dsh-runtime-inventory/state.json`），下次启动早期物化到 agent preset 组合文件（`~/.dsh/.agent-presets/*/agent.cordis.yml`）；Skill 状态即 frontmatter 本身 —— 重启 dsh 后状态保持。**运行期不写预设组合文件**（原因见「工作原理」）。

## 能力面

| 面 | 提供 | 说明 |
|---|---|---|
| **Skills** | 设置页技能目录 + 启停 | frontmatter 切换，watcher 实时失效 |
| **MCP** | 设置页服务器清单 + 启停 | loader entry 动态装卸，文件持久化 |
| **Tools** | 无模型工具注册 | 插件自身零上下文占用（不注入任何工具） |

## 安装

```sh
dsh plugin --profile web add "github:lilyblessing/dsh-runtime-inventory#main"
```

产物已入库（`lib/`），git 源一行安装，无需构建授权。安装后重启生效；设置页出现「运行时清单」入口（MCP 服务器 / 技能 两个标签页，zh/en 双语，跟随界面语言）。

## 插件管理

- **启停 MCP**：设置页 → 运行时清单 → MCP 服务器 → 卡片右上开关。停用释放工具 schema token；启用即时恢复。
- **启停 Skill**：设置页 → 运行时清单 → 技能 → 卡片右上开关。停用后技能从模型目录消失（用户仍可手动引用）。
- **手动管理**：也可直接编辑预设组合文件（`disabled: true` 行）或 SKILL.md frontmatter（`disable-model-invocation: true`），下次重启/变更即生效。

## 工作原理（Phase A 实测结论）

- MCP 行是 agent preset 组合（`agent.cordis.yml`）中的 loader entry（`@deepseek-ai/dsh-mcp-client`），完整 id 形如 `include:agent-presets:mcp-cheatengine`。
- `loader.resolve(id).update({ disabled })` 实时 dispose/restart 该 entry，工具立即从模型目录消失/恢复。
- **MCP 持久化为何分两步**：预设树（`PresetTree`）的 `write()` 是 no-op（预设是输入不是持久化目标），且 `dsh-agent-presets` 用 `{mtimeMs, size}` stamp 检测预设文件变化 —— 运行期写文件会触发 standing 重挂，而旧实例不 dispose → 所有 `serverName` 冲突 → 会话创建/resume 失败。因此 toggle 只写插件状态文件，插件 `apply`（启动早期、standing 未挂载）时再把意图物化到预设文件，此时写文件安全。
- 工具清单来自 `tools.schemas(scopeOf(agent.ctx))`（agent 对象/standingKey 会落回全局视图，必须用 scope key），按 `mcp__<server>__` 前缀聚合工具数与 token 估算。
- Skill 清单来自 `skills.snapshot({ scope, cwd })`；文件路径经 `skills.get(name).path` 定位。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/runtime-inventory/state?session=<id>` | 清单快照（MCP + Skill），session 省略时取首个根 agent |
| POST | `/api/runtime-inventory/mcp/toggle` | `{ entryId, disabled }` |
| POST | `/api/runtime-inventory/skill/toggle` | `{ name, disabled }` |

## 已知限制

- 启停作用于 preset 层：一个服务器/技能的开关影响该 preset 下所有会话。
- 无 frontmatter 的 SKILL.md 无法切换（provider 本身会忽略此类文件）。
- MCP 服务器状态「无工具」= 进程在跑但工具列表为空（server 启动失败/空实现）。
- 工具数/token 为估算值（`JSON.stringify(parameters).length / 4`），与模型注入面真实值近似。
- 停用后工具立即消失，但**当前回合的请求缓存**（如有）可能仍引用旧 schema；下一请求自然刷新。
- **MCP 持久化时滞**：停用/启用实时生效；跨重启的保持依赖下次启动的物化 —— 若插件在「已有会话运行」期间被热更新，本次进程内不物化，下一次重启生效。
- **手动编辑预设组合文件的 mcp 行**（如手动移除 `disabled: true`）会令该行退出插件的持久化管理（下次启动尊重你的改动，不再覆盖）。
- 运行期写 SKILL.md 安全（skill-filesystem 的 watcher 本就预期文件被改）；运行期写预设组合文件会触发 dsh-agent-presets 的 stamp 重挂事故，插件刻意不做。

## 开发

```sh
npm run setup      # junction DSH 闭包类型到 node_modules/@deepseek-ai
npm run typecheck  # tsc 类型检查（闭包类型）
npm run build      # tsc dts + tsdown（node external 全部 @deepseek-ai/*）
npm run verify     # 产物验证（无 TOOL_RUNTIME_SCHEDULER 内联等）
```

node 半区 tsdown 必须 `external: [/^@deepseek-ai\//]`：内联 dsh-tools 会产生第二个 `TOOL_RUNTIME_SCHEDULER` Symbol，导致工具调度崩溃（dsh-context-doctor 同款教训）。

## 许可

MIT
