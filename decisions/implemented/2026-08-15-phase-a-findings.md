# 决策记录

## implemented/2026-08-15-mcp-toggle-persistence.md

**Problem**：MCP 启停如何做到「实时生效 + 重启保持」。Phase A 实测（动态探针）发现预设组合树（`PresetTree`，dsh-agent-presets 内部类）的 `write()` 是显式 no-op —— "a preset is an input, never a persistence target"，因此 `loader.resolve(entryId).update({disabled})` 只改内存态，不写回 `agent.cordis.yml`。计划中的备选「写 profile cordis.patch.yml disabled 覆盖行」也不成立：patch 作用于根树，预设行在嵌套子树，目标行不存在时 patch 仅告警跳过。

**Decision**：实时态走 `entry.update({disabled})`（Phase A 验证：dispose/restart 即时生效，模型目录工具 13→0→13）；持久化由插件直写 `entry.parent.tree.filename`（预设组合文件）的 `- id: <row>` 行标记 `  disabled: true` / 移除。重启后 loader 重新读取文件，disabled 生效。

**Alternatives**：
- profile patch 覆盖行 —— 根树补丁打不到预设子树（已否决）
- 直接调 tree.write() —— PresetTree 覆写为 no-op（不可行）
- 仅文件编辑不 update —— 无 watcher，重启才生效（不满足「实时」）

**Consequences**：插件需自行做最小文本编辑（保留注释与 `!!js` 表达式，不能用 yaml.dump 整树序列化——会丢注释）；预设文件是用户资产，编辑前应保证行匹配失败时明确报错。

## implemented/2026-08-15-scope-key-for-tools-schemas.md

**Problem**：`tools.schemas(agent)` 直接传 agent 对象只返回全局视图（8 个工具，MCP 为 0）。Phase A 溯源：`ScopedLayers.chainLayers(scope)` 用 `scopeChainOf(scope)` 按对象身份查层，agent 对象不是 scope key 也不是 `scopeTarget` carrier，查不到 preset 层。context-doctor 工具路径有效是因为 `exec.agent` 是 carrier。

**Decision**：宿主侧一律 `tools.schemas(scopeOf(agent.ctx))`（`@deepseek-ai/dsh-scope` external 导入，与宿主同模块实例）。Skill 目录则 `skills.snapshot({ scope: agent, cwd })`（该 API 接受 agent 对象，实测有效）。

**Consequences**：无 agent 时退化为 `schemas()` 全局视图并如实展示；HTTP 路由带 `?session=`，缺省取首个根 agent。

## implemented/2026-08-15-client-bundle-format-cjs.md

**Problem**：client 半区 tsdown 用 esm 输出时保留 `import ... from "react"` 顶层语句，而 `__ModuleLoader__.load({factory})` 的 factory 是函数体 —— 函数内 `import` 是语法错误，bundle 无法加载。

**Decision**：client 半区 `format: ['cjs']`（factory 提供 `require`），banner 包 `__ModuleLoader__.load`，footer 收 `return module.exports`。rolldown cjs 自带的 `exports.apply/inject` 与 footer 重复赋值，幂等无害。

**Consequences**：构建产物验证脚本增加「无 stray import」「require 形式」「__ModuleLoader__ 包装」检查项。

## implemented/2026-08-15-tsdown-output-name-collision.md

**Problem**：tsdown 默认 `entryFileNames: '[name].js'`，两个入口 `src/index.ts` 与 `src/client/index.ts` 的 basename 都是 index，两个 config 并发写同一个 `lib/index.js`（最终只留一个 bundle）。

**Decision**：每个 config 的 `outputOptions.entryFileNames` 显式命名：`index.js` / `client.js`。

**Consequences**：验证脚本同时检查两个产物存在。
