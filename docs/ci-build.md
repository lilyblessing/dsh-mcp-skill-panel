# GitHub Actions 构建方案（v0.4.8）

> 目的：把「本机构建（npm env 坑 / 沙箱 spawn 限制 / 需本地 DSH 闭包）」替换为 CI 自动构建 +
> 产物自动回写。本文件记录方案、关键参数、证明过程与注意事项。

## 一、为什么可行（探针实测结论）

在**纯 registry 环境**（无本机 `~/.dsh/profiles/node_modules/@deepseek-ai` 闭包）下，
用 14 个 `@deepseek-ai/*` devDeps + `npm install --legacy-peer-deps --ignore-scripts`，
跑通：npm install → typecheck → build(tsdown→tsc dts) → verify(10/10) → selftest(11/11)。

关键机制：
- `@deepseek-ai/cordis` 本身的 `Context` 类型只有基础骨架；`tools/skills/agents/loader/
  agentPresets/webServer/sessions/timeout/interval` 等服务由**各 `dsh-*` 包**以
  `declare module '@deepseek-ai/cordis' { interface Context {…} }` **增补**（src/globals.d.ts
  里的 `import type {}` 即用于触发这些增补）。
- 因此 CI 构建必须把全部增补来源包作为 devDependencies 显式列出，缺一个就 typecheck 挂
  （`Property 'skills' does not exist on type 'Context'` 之类）。
- 产物 `lib/*.js` 对 `@deepseek-ai/*` 仍是 external（tsdown external 铁律不变），CI 里装的
  只是**构建期类型/自测运行时**副本，不进运行时闭包。

## 二、devDependencies 清单（pin 到本机 DSH 同系版本）

| 包 | 版本 | 作用 |
| --- | --- | --- |
| @deepseek-ai/cordis | 4.0.1 | Context/Events 基类 |
| @deepseek-ai/schemastery | 3.18.1 | Config schema |
| @deepseek-ai/cordis-plugin-loader | 1.0.2 | Entry 类型 |
| @deepseek-ai/cordis-plugin-timer | 1.1.3 | timeout/interval 增补 |
| @deepseek-ai/dsh-scope | 0.1.0-rc.6 | scopeOf |
| @deepseek-ai/dsh-tools | 0.1.0-rc.6 | defineTool + tools 增补（自测运行时主链）|
| @deepseek-ai/dsh-skill | 0.1.0-rc.6 | skills 增补 + skills/change 事件键 |
| @deepseek-ai/dsh-agent | 0.1.0-rc.6 | agents 增补 |
| @deepseek-ai/dsh-llm | 0.1.0-rc.6 | CallId 类型（自测运行时链）|
| @deepseek-ai/dsh-system-prompt | 0.1.0-rc.6 | PromptAssembly 类型 |
| @deepseek-ai/dsh-agent-presets | 0.1.0-rc.6 | agentPresets 增补 |
| @deepseek-ai/dsh-host-webserver | 0.1.0-rc.6 | webServer 增补 |
| @deepseek-ai/dsh-session | 0.1.0-rc.6 | sessions 增补（自测运行时链）|
| @deepseek-ai/dsh-timeout | 0.1.0-rc.6 | dsh-llm 运行时依赖（自测链）|

> 自测（selftest）会真实加载 `lib/index.js` → 运行时链：
> `dsh-tools → cordis/schemastery/dsh-scope/dsh-llm/dsh-session`、`dsh-llm → dsh-timeout`。
> 这些必须显式列进 devDeps（--legacy-peer-deps 不会自动装 peer）。

## 三、GitHub Actions 流水线（.github/workflows/build.yml）

- 触发：main push（限定 src/scripts/package*/tsconfig*/tsdown/cordis.patch 路径）+ PR + 手动。
- 步骤：checkout → setup-node 22（cache npm）→ `npm ci --legacy-peer-deps --ignore-scripts
  --no-audit --no-fund` → `npm run typecheck` → `npm run build` → `npm run verify` →
  `node scripts/selftest-mcp.mjs` → 上传 lib 产物 artifact → **main push 时若 lib/ 有变更，
  自动 `git commit -m "chore: rebuild lib artifacts via CI [skip ci]"` 并 push 回写**。
- 不会死循环的两道保险：push 触发 paths **不含 lib/**；提交信息带 `[skip ci]`。

## 四、注意事项 / 边界

1. **回写后本地要 pull**：CI 提交的产物在你本地不可见，下一次 push 前先 `git pull`，避免非快进。
2. **版本对齐**：devDeps pin 的是与你本机 DSH 同系（rc.6）的 registry 版本；未来升级本机 DSH
   主版本时，记得同步 bump 这些 pin（含 globals.d.ts 触发增补的那批包）。
3. **registry rc.6/rc.7 互咬**：直接 `npm install`（不带 legacy）会 ERESOLVE；必须 `--legacy-peer-deps`。
   原因：`dsh-tools@rc.6` 声明 peer `dsh-user-approval@^rc.6`，npm 解析到 rc.7 后其 peer 又要
   `dsh-agent@^rc.7`，与我们的 rc.6 pin 冲突。
4. **`dsh-user-approval` 不必入 devDeps**：它只是 peer 声明，运行时 import 链里没有它（已用
   import 扫描确认），省一个包。
5. 本机旧流程（`npm run setup` junction 闭包）仍可用，但已非必需；新增 devDeps 后本机
   `npm install` 会把对应包替换为真实副本、其余 junction 会被 pruned，随后 `npm run setup`
   会再补 junction——不想折腾就直接用 registry devDeps（与 CI 完全一致）。
