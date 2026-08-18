# 安全与健壮性加固（v0.4.7）

## 背景

对外公开代码审读（2026-08-18）发现 7 个问题：

1. `POST /api/mcp-skill-panel/mcp/toggle` 接受任意 `entryId`，`ctx.loader.resolve(entryId).update({disabled})` 前无 MCP 行校验 —— 能触达该端口的调用方（本地恶意进程 / DNS-rebinding / 监听 0.0.0.0 时的局域网）可停用**任意 loader 行**（含核心/其他插件行）。
2. 全部控制端点无鉴权；宿主 `dsh-host-webserver` 的 `register()` 是裸 node:http handler，无 token/Origin/Host 校验。
3. `readBody` 无体积上限（本地 DoS 向量）。
4. `waitRegistered` 不监听 ctx 销毁 / AbortSignal：插件卸载瞬间 Promise 永不 settle，挂起 mcp_call。
5. `mcp_search` 能力摘要混入硬编码 `DEFAULT_SUMMARY`（作者机器 4 个 server），未安装这些 server 的用户看到误导性条目。
6. 构建产物 `lib/types` 始终缺失：build.mjs 先 tsc 后 tsdown，tsdown 的 `clean` 把生成的 d.ts 一并删除 → package.json `types`/`exports["./types"]` 悬空。
7. 提交的 `package-lock.json` 为 0 字节空文件。

## 决策

- `toggleMcp` 前置 `isMcpEntry(entry)` 校验，非 MCP 行抛错（400）。
- 进程级随机令牌 `PANEL_TOKEN = randomBytes(32).toString('hex')`；全部 POST 端点（mcp/skill toggle、config、debug/collect）要求 `x-panel-token` 头（`handle`/`handleAny` 加 guarded 标志），GET 只读端点（state/config/debug/token）保持开放；新增 `GET /api/mcp-skill-panel/token` 供面板获取。
- `readBody` 限长 64KB，超限 destroy + 400。
- `waitRegistered` 增加 `ctx.effect` dispose 监听 + `AbortSignal`（exec.signal）终局，任何一条路径都能正常 settle。
- 删除 `DEFAULT_SUMMARY`：能力摘要只由 `serverSummary` 配置 + catalog 快照构成（与 README 长期记录的限制一致）。
- client 统一请求 `/api/mcp-skill-panel/*`（消除残留的 `/api/runtime-inventory/*` 调用），POST 前 `ensureToken()` 取一次 token 并缓存。
- `build.mjs` 顺序调整为「tsdown → tsc dts」；`verify.mjs` 增加 `lib/types/*.d.ts` 存在性断言防回归；`lib/types` 随产物入库。
- `package-lock.json` 以干净 devDeps 锁替换 0 字节空文件。

## Alternatives

- Host 白名单校验：会破坏 `0.0.0.0` / 局域网访问场景，弃用。
- 独立登录/会话鉴权：面板是设置页内嵌组件、无独立会话体系；进程级 token 已足够阻断跨源盲写（SOP 阻止跨源页面读取 `/token` 响应）。
- 直接移除 package.json `types` 字段：属妥协方案；修复构建顺序让 d.ts 入库更完整。

## Consequences

- 写端点无 token 时返回 401；面板自动携带 token，对用户行为无感。
- 跨源页面无法读取 `/token`（SOP），也无法盲写本地控制端点。
- build 后 `lib/types` 随产物入库，TS 消费者类型解析恢复正常。
- git 源安装契约不变（`lib/` 仍入库，一行安装无需构建）。
