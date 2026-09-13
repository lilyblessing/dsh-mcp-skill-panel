# ROLLBACK.md — 回滚手册（dsh-mcp-skill-panel 本地装机形态）

> 适用场景：升级后插件不挂载 / 面板空白 / 会话起不来 / 需要退回某个 commit。
> **三条铁律**（前两条来自 2026-09-13 junction 事故，永久约束）：
> 1. **用移动替代删除** —— 要删文件/目录时移到备份目录；要递归删除时**移动整个目录树**，绝不 `Remove-Item -Recurse`。
> 2. **`Remove-Item -Recurse` 会跟随 junction 并删除其目标内容**（不只删链接）。本链路里到处是 junction。
> 3. 工作区外写操作（`~/.dsh/**`）走一次沙箱升级 + 审批。

## 0. 装机拓扑（先看懂再动手）

```
D:\software\HarnessWorkspace\dsh-plugin-develop\dsh-mcp-skill-panel\      ← 仓库（开发/构建源）
        │  scripts/deploy-link.mjs 复制 lib/ + package.json 等
        ▼
D:\software\HarnessWorkspace\dsh-plugin-develop\.deploy\dsh-mcp-skill-panel\   ← 部署目录（在仓库树外！）
        │                                     └─ node_modules\@deepseek-ai → junction
        │                                        → C:\Users\lily\.dsh\profiles\web\node_modules\@deepseek-ai
        │                                          （241 项、真实目录、与宿主同源 0.1.5-rc.2）
        │  profile 的 node_modules 里一条 junction
        ▼
C:\Users\lily\.dsh\profiles\web\node_modules\dsh-mcp-skill-panel  → junction 指向 .deploy 目录
        ▲
        │  profiles/web/package.json: "dsh-mcp-skill-panel": "link:…/.deploy/dsh-mcp-skill-panel"
        └─ 且在 dsh.profile.bundles 列表中（host plane 根组合挂载）
```

- **为什么部署目录必须在仓库树外**：插件目录祖先里只要有开发 `node_modules`，`@deepseek-ai/*` 就会被那份旧副本抢先解析 → 第二份 `dsh-agent-presets` 实例 → 它内部记录 standing 挂载的**模块私有 WeakMap** 看不到宿主挂载 → preset 行句柄静默失联。
- **为什么 `.deploy` 的 scope 不能指 pnpm 扁平层**（`profiles/node_modules/@deepseek-ai`）：那一层在一次 junction 事故后仍有 170/240 项断链（含 `dsh-agent-presets`/`dsh-tools`/`dsh-scope`）→ **冷启动全部 MODULE_NOT_FOUND**（运行中的进程因模块已在内存而不暴露）。0.7.1 已把脚本默认基准改为 `profiles/web/node_modules/@deepseek-ai`。

## 1. 三处回滚点

### ① 代码（仓库）
```powershell
cd D:\software\HarnessWorkspace\dsh-plugin-develop\dsh-mcp-skill-panel
git log --oneline -10            # 找目标 commit
git revert <bad-commit>          # 或 git checkout <good-commit> -- src lib
npm run typecheck; npm run build; npm run verify
node scripts/deploy-link.mjs     # 重新部署（会自动重建 .deploy 目录）
```
已知里程碑：`1eca30b`(0.7.1 物化修复) ← `78142f6`(0.7.1 假绿修复) ← `d1c2e87`(0.7.0 更多配置) ← `627e627`(0.5.7 preset 行句柄)。

### ② profile 依赖（`C:\Users\lily\.dsh\profiles\web\package.json`）
- 改前先备份：`Copy-Item package.json .\package.json.bak-<stamp>`（**写入须整份替换**，改完用 `ConvertFrom-Json` 校验语法——曾因正则插错位置把 JSON 写坏）。
- 回滚 = 把 `dependencies["dsh-mcp-skill-panel"]` 的 `link:` 行改回原值（例如 `github:lilyblessing/dsh-mcp-skill-panel#feat/0.5.6-passthrough`），并从 `dsh.profile.bundles` 里删除/恢复该条。
- 依赖与 patch 的关系（**踩过的坑**）：插件若既在 `bundles`（=依赖物化加载）又靠 `cordis.patch.yml` 的 `- insert:` 段加载，会报 `duplicate loader entry id: dsh-mcp-skill-panel` 让**整个 profile 起不来**。二选一。

