<p align="center">
  <strong style="font-size: 2.2em">🧩 MCP 与技能管理面板</strong><br>
  <span style="font-size: 1.1em">DeepSeek Harness（DSH）Web 插件 · MCP 服务器与 Skill 目录的实时启停 · 可选中间层（让AI按需调用）</span>
</p>

<p align="center">
  <a href="./README.en.md">🌐 English</a> · <strong>中文</strong>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Version" src="https://img.shields.io/badge/version-0.7.0-green.svg">
</p>

---

## ✨ 是什么

一个把 **MCP 服务器** 与 **Skill 目录** 变成可操作清单的设置页面板：每个条目一个启停开关，**停用即释放上下文占用，启用无需重启**。

还内置可选的 **AI 中间层**（`autoManage`）：隐藏范围内 MCP 的工具对模型隐藏，模型需要时经 `dsh_mcp_search` / `dsh_mcp_call` 按需临时拉起、空闲 30s 自动回收；用户手动打开的 MCP 可保持对模型可见 —— 上下文占用完全由你的开关决定。

```sh
# 快速安装（在 DSH profile 目录，如 ~/.dsh/profiles/web；git 源始终是最新版）
dsh plugin --profile web add "github:lilyblessing/dsh-mcp-skill-panel#main"
```

![MCP 管理面板](docs/images/mcp-panel.jpg)

## 🎯 核心特性

- 🟢 **MCP 实时启停**：停用 → 卸载连接并注销全部 `mcp__<server>__*` 工具，schema token 即时释放；启用 → 重连恢复，**无需重启 DSH**。
- 🧠 **Skill 启停**：向 SKILL.md frontmatter 注入/移除 `disable-model-invocation: true`，模型目录实时生效。
- 🤖 **AI 中间层（可选）**：停用项对模型隐藏；模型经 `dsh_mcp_search` / `dsh_mcp_call` 按需临时唤醒工具，空闲 30s 自动回收，用户手动启停永不被模型干预。
- ⏱️ **Prompt Cache 友好**：手动开关可选「立即生效」或「下次会话生效」，后者零缓存失效、零额外费用；中间层按需调用天然不触发缓存 miss。
- 📁 **项目级 MCP 与工具级禁用**：读取工作区专属 `.dsh/mcps`（仅该项目会话可见）；server 内部可按工具逐个禁用，检索过滤 + 调用拒绝。
- ➕ **快速迁移与技能创建**：粘贴 Claude Code / Codex 的 `mcpServers` JSON 一键转换导入；面板直接新建技能。

## 📦 安装与升级

> 🎯 **环境要求**：适配 DSH `0.2.1-rc.2`（或更高版本）。
> ⚠️ **重要提示**：插件安装或升级后**必须重启 `dsh web`**（bundle 注入层仅在宿主启动时合成）。

### 1. Git 源安装（推荐 / 尝鲜最新）

在 DSH profile 目录（例如 `~/.dsh/profiles/web`）执行：

```sh
dsh plugin --profile web add "github:lilyblessing/dsh-mcp-skill-panel#main"
```

产物已入库（`lib/`），无需本地构建。**升级**：在 profile 目录执行 `pnpm update dsh-mcp-skill-panel` 拉取最新构建产物。

> ⚠️ `pnpm add` 对相同 spec **不会重解析 git 分支** —— 升级 git 源安装必须用 `pnpm update`，重复 `pnpm add` 不会拉到新代码。

### 2. npm 发布包

```sh
pnpm add dsh-mcp-skill-panel@latest
```

> ⚠️ npm 线上 `latest` 是 **0.6.0**，落后于本分支的 **0.7.0**（PTC 适配等新特性不在其中）—— 需要 0.7.0 请用上面的 git 源安装。

### 3. 本地开发 Link 安装

```sh
npm run build && node scripts/deploy-link.mjs    # 或合并为：node scripts/deploy-link.mjs --build
```

脚本把构建产物部署到 `.deploy/`（部署目录在仓库树外，避免开发 node_modules 抢先解析 `@deepseek-ai/*`），并在 profile 下建立 Junction 软链接，按脚本提示操作即可。

## 🚀 快速上手

1. **进入面板**：重启 DSH 后访问 Web 页面，「设置页」左侧即可看到「**MCP 与技能管理面板**」。
2. **管理 MCP**：在「MCP 服务器」标签页查看状态与 token 占用，点开关实时启停；展开行内工具列表可逐个禁用工具。
3. **开启 AI 中间层**：打开「AI 中间层」开关，隐藏范围内的 MCP 对模型隐藏，模型自主按需搜索并临时调用。
4. **导入外部配置**：「添加 MCP」粘贴 `mcpServers` JSON，自动识别环境变量与传输类型，一键导入为全局或项目级。

## 🏗️ 运行形态与 AI 中间层

| 形态 | 开关配置 | 模型调用特征 | 适用场景 |
| --- | --- | --- | --- |
| **形态 1：原生直用** | `autoManage: false` | 直接注入所有已启用 MCP 的原生工具（`mcp__*`） | 常用工具固定、对调用延时敏感 |
| **形态 2：AI 中间层** | `autoManage: true` | 隐藏范围内 MCP 工具对模型不可见，仅暴露 `dsh_mcp_search` / `dsh_mcp_call` | 挂载大量 MCP、需严控上下文预算 |

