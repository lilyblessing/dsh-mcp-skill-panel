# MCP 持久化改为「状态文件 + 启动早期物化」（v0.1.1）

## 事故

首次实机验证（0.1.0）停用 anki/cheatengine 后：
- 新会话按钮无反应
- 其他会话 resume 报错：
  `preset "standard-mcp" failed to mount ... serverName "calcmcp" is already in use by another mcp-client instance`（8 个未停用行全部冲突，tool-cordis 亦冲突）
- 第二次重启后恢复正常（文件里的 disabled 行生效，进程重启清空 standing）

## 根因

1. 0.1.0 的 toggle 在运行期直写 `agent.cordis.yml`（插入 `disabled: true`）。
2. `dsh-agent-presets.ensureStanding` 用 `{mtimeMs, size}` stamp 检测预设文件变化（`sameStamp` 两者都要相等），用于「用户重启期间手动编辑文件」场景：stamp 变化 → `standing.delete(id)` + 重新 `mountPreset`。
3. 重挂路径**不 dispose 旧 standing 的 scope/fiber**：旧 mcp-client 实例仍活着，`activeServerNames`（keyed by ctx.root 的 WeakMap）中的 `serverName` 占用未释放 → 新挂载 8 个 mcp-client 行全部 `already in use` → 会话创建/resume 全部失败。
4. 设计假设：「preset 是输入，运行期不变」。运行期写预设文件是越界用法，触发未处理路径。

## 决策

- toggle 只做两件事：`loader.resolve(entryId).update({disabled})`（实时生效）+ 更新插件状态文件 `~/.dsh/dsh-runtime-inventory/state.json`（`{ [文件路径]: { [rowId]: { desired, lastApplied } } }`）。**运行期零写预设文件**。
- 插件 `apply` 时（启动早期、standing 未挂载、`agents.list()` 为空）执行 `syncPresetFiles()`：按状态文件把意图物化到预设文件（`disabled: true` 插入/移除）。此时写文件安全 —— 没有 mounted 记录，`ensureStanding` 首次创建不检查 stamp。
- `lastApplied` 防覆盖：物化前比较「行当前状态」与「上次物化状态」，不一致说明用户手动改过文件 → 放弃该行管理（尊重用户）。
- 有会话在跑时跳过物化（插件热更新场景），下次重启生效。

## Alternatives

- 写文件后恢复 mtime —— `sameStamp` 同时比较 size，插入行必然改变 size，不可行。
- 写 profile cordis.patch.yml 覆盖行 —— patch 只作用于根树，打不到预设子树。
- 运行时照写 + 提示用户重启 —— 违背「启用/停用无需重启」核心需求。
- 全量同步（无 lastApplied）—— 会覆盖用户手动编辑。

## Consequences

- 持久化从「即时写文件」变为「下次启动物化」：进程内状态始终一致（内存态即真相）；跨重启保持依赖启动早期物化（正常启动路径均满足）。
- 手动编辑预设文件会干净地退出插件管理（不覆盖、不残留）。
- Skill 持久化不受影响（frontmatter 本身就是持久层，watcher 预期文件变更）。