### ③ 部署目录与 junction
```powershell
# 回滚部署目录（移动语义，不删除）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Move-Item 'D:\software\HarnessWorkspace\dsh-plugin-develop\.deploy\dsh-mcp-skill-panel' `
          "D:\software\HarnessWorkspace\.backup-deleted\deploy-dsh-mcp-skill-panel-$stamp"
# 恢复：从备份 Move-Item 回来，或 git checkout 旧 commit 后重跑 deploy-link.mjs

# 重建 profile junction（若它掉了）
$dep = 'D:\software\HarnessWorkspace\dsh-plugin-develop\.deploy\dsh-mcp-skill-panel'
$pj  = 'C:\Users\lily\.dsh\profiles\web\node_modules\dsh-mcp-skill-panel'
cmd /c rmdir "$pj"                                  # 只删链接本体，不跟随目标
New-Item -ItemType Junction -Path $pj -Target $dep
```

## 2. 恢复资料位置

| 内容 | 路径 |
| --- | --- |
| 部署目录历史快照 | `D:\software\HarnessWorkspace\.backup-deleted\deploy-dsh-mcp-skill-panel-*` |
| junction 台账（事故前基线，577 项/410 junction） | `D:\software\HarnessWorkspace\.backup-deleted\node_modules-junctions-before-20260913-211742.json` |
| 用户级回收站（`.dsh` 侧） | `C:\Users\lily\.dsh\.backup-deleted\`（含 5 份 profile 清单备份 + README） |
| 面板状态文件 | `C:\Users\lily\.dsh\dsh-mcp-skill-panel\state.json`（纯 JSON，可整份备份/还原） |
| 预设组合文件 | `C:\Users\lily\.dsh\.agent-presets\standard-mcp\agent.cordis.yml`（改前必须整份备份） |
| 部署自证 | `.deploy\dsh-mcp-skill-panel\DEPLOY.json`（版本 / 源目录 / hostScope / 时间） |

## 3. 验收闸门（每次改动后按序跑）

```powershell
cd D:\software\HarnessWorkspace\dsh-plugin-develop\dsh-mcp-skill-panel
npm run typecheck        # 零错
npm run build            # tsdown → tsc dts（顺序不可换）
npm run verify           # 产物闸门（含 row-display 零 import 检查）
npm run selftest:rowconfig
$env:PLUGIN_BASIS='C:\Users\lily\.dsh\profiles\web\node_modules\dsh-mcp-skill-panel'
$env:DSH_MODULE_BASIS='C:\Users\lily\.dsh\profiles\web\node_modules'
node scripts/check-module-identity.mjs   # 必须 SAME instance（preset 行句柄可达）
node scripts/deploy-link.mjs
# 冷启动模拟（真 ESM import，不重启即可验部署完好）
node D:\software\HarnessWorkspace\.subagent\archive\experiments\.tmp-ab-probe\cold-start-sim.mjs
```

**A/B 无损预启动**（旧实例继续服务，用备用端口试跑整个新 profile）：
```powershell
dsh.CMD --profile web --port 3179 --no-open     # 等 ~16s
# 判据：URL 输出 / 端口 LISTENING / HTTP 401（未带会话）/ 日志 error 计数 0
taskkill /F /T /PID <新实例 pid>                # 需提权，否则 Access denied 留孤儿
```

## 4. 高危操作黑名单（每条都有事故背书）

| 不要做 | 原因 |
| --- | --- |
| `Remove-Item -Recurse` 删含 junction 的目录树 | **跟随 junction 删目标内容**（2026-09-13 事故：169 个包空壳 + 241 项 scope 塌陷） |
| 运行期写 `agent.cordis.yml` | dsh-agent-presets 用 `{mtimeMs,size}` stamp 检测变化 → standing 重挂而旧实例不 dispose → `serverName is already in use`，会话创建失败（0.1.0 实测事故）。插件刻意只在**启动早期无会话时**物化 |
| 用 `Test-Path` / `createRequire` 判断 junction 是否损坏 | 它们会跟随 junction 给出**假阳性**；必须用真 ESM `await import()` |
| 在仓库里直跑 `check-module-identity.mjs` 下结论 | 那会用开发副本基准（0.1.2-rc.1），与装机无关；必须带 `PLUGIN_BASIS` / `DSH_MODULE_BASIS` |
| 变量命名用 `$home` / `$profile` 等 PowerShell 自动变量 | 只读自动变量会让路径静默变成别处（事故直接成因） |