### `middleLayerHides`：中间层隐藏范围（默认 `'all'`）

| 取值 | 面板文案 | 语义 |
| --- | --- | --- |
| `'disabled'` | 仅手动停用的 server | 关闭的 server 工具不暴露；**开启的 server 工具全量直连暴露** |
| `'all'` | 全部 MCP server | **所有 server 的工具都不暴露**，模型统一只经 `dsh_mcp_search` / `dsh_mcp_call` 取用 |

> 该设置只改「本次装配的可见性」，工具注册表与 `dsh_mcp_call` 执行通道不受影响。装配过滤与调用时序详见 [docs/architecture.md](./docs/architecture.md)。

## 🤖 PTC 模式（`mode: ptc`）下的行为

DSH `0.2.1-rc.2` 起 agent 预设可设 `mode: ptc`：模型只能直调 `run_code`，MCP 工具移入 `tools:sdk` 提示词段（不再经过 `assembly.tools`）。本插件的遮蔽对 `tools:sdk` 段**同样生效** —— 隐藏范围内的 MCP 工具在 PTC 下也不会进入 SDK 工具表；中间层内层派发（`dsh_mcp_call` 执行 MCP 工具）带 `parent` / `rootCallId`，符合 PTC 的 nested 调用约定，模型直调的拦截行为不变。

## ⏱️ 启停生效时机与费用建议

| 模式 | 生效时间点 | Prompt Cache 影响 | 推荐场景 |
| --- | --- | --- | --- |
| **立即生效**（默认） | 下一轮对话即刻生效 | 当前会话前缀缓存必定失效（Miss 费率约为 Hit 的 5~12.5 倍） | 必须立刻释放上下文或使用新工具 |
| **下次会话生效** | 新会话首次请求前 / 重启时 | **零缓存失效、零额外费用** | 日常维护配置，追求极致性价比 |

> 开启 AI 中间层后按需临时调用 server 天然不触发缓存 Miss。原理详见 [docs/prompt-cache.md](./docs/prompt-cache.md)。

## 🔌 HTTP API 概览

插件提供 `/api/mcp-skill-panel` 前缀的控制接口（写操作需 Header 携带 `x-panel-token`）：

| 方法 | 路径 | 功能说明 |
| --- | --- | --- |
| GET | `/state?session=<id>&part=<mcp\|skills\|all>` | 读取 MCP 与技能清单快照（支持按 session 作用域过滤） |
| POST | `/mcp/toggle` | `{ entryId, disabled }` 启停单个 MCP 服务器 |
| POST | `/mcp/toolBulk` | `{ serverName, disabled, toolNames? }` 批量启停指定工具 |
| GET/POST | `/config` | 读取与修改面板配置（`autoManage` / `applyMode` / `middleLayerHides` / `toolBudget`） |
| GET | `/models` | 查询宿主 LLM 的 provider 与模型目录（支持按模型独立分流） |

> 完整端点全表、快速迁移接口与运维排障端点详见 [docs/api.md](./docs/api.md)。

## ⚠️ 使用须知与已知限制

- **全局预设作用域**：启停操作作用于 Preset 组合层，一个服务器的开关会影响属于该预设下的所有会话。
- **未注册 ≠ 未启用**：卡片显示「未注册工具」表示子进程正常运行但一个工具都没注册（常见于缺项目索引、端点不可达），下方工具列表来自目录快照。
- **重启生效边界**：更新插件代码或配置意图物化时，需重启 DSH 方可完成生效。
- **控制工具参数规范**：`dsh_mcp_call` 的 `arguments` 必须是 JSON 对象，字符串形态会被参数校验拒绝。
- **与「自动审批」预设的已知冲突**：开启「自动审批」（`dsh-experimental-auto-review`）预设时，中间层内层派发会触发 AR 的 PTC 约定检查而失败；**本插件不修 AR**，等待上游修复。
- 更多口径边界与限制详情见 [docs/architecture.md](./docs/architecture.md) 的「已知限制（详表）」。

## 🛠️ 本地开发

依赖已完全自包含，无需本地 DSH 闭包：

```sh
npm install --legacy-peer-deps --ignore-scripts   # 安装依赖
npm run typecheck                                 # TypeScript 类型检查
npm run build                                     # tsdown 构建 + tsc 生成声明
npm run verify                                    # 产物完整性与架构守卫校验
npm run selftest:mcp                              # 核心纯逻辑单测
```

> **lib/ 产物由 GitHub Actions 自动重建**（main 分支 push 时回写），详见 [docs/ci-build.md](./docs/ci-build.md)。

## 📋 变更日志

详细的版本演进、破坏性变更与历史修复请参阅 **[CHANGELOG.md](./CHANGELOG.md)**。
当前开发版 **0.7.0（未发布）**：PTC 中间层适配（内层派发带 `parent`/`rootCallId`）、PTC 下 `tools:sdk` 段遮蔽（`middleLayerHides`）、适配 `dsh-agent-preset-registry@0.2.1`（移除 `livePresetMounts`）、peer 放宽 `dsh-scope` 至 `^0.2.0-rc.2`、README 重构。

## 📄 开源协议

[MIT](./LICENSE) © lilyblessing
