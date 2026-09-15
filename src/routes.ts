/**
 * HTTP 路由层：控制动作（toggleMcp/toggleSkill）与全部 /api/mcp-skill-panel/* 端点。
 *
 * 从 index.ts 拆出（可维护性批次 P1-1），并收敛端点样板（P2-6）：
 * defineHandler 统一 method 校验 / 异步错误响应 / {ok:true,...} 包装。
 */
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises'
import { basename, dirname, join, parse as parsePath } from 'node:path'
import { homedir } from 'node:os'
import { readState, writeState, stateApplyMode, stateAutoManageByRoute, stateMiddleLayerHides, stateToolBudget, type ApplyMode } from './state'
import { setSkillFlag, rowDisabledState, isValidSkillName, buildSkillMd, EDITABLE_CONFIG_KEYS } from './preset'
import { pendingMcp, applyPendingMcp } from './pending'
import { findPresetRowByEntryId, findPresetRowByServerName } from './preset-mcp'
import { gatewayServerOfEntryId } from './gateway'

/**
 * B4：网关行 serverName → 当前会话 preset 行定位（entryId 映射不到 preset entryId，
 * 按 serverName 精确匹配；presetId 取当前会话 composedPreset，无会话返回 undefined）。
 */
async function findPresetRowByServerNameLike(ctx: Context, serverName: string) {
  try {
    const { resolveAgent } = await import('./collect')
    const agent = resolveAgent(ctx, undefined)
    const presetId = agent ? (ctx.agentPresets.composedPreset(agent.ctx) ?? null) : null
    if (!presetId) return undefined
    const row = await findPresetRowByServerName(ctx, presetId, serverName)
    if (!row) return undefined
    return { presetId, row, presetPath: row.file }
  } catch {
    return undefined
  }
}
import { resolveAgent, resolveCollectScopeKey, scopeKeySource, getSchemasView, mergeSchemas, collectMcp, collectSkills, confirmedSkills, pruneExpired, DOMAIN_TTL_MS, SKILL_TOGGLE_POLL_MS, type DomainCaches, type Deps } from './collect'
import { isMcpEntry, serverNameOf } from './mcp-entry'
import { findStandingEntryById, standingDiag, standingMcpEntries, findStandingEntryByServer } from './standing-rows'
import { parseMcpServersJson, serversToPatchYaml, serversToRows, type McpServers, type McpRowConfig } from './mcp-convert'
import { remountWorkspace, projectServerOwner, getActiveWorkspace } from './project-mcp'
import { disabledToolsOf, setToolDisabled, setToolsDisabledBulk, resolveToolBulkTargets } from './tool-disable'
import type { McpCallController } from './mcpcall'
import type { CatalogRuntime, Config } from './index'
import { messageOf } from './util'

const API_PREFIX = '/api/mcp-skill-panel'
/** 旧前缀（0.3.1 及以前为 /api/runtime-inventory），保留兼容 */
const LEGACY_API_PREFIX = '/api/runtime-inventory'
/** skill toggle 后等待 watcher 失效 catalog 的最长时间 */
const SKILL_TOGGLE_CONFIRM_MS = 5_000
/** 进程级随机令牌：写操作（启停/config）要求客户端在 x-panel-token 头携带；
 * 阻断跨源 / DNS-rebinding 对本地控制端点的盲写。GET 只读保持开放。 */
const PANEL_TOKEN = randomBytes(32).toString('hex')
/** readBody 体积上限：防无界 body 累积（本地 DoS 向量）。 */
const MAX_BODY_BYTES = 64 * 1024

type Req = import('node:http').IncomingMessage
type Res = import('node:http').ServerResponse

export type Route = {
  kind: 'exact'
  path: string
  handler: (req: Req, res: Res) => void
}

function json(res: Res, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function ok(res: Res, data: object): void {
  json(res, 200, { ok: true, ...data })
}

/**
 * 读请求体（上限 MAX_BODY_BYTES 字节）。
 *
 * P1-2 修复（2026-09-15）：
 *  ① 拼串改走 StringDecoder：原先 `body += String(chunk)`，多字节字符正好跨 chunk 边界时
 *     两个半个字符各自被 String(chunk) 解成 U+FFFD（乱码）——任何含中文的 body
 *     （例如中文 cwd / 中文 args / skill 描述）在多包到达下都会损坏。
 *     长度同理改按字节计（Buffer.byteLength），不再按「解码后字符数」估。
 *  ② 超限分支先解绑监听器再 destroy：原先只 destroy，request 上仍挂着 data/end/error
 *     三个闭包（闭包持有已 reject 的 promise 与 body 累积串）→ 每个被拒请求泄漏一份。
 *     正常结束同样显式解绑（同一 cleanup 路径）。
 */
function readBody(req: Req): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let bytes = 0
    let body = ''
    const onData = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_BODY_BYTES) {
        // 先清理再 destroy：只移除本函数挂的监听器（不用 removeAllListeners，
        // 避免误删宿主/其它插件挂在同一请求上的监听器）。
        cleanup()
        req.destroy()
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      body += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    }
    const onEnd = () => {
      // decoder.end() 冲掉解码器里未凑齐的尾字节（截断的多字节序列在此处才成型）
      body += decoder.end()
      cleanup()
      resolve(body)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function queryParam(url: string, key: string): string | undefined {
  const m = new RegExp(`[?&]${key}=([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : undefined
}

/** 写操作 token 校验（x-panel-token === 本进程随机令牌）。 */
function tokenOk(req: Req): boolean {
  return req.headers['x-panel-token'] === PANEL_TOKEN
}

/** 端点样板：method 校验 + 异步执行 + {ok:true} 包装 + 统一错误码（POST 参数错 400 / GET 服务错 500）。
 * guarded=true 时要求 x-panel-token 匹配（写操作鉴权）。 */
function handle(method: 'GET' | 'POST', run: (req: Req) => Promise<object>, guarded = false): (req: Req, res: Res) => void {
  return (req, res) => {
    if (req.method !== method) {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (guarded && !tokenOk(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    Promise.resolve(run(req))
      .then((data) => ok(res, data))
      .catch((error) => json(res, method === 'POST' ? 400 : 500, { ok: false, error: messageOf(error) }))
  }
}

/**
 * 同 path 多 method 路由：webServer 的 exact 路由按 path 唯一（同 path 重复注册
 * 会中断后续注册），因此 GET+POST 共存的端点必须合并为单个 handler 内部分发。
 * guardPosts=true 时仅 POST 需要 x-panel-token（GET 只读端点始终开放，
 * 与 0.4.7+「读端点开放、写操作鉴权」的设计一致；2026-08-27 修复：此前
 * guardPosts 对 GET 也生效，/config 读取被锁 → 面板生效时机恒显示默认值）。
 */
function handleAny(entries: Array<{ method: 'GET' | 'POST'; run: (req: Req) => Promise<object> }>, guardPosts = false): (req: Req, res: Res) => void {
  // 2026-09-15 修复：含 POST 的合并路由漏传 guardPosts=true 会让写端点静默裸奔
  // （/mcp/rowConfig、/debug/rowConfig 即此漏）。这里 fail-fast，新增路由不会再漏。
  if (!guardPosts && entries.some((e) => e.method === 'POST')) {
    throw new Error('handleAny: POST entries require guardPosts=true')
  }
  return (req, res) => {
    const entry = entries.find((e) => e.method === req.method)
    if (!entry) {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    handle(entry.method, entry.run, guardPosts && entry.method === 'POST')(req, res)
  }
}

/* ── 控制动作 ──────────────────────────────────────────────────────────── */

async function toggleMcp(deps: Deps, entryId: string, disabled: boolean, applyMode?: ApplyMode) {
  const { ctx } = deps
  const mode = applyMode ?? stateApplyMode(await readState())
  let entry: Awaited<ReturnType<Context['loader']['resolve']>> | undefined
  try {
    entry = ctx.loader.resolve(entryId)
  } catch {
    entry = undefined
  }
  // 0.5.7：preset 行不在 loader 可达域，但 standing 树里有真句柄 —— 兜底取回后
  // 走下面正常的 live 分支（entry.update / 意图持久化都以 entry.parent.tree.filename
  // 为准），于是面板开关对 preset 行**当场生效**，不再是恒 pending 的空意图。
  if (!entry) entry = findStandingEntryById(entryId)
  // rc.1 standing 组合兜底：preset 行不在 loader.entries/resolve 里（resolve 抛
  // "cannot resolve entry"）。行以 source:'preset' 进面板，开关走 state.json
  // desired 意图（恒 pending），由 syncPresetFiles/applyStateResidue 物化/补齐。
  // P5（B4）：网关 gw- 行虽可 resolve，但 toggle 不走 live entry.update——走 preset
  // 意图分支（意图→下次 ensureOpenMounts 不同步该行即等价关闭；开则意图清除后重挂）。
  // 三键映射（B4）：entryId=gw-mcp-<server> ↔ serverName ↔ preset rowId。
  if (!entry || gatewayServerOfEntryId(entryId) !== null) {
    const gwServer = gatewayServerOfEntryId(entryId)
    const found =
      (gwServer ? await findPresetRowByServerNameLike(ctx, gwServer).catch(() => undefined) : undefined) ??
      (await findPresetRowByEntryId(ctx, entryId).catch(() => undefined))
    if (found) {
      const state = await readState()
      state.mcp ??= {}
      state.mcp[found.presetPath] ??= {}
      // lastApplied 与 live 路径一致取文件实际状态（preset.ts:rowDisabledState），
      // 读不到文件才回落 inventory 值（防 standing/文件漂移误判外部修改）。
      let fileState: boolean | null = found.row.disabled
      try {
        const { rowDisabledState } = await import('./preset')
        fileState = rowDisabledState(await readFile(found.presetPath, 'utf8'), found.row.rowId)
      } catch {
        fileState = found.row.disabled
      }
      state.mcp[found.presetPath][found.row.rowId] = { desired: disabled, lastApplied: fileState }
      await writeState(state)
      // 内存队列同样记录（pending 徽标 + 下次边界 applyPendingMcp 尝试 entry.update，
      // 行仍不可 resolve 时保留队列，见 pending.ts:50-53 行失效语义——此处反向：
      // 找不到才保留意图；若将来行回到 loader，边界可正常应用）。
      pendingMcp.set(entryId, { entryId, file: found.presetPath, rowId: found.row.rowId, disabled })
      if (!disabled && deps.controller) {
        deps.controller.markUserEnabled(found.row.serverName)
      }
      return {
        entryId,
        rowId: found.row.rowId,
        serverName: found.row.serverName,
        disabled,
        desired: disabled,
        running: found.row.running,
        persisted: true,
        file: found.presetPath,
        applied: false,
        pending: true,
        // 网关行面板口径与 collect 一致（NIT-4）：collect 标 'gateway'，此处回 'gateway'。
        source: 'gateway' as const,
      }
    }
  }
  if (!entry) {
    throw new Error(`entry "${entryId}" is not an MCP row`)
  }
  // 只允许启停 MCP 行：防止调用方传入任意 loader 行（含核心/其他插件行）被误停用。
  if (!isMcpEntry(entry)) {
    throw new Error(`entry "${entryId}" is not an MCP row`)
  }
  const rowId = entry.options.id
  const serverName = serverNameOf(entry)
  // 项目级 MCP 行（projmcp-*，来自 .dsh/mcps 扫描）：启停意图持久化到
  // state.json 的 projectMcp 段（重启/热更新由 syncRows 应用），不写 preset 文件
  // （项目行不在任何 preset 组合里，写 preset 无意义且可能误碰 root cordis.yml）。
  const projectWorkspace = projectServerOwner(serverName)
  if (projectWorkspace !== undefined) {
    if (!disabled && deps.controller) {
      deps.controller.markUserEnabled(serverName)
    }
    const state = await readState()
    state.projectMcp ??= {}
    state.projectMcp[projectWorkspace] ??= {}
    state.projectMcp[projectWorkspace][serverName] = disabled
    await writeState(state)
    // 立即生效（项目行无「下次会话」语义：服务始终常驻，开关即实时切线）
    await entry.update({ disabled })
    return {
      entryId,
      rowId,
      serverName,
      disabled,
      running: entry.fiber !== undefined,
      persisted: true,
      workspace: projectWorkspace,
      applied: true,
      pending: false,
    }
  }
  // P1 会话边界生效（v0.5.0）：next-session 模式只记意图（进入待生效队列），
  // 不立即 entry.update —— 运行时 tools 前缀不变 → 当前会话零缓存失效、零费用。
  // 生效时机：新会话 agent/session-start 首次请求前 applyPendingMcp，或重启后
  // syncPresetFiles 物化预设。immediate（默认）保持原行为：下轮即生效（会 miss）。
  const deferred = mode === 'next-session'
  if (deferred) {
    pendingMcp.set(entryId, { entryId, file: (entry.parent?.tree as { filename?: string } | undefined)?.filename ?? null, rowId, disabled })
    // 0.6.0：意图必须**同时落盘**。原实现只进内存队列，于是"记了意图但没开新会话就重启"
    // 的用户设置会静默丢失（applyStateResidue 的 desired 兜底因此也永远无输入）。
    // 与 preset 兜底分支（本文件 :184-185）语义对齐：desired=用户意图，lastApplied=文件现值。
    const presetFile = (entry.parent?.tree as { filename?: string } | undefined)?.filename
    if (typeof presetFile === 'string' && presetFile.length > 0) {
      try {
        const st = await readState()
        st.mcp ??= {}
        st.mcp[presetFile] ??= {}
        let fileState: boolean | null = null
        try {
          fileState = rowDisabledState(await readFile(presetFile, 'utf8'), rowId)
        } catch {
          fileState = null
        }
        st.mcp[presetFile][rowId] = { desired: disabled, lastApplied: fileState }
        await writeState(st)
      } catch (error) {
        ctx.logger.warn?.(`mcp-skill-panel: persist pending intent for "${entryId}" failed: ${messageOf(error)}`)
      }
    }
  } else {
    pendingMcp.delete(entryId)
    // 0.6.0（关前补采能力表）：用户关掉一行后它就不再运行，schema 视图里随即没有它，
    // 快照只能靠"关之前那一次"。这里先采一次写进 catalog.json，保证**关掉的 server
    // 依然能被 mcp_search 检索到**（rc.8 语义：能力表属于"已安装"，不属于"在跑"）。
    // 采集失败不阻断关闭（best-effort；失败时该 server 首调会自动拉起采集一次）。
    //
    // 0.6.7 前置守卫：**已有快照就跳过**。关前补采要临时拉起该行，而"快照保留"已由
    // 0.6.1（prune 的 alive 纳入 standing 行）保证——对一个跑过一次的 server，关掉它
    // 不会丢快照，此时再拉起采集纯属多余动作（实测 chrome：端点已死、白拉一次）。
    // 只在"确实没有快照"时补采，语义等价而副作用更小。
    if (disabled) {
      const presetSnapshot = deps.catalogRuntime.catalog[serverNameOf(entry)]
      const needsSnapshot = !presetSnapshot || presetSnapshot.tools.length === 0
      if (needsSnapshot) {
        try {
          // 等待上限 1500ms：关闭是用户动作，不能因为该实例起不来（端点已死/启动慢）
          // 而把关闭本身拖住 60 秒。采不到也不影响关闭——该 server 首调时会再按需采集。
          await deps.controller?.fetchInventory(serverNameOf(entry), 1500)
        } catch (error) {
          ctx.logger.warn?.(`mcp-skill-panel: pre-close inventory snapshot for "${serverNameOf(entry)}" failed: ${messageOf(error)}`)
        }
      }
    }
    await entry.update({ disabled })
    // 用户手动打开（!disabled）：清除 AI 临时启用标记（aiEnabled/计数/lastUsed +
    // state.json ai owner）—— 转为「用户打开」语义：模型立即可见、回收器不再回收。
    // 用户手动关闭（disabled）：AI 标记保持原样（若原本 AI 启用中，回收器/失败恢复照常管理）。
    if (!disabled && deps.controller) {
      deps.controller.markUserEnabled(serverNameOf(entry))
    }
  }
  // 持久化：v0.1.1 起运行期绝不写预设文件（触发 dsh-agent-presets stamp 重挂事故）。
  // 只把意图写入插件状态文件，由下次启动的 syncPresetFiles() 物化到预设文件。
  const tree = entry.parent?.tree as { filename?: string } | undefined
  const file = tree?.filename
  let fileState: boolean | null = null
  if (typeof file === 'string' && file.length > 0) {
    try {
      fileState = rowDisabledState(await readFile(file, 'utf8'), rowId)
    } catch {
      fileState = null
    }
  }
  let persisted = false
  if (typeof file === 'string' && file.length > 0) {
    const state = await readState()
    state.mcp ??= {}
    state.mcp[file] ??= {}
    state.mcp[file][rowId] = { desired: disabled, lastApplied: fileState }
    await writeState(state)
    persisted = true
  }
  return {
    entryId,
    rowId,
    serverName,
    disabled,
    running: entry.fiber !== undefined,
    persisted,
    file: file ?? null,
    applied: !deferred,
    pending: deferred,
  }
}

async function toggleSkill(deps: Deps, skillName: string, disabled: boolean, sessionId: string | undefined) {
  const { ctx } = deps
  const agent = resolveAgent(ctx, sessionId)
  const cwd = agent?.session?.header?.cwd
  const def = await ctx.skills.get(skillName, { scope: agent, cwd })
  if (!def?.path) {
    throw new Error(`skill "${skillName}" has no file path (${def?.source ?? 'unknown source'})`)
  }
  const text = await readFile(def.path, 'utf8')
  const next = setSkillFlag(text, disabled)
  if (next !== text) await writeFile(def.path, next, 'utf8')
  // 写文件后轮询确认 catalog 已生效（skill-filesystem 的 watcher 异步失效）。
  // 让响应即真相，前端无需等下一轮全量刷新才看到新状态。
  const deadline = Date.now() + SKILL_TOGGLE_CONFIRM_MS
  let confirmed = false
  let wait = SKILL_TOGGLE_POLL_MS
  while (Date.now() < deadline) {
    const after = await ctx.skills.get(skillName, { scope: agent, cwd })
    if (after && after.invocation?.modelInvocable === !disabled) {
      confirmed = true
      break
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await ctx.timeout(Math.min(wait, remaining))
    wait = Math.min(wait * 2, 1000)
  }
  // 记录确认值，供 collectState 覆盖 snapshot 的陈旧 candidate（watcher 未及失效）
  pruneExpired(confirmedSkills, Date.now())
  if (confirmed) confirmedSkills.set(skillName, { modelInvocable: !disabled, at: Date.now() })
  return { name: skillName, disabled, modelInvocable: !disabled, path: def.path, confirmed }
}

/* ── 添加 MCP（快速迁移）：mcpServers JSON → 全局 profile patch / 项目 .dsh/mcps ── */

/**
 * 路由写文件队列：串行化 appendGlobalPatch / writeProjectMcp 的「读-改-写」。
 * 并发 POST（或多会话同时添加）若各自以旧内容为基底写盘，
 * 先写者的内容会被后写者整体覆盖丢失 → 全部走同一 Promise 链。
 */
let fileWriteChain: Promise<unknown> = Promise.resolve()

/** 0.7.0：配置合法性校验（UI 预校验与后端落盘共用同一套规则）。 */
function validateRowConfig(config: Record<string, unknown>): void {
  const transport = config.transport === undefined ? undefined : String(config.transport)
  if (transport !== undefined && transport !== 'stdio' && transport !== 'streamable-http') {
    throw new Error(`transport 只能是 stdio 或 streamable-http（收到 ${transport}）`)
  }
  const hasCommand = typeof config.command === 'string' && config.command.trim().length > 0
  const hasUrl = typeof config.url === 'string' && config.url.trim().length > 0
  if (transport === 'streamable-http') {
    if (!hasUrl) throw new Error('streamable-http 需要 url')
  } else if (transport === 'stdio' || (transport === undefined && hasCommand)) {
    if (!hasCommand) throw new Error('stdio 需要 command')
  } else if (!hasCommand && !hasUrl) {
    throw new Error('需要 command（stdio）或 url（streamable-http）之一')
  }
  if (config.url !== undefined && !/^https?:\/\//i.test(String(config.url))) {
    throw new Error('url 需以 http:// 或 https:// 开头')
  }
  if (config.args !== undefined && !Array.isArray(config.args)) throw new Error('args 必须是数组')
  if (config.cwd !== undefined && (typeof config.cwd !== 'string' || config.cwd.length === 0)) {
    throw new Error('cwd 必须是非空字符串')
  }
  if (config.toolCallTimeoutMs !== undefined) {
    const n = Number(config.toolCallTimeoutMs)
    if (!Number.isFinite(n) || n <= 0) throw new Error('toolCallTimeoutMs 必须是正数')
  }
  for (const mapKey of ['env', 'headers'] as const) {
    const value = config[mapKey]
    if (value === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${mapKey} 必须是键值对象`)
    }
  }
}

/**
 * 0.7.0：把配置意图写进 state.json（运行期唯一安全的写面）。
 * 结构：state.mcp[预设文件][行 id].config —— 启动早期由 syncPresetFiles 物化。
 */
async function writeRowConfigIntent(
  server: string,
  described: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<{ file: string; rowId: string; config: Record<string, unknown> }> {
  const file = typeof described.file === 'string' ? described.file : null
  const rowId = typeof described.rowId === 'string' ? described.rowId : null
  if (!file || !rowId) throw new Error(`无法定位该行的预设文件/行 id（server=${server}）`)
  const state = await readState()
  state.mcp ??= {}
  state.mcp[file] ??= {}
  const prev = state.mcp[file][rowId]
  // lastApplied 必须取**当前文件事实**，不能沿用面板快照（entry.disabled）。
  // 2026-09-14 实测事故：codegraph 行没有 `disabled` 键 ⇒ rowDisabledState 返回 null，
  // 而 entry.disabled 是 false；若把 false 记成 lastApplied，启动物化时 null !== false
  // 被判成「文件被外部改过」→ 配置意图永不物化，且用户零提示。
  let fileState: boolean | null = prev?.lastApplied ?? null
  try {
    fileState = rowDisabledState(await readFile(file, 'utf8'), rowId)
  } catch {
    /* 读盘失败：保留原值，启动物化会自行对齐 */
  }
  state.mcp[file][rowId] = {
    // 启停意图沿用现值；配置意图记录本次完整配置（不含 configAppliedYaml → 触发物化）
    desired: prev?.desired ?? false,
    lastApplied: fileState,
    config,
  }
  await writeState(state)
  return { file, rowId, config }
}

let rowConfigApplyHook: ((server: string, config: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>) | null = null

/** 由 index.ts 在 apply 里注入（热改 live entry 的 config）。 */
export function setRowConfigApplyHook(
  hook: (server: string, config: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>,
): void {
  rowConfigApplyHook = hook
}

async function applyRowConfigToLive(
  server: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  if (!rowConfigApplyHook) return { ok: false, error: '热应用不可用（钩子未注入）' }
  return rowConfigApplyHook(server, config)
}

/** 0.7.0：描述某个 standing 行的**全量挂载配置**与运行态（只读；/debug/rowConfig 与配置编辑共用）。 */
async function describeRow(server: string): Promise<Record<string, unknown>> {
  const entry = findStandingEntryByServer(server)
  const out: Record<string, unknown> = {
    server,
    standing: standingDiag(),
    entryFound: entry !== undefined,
  }
  if (!entry) return out
  const cfg = (entry.options.config ?? {}) as Record<string, unknown>
  const keep = ['serverName', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError']
  const safe: Record<string, unknown> = {}
  for (const k of keep) if (cfg[k] !== undefined) safe[k] = cfg[k]
  out.entryId = String(entry.id)
  out.rowId = entry.options.id ?? null
  out.disabled = entry.disabled === true
  out.running = entry.fiber !== undefined
  out.config = safe
  out.configKeys = Object.keys(cfg)
  // 预设文件里的声明（与 live 对比，判断是否有 drift）
  const tree = entry.parent?.tree as { filename?: string } | undefined
  out.file = tree?.filename ?? null
  if (typeof out.file === 'string' && out.file.length > 0) {
    try {
      const text = await readFile(out.file, 'utf8')
      out.fileHasCwd = /^\s*cwd:\s*/m.test(text) ? 'file-has-cwd-line' : 'no-cwd-in-file'
    } catch (error) {
      out.fileError = messageOf(error)
    }
  }
  return out
}

/**
 * GET 回传脱敏占位（P1-1，2026-09-15）。
 *
 * 问题：/mcp/rowConfig 与 /debug/rowConfig 的 GET 经 describeRow 回传 **求值后** 的
 * env/headers（里面通常就是 token / API key），而这两个 GET 端点按设计**不要求**
 * x-panel-token（「读端点开放、写操作鉴权」）——于是任何本地页面/脚本一发起 GET
 * 就能把 secrets 原样取走，写侧却要令牌，防线是反的。
 *
 * 边界：脱敏**只发生在 GET/POST 响应体的组装处**，describeRow 内部仍返回真值
 * （POST 的「live 现值 → set/unset」合并必须基于真值，否则改 cwd 会把 env 一并
 * 写成占位符）；存储、live 配置、意图落盘一律不动，POST 写侧照收真值。
 */
const MASKED_VALUE = '***MASKED***'
const MASK_KEYS = ['env', 'headers'] as const

/** 浅拷 + 置换敏感段：键名保留（面板要能看出「有哪些 key」），值一律换成固定占位。 */
function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const key of MASK_KEYS) {
    const value = out[key]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const masked: Record<string, string> = {}
    for (const name of Object.keys(value as Record<string, unknown>)) masked[name] = MASKED_VALUE
    out[key] = masked
  }
  return out
}

/**
 * F3b（2026-09-15）哨兵：**占位符即「保留原值」**。
 *
 * 问题：F3 让 GET 回传把 env/headers 的值换成 MASKED_VALUE，而面板 client
 * （views.tsx RowConfigModal）是「读回显 → 进文本框 → 整体 POST 回写」结构：
 * 用户打开弹窗只改 cwd 就点保存，也会把占位符当真值写回 → 真 token 被抹掉。
 *
 * 修法（纯后端，client 不动）：写侧把占位符解释成"这一条保持 live 现值"——
 *   · 占位值 + live 有对应键 → 恢复 live 真值；
 *   · 占位值 + live 无对应键 → **丢弃该条**（绝不把占位符本身存进去）；
 *   · 非占位值 → 照收（真轮换 token 必须生效）；被 unset 删掉的键不会出现在 next 里。
 * next[key] 非对象（字符串/数组/null）原样放过，交给 validateRowConfig 判错。
 */
function unmaskEcho(next: Record<string, unknown>, live: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next }
  for (const key of MASK_KEYS) {
    const incoming = out[key]
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) continue
    const base = live[key]
    const liveMap =
      base !== null && typeof base === 'object' && !Array.isArray(base) ? (base as Record<string, unknown>) : {}
    const merged: Record<string, unknown> = {}
    for (const name of Object.keys(incoming as Record<string, unknown>)) {
      const value = (incoming as Record<string, unknown>)[name]
      if (value !== MASKED_VALUE) {
        merged[name] = value
        continue
      }
      if (Object.prototype.hasOwnProperty.call(liveMap, name)) merged[name] = liveMap[name]
    }
    out[key] = merged
  }
  return out
}

/** describeRow 回传体的脱敏包装（GET 回传与 POST 的 before/after/willWrite 回显共用）。 */
function maskDescribed(described: Record<string, unknown>): Record<string, unknown> {
  const config = described.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return described
  return { ...described, config: maskSecrets(config as Record<string, unknown>) }
}

/**
 * 定位 profile 的用户 patch 层（<profile>/cordis.patch.yml）。
 * 根树 backing 文件是 <profile>/cordis.yml（每次启动重置为 []），
 * patch 与其同目录；从任一 root 树 entry 的 tree.filename 反推。
 */
function profilePatchPath(ctx: Context): string {
  for (const entry of ctx.loader.entries()) {
    const tree = entry.parent?.tree as { filename?: string } | undefined
    const file = tree?.filename
    if (typeof file === 'string' && basename(file) === 'cordis.yml') return join(dirname(file), 'cordis.patch.yml')
  }
  throw new Error('无法定位 profile 补丁文件 cordis.patch.yml（未找到 cordis.yml 根树；请确认 profile 已正常挂载后重试）')
}

/** 已存在检查：loader 存活行、standing 行或 patch 文本里已有同 id。 */
function existingRowIds(ctx: Context, patchText: string): Set<string> {
  const ids = new Set<string>()
  // 0.6.6：必须同时看 standing 行。preset 行不在 loader 里（rc.1 起），只查 loader 会把
  // 已安装的 server 全判成"不存在" → mcp/add 写出重复行 → serverName 同 scope 冲突。
  for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
    if (!isMcpEntry(entry)) continue
    ids.add(String(entry.options.id))
  }
  for (const line of patchText.split(/\r?\n/)) {
    const m = /^\s*-?\s*id:\s*([^\s]+)\s*$/.exec(line)
    if (m) ids.add(m[1])
  }
  return ids
}

/** 追加 `- insert:` patch 块到 profile cordis.patch.yml（串行排队 + 原子写 + 跟随原换行风格）。 */
function appendGlobalPatch(ctx: Context, yamlBlock: string): Promise<{ file: string }> {
  // 读-改-写整体进入全局写队列：并发请求下后到者基于先到者的写盘结果继续。
  const run = fileWriteChain.then(async () => {
    const file = profilePatchPath(ctx)
    const existing = await readFile(file, 'utf8').catch(() => '')
    const sep = existing.includes('\r\n') ? '\r\n' : '\n'
    const text = existing.length > 0 && !existing.endsWith('\n') ? existing + sep : existing
    const next = text + yamlBlock.replace(/\r?\n/g, sep)
    await writeFile(`${file}.tmp`, next, 'utf8')
    await rename(`${file}.tmp`, file)
    return { file }
  })
  // 链尾兜底：单次失败不阻塞后续排队请求
  fileWriteChain = run.catch(() => undefined)
  return run
}

/** 把 servers 合并写入 <workspace>/.dsh/mcps/mcp.json（新建 server 覆盖同名旧值；读-改-写串行化）。 */
function writeProjectMcp(workspace: string, servers: McpServers): Promise<{ file: string }> {
  // 同一工作区并发 add 的场景（多会话）：排队保证 merge 基底是最新内容，不丢更新。
  const run = fileWriteChain.then(async () => {
    const mcpsDir = join(workspace, '.dsh', 'mcps')
    const file = join(mcpsDir, 'mcp.json')
    await mkdir(mcpsDir, { recursive: true })
    let existing: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
    } catch {
      // 文件不存在或损坏：从空对象重建
    }
    let map: Record<string, unknown> = {}
    if (existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)) {
      map = existing.mcpServers as Record<string, unknown>
    }
    for (const [name, server] of Object.entries(servers)) map[name] = server
    const payload = { ...existing, mcpServers: map }
    await writeFile(`${file}.tmp`, JSON.stringify(payload, null, 2), 'utf8')
    await rename(`${file}.tmp`, file)
    return { file }
  })
  fileWriteChain = run.catch(() => undefined)
  return run
}

/** 全局添加：写入 profile patch + 立即挂载到 loader（粘贴即用，重启由 patch 承接）。 */
async function addGlobalMcp(ctx: Context, servers: McpServers): Promise<{ file: string; added: number; skipped: string[] }> {
  const file = profilePatchPath(ctx)
  const patchText = await readFile(file, 'utf8').catch(() => '')
  const existingIds = existingRowIds(ctx, patchText)
  const toAdd = new Map<string, McpRowConfig>()
  const skipped: string[] = []
  for (const row of serversToRows(servers)) {
    if (existingIds.has(row.id)) {
      skipped.push(String(row.config.serverName))
      continue
    }
    toAdd.set(row.id, row)
  }
  const rows = [...toAdd.values()]
  if (rows.length === 0) return { file, added: 0, skipped }
  // 先挂载后落盘：挂载失败（如 serverName 全局唯一冲突）不应污染 patch
  const mounted: Array<McpRowConfig> = []
  for (const row of rows) {
    try {
      await ctx.loader.create(row)
      mounted.push(row)
    } catch (error) {
      skipped.push(String(row.config.serverName))
      ctx.logger.warn?.(`mcp-skill-panel: 全局 MCP "${row.config.serverName}" 挂载失败: ${messageOf(error)}`)
    }
  }
  if (mounted.length === 0) return { file, added: 0, skipped }
  await appendGlobalPatch(ctx, serversToPatchYaml(serversFromRows(mounted)))
  return { file, added: mounted.length, skipped }
}

/** 从已挂载行重建 McpServers（落盘 patch 用；避免把未挂载成功的行写进去）。 */
function serversFromRows(rows: McpRowConfig[]): McpServers {
  const servers: McpServers = {}
  for (const row of rows) {
    const config = row.config as unknown as McpServerConfigLike
    servers[config.serverName] = config as McpServers[string]
  }
  return servers
}

/** mcp-convert 的 McpServerConfig 最小形状（落盘重建用，字段与行 config 一致）。 */
interface McpServerConfigLike {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
}

/* ── 添加 Skill（项目/全局） ───────────────────────────────────────────── */

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 解析 skill 的项目根：与 dsh-skill-filesystem 的 findProjectRoot 一致 ——
 * 从 cwd 向上找最近含 .git 的目录，找不到退化为 cwd 本身。
 * （skill 的项目发现走这个规则，MCP 的工作空间规则是裸 cwd，两者不同。）
 */
async function resolveSkillProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  for (;;) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = parsePath(current).root
    if (current === parent) return cwd
    current = dirname(current)
  }
}

/** 添加 skill：name/description/body → <root>/skills/<name>/SKILL.md（存在即拒绝）。 */
async function addSkill(
  name: string,
  description: string,
  body: string,
  target: 'global' | 'project',
  workspace: string | undefined,
): Promise<{ path: string }> {
  if (!isValidSkillName(name)) {
    throw new Error(`技能名 "${name}" 需为 kebab-case（小写字母/数字/连字符）`)
  }
  if (description.trim().length === 0) throw new Error('描述不能为空')
  if (body.trim().length === 0) throw new Error('指令（正文）不能为空')
  let base: string
  if (target === 'global') {
    base = join(homedir(), '.dsh', 'skills')
  } else {
    if (typeof workspace !== 'string' || workspace.length === 0) throw new Error('project 目标需要 workspace（当前会话工作空间）')
    base = join(await resolveSkillProjectRoot(workspace), '.dsh', 'skills')
  }
  const dir = join(base, name)
  if (await pathExists(dir)) throw new Error(`技能已存在：${dir}`)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  try {
    // 'wx'：目标不存在才创建 → 并发同名创建时后到者抛 EEXIST（不再互相覆盖）。
    // 单文件小内容直接独占写，原子性由 wx 语义保证。
    await writeFile(file, buildSkillMd(name, description, body), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`技能已存在：${dir}`)
    throw error
  }
  return { path: file }
}

/* ── 路由 ──────────────────────────────────────────────────────────────── */

export function makeRoutes(
  ctx: Context,
  caches: DomainCaches,
  catalogRuntime: CatalogRuntime,
  config: Config = {},
  controller: McpCallController | undefined,
  triggerSnapshot: () => Promise<void>,
): Route[] {
  const deps: Deps = { ctx, caches, catalogRuntime, controller }
  const { mcpCache, skillsCache, invalidateMcp, invalidateSkills } = caches

  const cachedMcp = (sessionId: string | undefined) => {
    const key = sessionId ?? '*'
    pruneExpired(mcpCache, Date.now())
    const hit = mcpCache.get(key)
    if (hit && Date.now() - hit.at < DOMAIN_TTL_MS) return hit.promise
    const promise = collectMcp(deps, sessionId).catch((error) => {
      mcpCache.delete(key)
      throw error
    })
    mcpCache.set(key, { at: Date.now(), promise })
    return promise
  }

  const cachedSkills = (sessionId: string | undefined) => {
    const key = sessionId ?? '*'
    pruneExpired(skillsCache, Date.now())
    const hit = skillsCache.get(key)
    if (hit && Date.now() - hit.at < DOMAIN_TTL_MS) return hit.promise
    const promise = collectSkills(deps, sessionId).catch((error) => {
      skillsCache.delete(key)
      throw error
    })
    skillsCache.set(key, { at: Date.now(), promise })
    return promise
  }

  const routes: Route[] = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/state`,
      handler: handle('GET', async (req) => {
        const url = req.url ?? ''
        const sessionId = queryParam(url, 'session')
        const part = queryParam(url, 'part') ?? 'all'
        if (part === 'mcp') return { state: await cachedMcp(sessionId) }
        if (part === 'skills') return { state: await cachedSkills(sessionId) }
        // all（缺省）：完整视图
        const [mcp, skills] = await Promise.all([cachedMcp(sessionId), cachedSkills(sessionId)])
        return { state: { ...mcp, ...skills, errors: [...mcp.errors, ...skills.errors] } }
      }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/mcp/toggle`,
      handler: handle('POST', async (req) => {
        const parsed = JSON.parse((await readBody(req)) || '{}') as { entryId?: string; disabled?: boolean }
        if (!parsed.entryId) throw new Error('entryId is required')
        const applyMode = stateApplyMode(await readState())
        const result = await toggleMcp(deps, parsed.entryId, Boolean(parsed.disabled), applyMode)
        invalidateMcp()
        return result
      }, true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/mcp/toggleBatch`,
      handler: handle('POST', async (req) => {
        // P1 批量合并：一次请求内串行多次 entry.update（immediate 模式），循环外单次
        // invalidateMcp。探索式批量启停的 N 次独立 toggle → N 次 tools/change → N 次
        // 100% 前缀 miss；合并后收敛为单次。next-session 模式则只记意图进待生效队列，
        // 无任何运行时 tools 变化（零 miss）。运行期仍不写预设文件（事故 5.1 铁律）。
        const parsed = JSON.parse((await readBody(req)) || '{}') as {
          toggles?: Array<{ entryId?: string; disabled?: boolean }>
        }
        const toggles = Array.isArray(parsed.toggles) ? parsed.toggles : []
        if (toggles.length === 0) throw new Error('toggles array is required (non-empty)')
        const applyMode = stateApplyMode(await readState())
        const results: Array<
          | Awaited<ReturnType<typeof toggleMcp>>
          | { entryId: string; ok: false; error: string }
        > = []
        let failed = 0
        for (const item of toggles) {
          if (!item?.entryId) throw new Error('entryId is required in every toggle item')
          try {
            results.push(await toggleMcp(deps, item.entryId, Boolean(item.disabled), applyMode))
          } catch (error) {
            // 单项失败（如行已失效）不阻断整批：其余项照常应用，失败信息随结果返回
            failed += 1
            results.push({ entryId: item.entryId, ok: false, error: messageOf(error) })
          }
        }
        invalidateMcp()
        return { results, count: results.length, failed }
      }, true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/mcp/applyPending`,
      handler: handle('POST', async (req) => {
        // P1 会话边界：「立即应用待生效变更」强制生效入口。把 next-session 模式积压的
        // 待办一次性 entry.update（=临时转 immediate），随后的请求会 miss（调用方提示费用）。
        //
        // 0.7.2 加固：本端点是 next-session「零缓存失效」承诺的**唯一逃生舱**，而 README
        // 把它定义为「**用户点击**『立即应用待生效变更』按钮，作为"已知晓费用"的强制生效出口」
        // ——「用户已知晓费用」这个前提原先在服务端**不存在**：端点只校验 method + 面板令牌，
        // 于是模型/脚本一发裸 POST 就能单方面作废该承诺（2026-09-14 实测：模型经此端点把
        // next-session 下的 obsidian 行在当前会话直接打开，README §92 描述的边界被绕过）。
        // 现在要求请求体显式 `{ confirm: true }`（面板按钮的二次确认对话框才会发送），
        // 缺了即 400 —— 把「已知晓费用」变成协议上必需的显式确认。
        const parsed = JSON.parse((await readBody(req)) || '{}') as { confirm?: unknown }
        if (parsed.confirm !== true) {
          throw new Error(
            'applyPending 需要显式确认：请求体须带 { "confirm": true }（该操作会让当前会话下一轮 100% miss 前缀缓存，费率约为 hit 的 5–12.5 倍）。这是「用户已知晓费用」的强制生效出口，不接受静默调用。',
          )
        }
        const applied = await applyPendingMcp(deps)
        invalidateMcp()
        return { applied, confirmed: true }
      }, true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/skill/toggle`,
      handler: handle('POST', async (req) => {
        const parsed = JSON.parse((await readBody(req)) || '{}') as { name?: string; disabled?: boolean; session?: string }
        if (!parsed.name) throw new Error('name is required')
        const result = await toggleSkill(deps, parsed.name, Boolean(parsed.disabled), parsed.session)
        invalidateSkills()
        return result
      }, true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/skill/add`,
      handler: handle('POST', async (req) => {
        // 添加技能：name/description/body → <root>/skills/<name>/SKILL.md，
        // watcher 自动失效目录（无需手动 invalidate），写入即生效。
        const parsed = JSON.parse((await readBody(req)) || '{}') as {
          name?: string
          description?: string
          body?: string
          target?: string
          workspace?: string
        }
        if (typeof parsed.name !== 'string' || parsed.name.trim().length === 0) throw new Error('name is required')
        if (typeof parsed.description !== 'string') throw new Error('description is required')
        if (typeof parsed.body !== 'string') throw new Error('body is required')
        const target = parsed.target === 'project' ? 'project' : 'global'
        let workspace = typeof parsed.workspace === 'string' && parsed.workspace.length > 0 ? parsed.workspace : undefined
        if (!workspace) workspace = resolveAgent(ctx, undefined)?.session?.header?.cwd
        const result = await addSkill(parsed.name, parsed.description, parsed.body, target, workspace)
        // 确认轮询（与 toggleSkill 同思路）：skill-filesystem 的 watcher 异步失效
        // （~200ms 稳定窗口），立即 snapshot 仍是旧目录；轮询到技能可被发现再返回，
        // 保证弹窗关闭后面板第一次刷新就能看到新技能。
        const agent = resolveAgent(ctx, undefined)
        const cwd = agent?.session?.header?.cwd
        const deadline = Date.now() + SKILL_TOGGLE_CONFIRM_MS
        let confirmed = false
        let wait = SKILL_TOGGLE_POLL_MS
        while (Date.now() < deadline) {
          const def = await ctx.skills.get(parsed.name, { scope: agent, cwd }).catch(() => undefined)
          if (def) {
            confirmed = true
            break
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) break
          await ctx.timeout(Math.min(wait, remaining))
          wait = Math.min(wait * 2, 1000)
        }
        // 记录确认值：collectState 用它覆盖 snapshot 的陈旧 candidate（watcher 未及失效）
        pruneExpired(confirmedSkills, Date.now())
        if (confirmed) confirmedSkills.set(parsed.name, { modelInvocable: true, at: Date.now() })
        invalidateSkills()
        return { target, ...result, confirmed }
      }, true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: handleAny([
        {
          method: 'GET',
          run: async () => {
            const state = await readState()
            return {
              autoManage: catalogRuntime.autoManage,
              // P3b：按模型分流的回显。autoManageMounted = 中间层**已实际挂载**
              // （总开关关但覆盖表有 true 项时为 true，与 autoManage 不是一回事）。
              autoManageByRoute: stateAutoManageByRoute(state),
              autoManageMounted: catalogRuntime.autoManageMounted,
              middleLayerHides: stateMiddleLayerHides(state),
              applyMode: stateApplyMode(state),
              configAutoManage: config.autoManage ?? null,
              toolBudget: stateToolBudget(state) ?? null,
            }
          },
        },
        {
          method: 'POST',
          run: async (req) => {
            const parsed = JSON.parse((await readBody(req)) || '{}') as {
              autoManage?: boolean
              /** 单条覆盖项：key 为 provider 或 provider/model；value null=删除该项（继承总开关）。 */
              routeOverride?: { key?: string; value?: boolean | null }
              applyMode?: ApplyMode
              middleLayerHides?: 'disabled' | 'all'
              toolBudget?: number | null
            }
            const state = await readState()
            state.config ??= {}
            if (typeof parsed.autoManage === 'boolean') {
              state.config.autoManage = parsed.autoManage
            }
            if (parsed.routeOverride && typeof parsed.routeOverride.key === 'string' && parsed.routeOverride.key.length > 0) {
              const table = (state.config.autoManageByRoute ??= {})
              const value = parsed.routeOverride.value
              // null / 非布尔 = 「继承总开关」，即从表里删掉这一项（而不是写 false）
              if (typeof value === 'boolean') table[parsed.routeOverride.key] = value
              else delete table[parsed.routeOverride.key]
              // 空表即删：state.json 里不留空对象（空表 == 旧行为，见 state.ts 注释）
              if (Object.keys(table).length === 0) delete state.config.autoManageByRoute
            }
            if (parsed.middleLayerHides === 'disabled' || parsed.middleLayerHides === 'all') {
              state.config.middleLayerHides = parsed.middleLayerHides
            }
            if (parsed.applyMode === 'immediate' || parsed.applyMode === 'next-session') {
              state.config.applyMode = parsed.applyMode
            }
            // 工具预算：null = 清除（不提示）；只接受 >0 的有限数，其余忽略（保持原值）
            if (parsed.toolBudget === null) {
              delete state.config.toolBudget
            } else if (typeof parsed.toolBudget === 'number' && Number.isFinite(parsed.toolBudget) && parsed.toolBudget > 0) {
              state.config.toolBudget = Math.round(parsed.toolBudget)
            }
            await writeState(state)
            // 只有中间层相关字段变化才重挂：applyAutoManage 会 dispose/register 控制工具，
            // 触发 tools/change → 整段前缀缓存失效。改 applyMode / toolBudget 与中间层
            // 无关，不能顺带让用户付一次 miss。
            const middlewareTouched =
              typeof parsed.autoManage === 'boolean' ||
              parsed.routeOverride !== undefined ||
              parsed.middleLayerHides !== undefined
            if (middlewareTouched) {
              // 总开关与覆盖表任一变化都要重算挂载（覆盖表出现 true 项时即便总开关关也要挂）
              const master = typeof state.config.autoManage === 'boolean' ? state.config.autoManage : catalogRuntime.autoManage
              catalogRuntime.applyAutoManage(master, stateAutoManageByRoute(state), stateMiddleLayerHides(state))
            }
            // 面板视图是 60s 缓存：不失效的话用户点了「设置」要等一轮轮询才看到变化
            // （工具预算同理，与中间层无关但同批失效）。
            invalidateMcp()
            return {
              autoManage: catalogRuntime.autoManage,
              autoManageByRoute: stateAutoManageByRoute(state),
              autoManageMounted: catalogRuntime.autoManageMounted,
              middleLayerHides: stateMiddleLayerHides(state),
              applyMode: stateApplyMode(state),
              toolBudget: stateToolBudget(state) ?? null,
            }
          },
        },
      ], true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/token`,
      handler: handle('GET', async () => ({ token: PANEL_TOKEN })),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/debug`,
      handler: handle('GET', async () => {
        const catalog: Record<string, { tools: number; fetchedAt: number; source: string }> = {}
        for (const [server, info] of Object.entries(catalogRuntime.catalog)) {
          catalog[server] = { tools: info.tools.length, fetchedAt: info.fetchedAt, source: info.source }
        }
        // P5（D5）：网关挂载面（无 secrets；lastCheck 仅计数 detail）。
        let gateway: { mounted: string[]; lastCheck: { at: number; ok: boolean; detail: string } | null } | undefined
        // 0.5.8：临时启用控制器的 aiOwned 集合（回收器唯一作用域）+ 回收器每轮判定输入。
        let controller: { aiOwned: Array<{ server: string; refCount: number; lastUsed: number; idleMs: number }> } | undefined
        // 0.6.3：按需能力表采集的阶段痕迹。
        let inventory: unknown
        try {
          const { gatewayStateForDebug, controllerStatusForDebug, inventoryTraceForDebug } = await import('./index')
          gateway = gatewayStateForDebug()
          controller = controllerStatusForDebug()
          // 0.6.3：能力表采集的逐阶段痕迹（采空时唯一的定位手段）
          inventory = inventoryTraceForDebug()
        } catch {
          gateway = undefined
          controller = undefined
        }
        let reaper: unknown
        let counters: unknown
        try {
          const { reaperDiagnostics, controllerCounters } = await import('./mcpcall')
          reaper = reaperDiagnostics()
          counters = controllerCounters()
        } catch {
          reaper = undefined
          counters = undefined
        }
        // HTTP 路径 scope 诊断（2026-08-27 filesystem「无工具」取证）：
        // 复现 collectMcp 的 scope 解析 + schemas 视图，确认 key 是否命中 standing 层链。
        const scopeDiag: Record<string, unknown> = { error: null }
        try {
          const scopeKey = await resolveCollectScopeKey(ctx, undefined)
          const scoped = scopeKey ? getSchemasView(ctx, caches, scopeKey, DOMAIN_TTL_MS) : []
          const globalView = getSchemasView(ctx, caches, undefined, DOMAIN_TTL_MS)
          const merged = scopeKey ? mergeSchemas(scoped, globalView) : scoped
          const mcpNames = merged
            .map((s) => String(s?.name ?? ''))
            .filter((name) => name.startsWith('mcp__'))
          const scopedMcp = scoped.map((s) => String(s?.name ?? '')).filter((name) => name.startsWith('mcp__'))
          const globalMcp = globalView.map((s) => String(s?.name ?? '')).filter((name) => name.startsWith('mcp__'))
          scopeDiag.scopeKeyType = scopeKey ? typeof scopeKey : null
          scopeDiag.scopeKeySource = scopeKeySource()
          scopeDiag.scopedTotal = scoped.length
          scopeDiag.scopedMcpTools = scopedMcp.length
          scopeDiag.globalTotal = globalView.length
          scopeDiag.globalMcpTools = globalMcp.length
          scopeDiag.mergedMcpTools = mcpNames.length
          scopeDiag.scopedMcpSample = scopedMcp.slice(0, 20)
          scopeDiag.globalMcpSample = globalMcp.slice(0, 20)
        } catch (error) {
          scopeDiag.error = messageOf(error)
        }
        return {
          diag: catalogRuntime.diag,
          catalog,
          scopeDiag,
          // 0.5.7：preset 行句柄来源的自证读数。`mountsSeen: 0` + `apiAvailable: true`
          // = 宿主 livePresetMounts() 看不到挂载（模块身份错位或宿主未挂 preset）；
          // `lastRowCount` 应为 preset 里的 MCP 行数（本机 10）。
          standingDiag: standingDiag(),
          ...(controller ? { controllerStatus: controller } : {}),
          ...(inventory !== undefined ? { inventoryTrace: inventory } : {}),
          ...(reaper !== undefined ? { reaper } : {}),
          ...(counters !== undefined ? { counters } : {}),
          ...(gateway ? { gateway } : {}),
        }
      }),
    },
    {
      // 0.7.0「更多配置」：读/写某个 MCP 行的**挂载配置**（cwd/command/args/env/url/headers…）。
      //
      // 动机：面板卡片只显示 serverName/transport/disabled，看不到 cwd 一类字段；而
      // codegraph 这类按 cwd 认项目的 MCP 一旦缺 cwd 就表现为"行在跑却零工具"。
      //
      // 三段式（与 toggle 的架构一致，铁律不破）：
      //   ① 立即生效：热改 live entry 的 config（实测干净：entry.update({config}) 不丢行）；
      //   ② 意图落盘：写 state.json（运行期唯一安全的写面）；
      //   ③ 启动物化：syncPresetFiles 在 apply 早期把意图写进预设行。
      kind: 'exact',
      path: `${API_PREFIX}/mcp/rowConfig`,
      handler: handleAny([
        {
          method: 'GET',
          run: async (req) => {
            const q = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
            const server = (q.get('server') ?? '').trim()
            if (!server) throw new Error('server is required')
            const described = await describeRow(server)
            // P1-1：GET 无令牌即回传 → 回传体脱敏（真值只在写侧与服务端内部流转）
            return { ...maskDescribed(described), editableKeys: EDITABLE_CONFIG_KEYS }
          },
        },
        {
          method: 'POST',
          run: async (req) => {
            const body = JSON.parse((await readBody(req)) || '{}') as {
              server?: string
              set?: Record<string, unknown>
              unset?: string[]
              apply?: boolean
            }
            const server = String(body.server ?? '').trim()
            if (!server) throw new Error('server is required')
            const described = await describeRow(server)
            if (described.entryFound !== true) throw new Error(`standing 行未找到：${server}`)
            const badKeys = [...Object.keys(body.set ?? {}), ...(body.unset ?? [])].filter(
              (k) => !(EDITABLE_CONFIG_KEYS as readonly string[]).includes(k),
            )
            if (badKeys.length > 0) throw new Error(`不允许的配置键：${badKeys.join(', ')}`)

            // 合并成新的完整配置：live 现值 → 应用 set/unset
            // （described 在此必须是**未脱敏的真值**，否则一次只改 cwd 的保存会把
            //   env/headers 整体写成占位符 → 真 secrets 被抹掉）
            const live = (described.config ?? {}) as Record<string, unknown>
            let nextConfig: Record<string, unknown> = { ...live }
            for (const key of body.unset ?? []) delete nextConfig[key]
            for (const [key, value] of Object.entries(body.set ?? {})) nextConfig[key] = value
            // F3b：回显里的占位符 = 「保留原值」（面板整表单回写时不许抹掉真 secrets）
            nextConfig = unmaskEcho(nextConfig, live)
            validateRowConfig(nextConfig)

            // ② 意图落盘（运行期唯一安全的写面）
            await writeRowConfigIntent(server, described, nextConfig)

            // ① 立即生效（apply:false 可跳过，用于"只记意图、下次重启生效"）
            const applied =
              body.apply === false
                ? { ok: false, error: 'skipped (apply:false)' }
                : await applyRowConfigToLive(server, nextConfig)
            invalidateMcp()
            // P1-1：after 回显同样脱敏（能证明「写入生效」而不把 secrets 回吐给调用方）
            return { ok: true, server, applied, after: maskDescribed(await describeRow(server)) }
          },
        },
      ], true),
    },
    {
      // 0.7.0 取证用（只读）：读某 server 行的**全量挂载配置**（含 cwd/command/args/env）。
      //
      // 面板卡片只显示 serverName/transport/disabled，看不到 cwd 一类字段；而
      // codegraph 这类按 cwd 认项目的 MCP，配置错在哪正是靠这个端点定位的
      // （症状：行"在跑"却零工具，因为没有 cwd → 子进程在会话工作区找不到索引）。
      // 同时附带模块身份读数（模块私有 WeakMap 若错位会静默失联）。
      kind: 'exact',
      path: `${API_PREFIX}/debug/rowConfig`,
      handler: handleAny([
        {
          method: 'GET',
          run: async (req) => {
            const q = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
            const server = (q.get('server') ?? '').trim()
            if (!server) throw new Error('server is required')
            return maskDescribed(await describeRow(server))
          },
        },
        {
          // 写入（取证用）：把 config 增删改到 standing 行上，观察是否干净重启。
          // body: { server: string, set?: Record<string,unknown>, unset?: string[], update?: boolean }
          // `update:false` 只回报将要写入的内容（dry-run），不碰运行时。
          method: 'POST',
          run: async (req) => {
            const body = JSON.parse((await readBody(req)) || '{}') as {
              server?: string
              set?: Record<string, unknown>
              unset?: string[]
              update?: boolean
            }
            const server = String(body.server ?? '').trim()
            if (!server) throw new Error('server is required')
            const entry = findStandingEntryByServer(server)
            if (!entry) throw new Error(`standing 行未找到：${server}`)
            const before = await describeRow(server)
            const live = (entry.options.config ?? {}) as Record<string, unknown>
            let next: Record<string, unknown> = { ...live }
            for (const key of body.unset ?? []) delete next[key]
            for (const [key, value] of Object.entries(body.set ?? {})) next[key] = value
            // F3b：同 /mcp/rowConfig —— 基底是 live 真值，占位符即「保留原值」
            // （dry-run 的 willWrite 仍走 maskSecrets，不回吐真值：F3 已定边界不动）
            next = unmaskEcho(next, live)
            const allowed = ['serverName', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError']
            const rejected = Object.keys(next).filter((k) => !allowed.includes(k))
            if (rejected.length > 0) throw new Error(`不允许的配置键：${rejected.join(', ')}`)
            if (body.update === false) return { dryRun: true, before: maskDescribed(before), willWrite: maskSecrets(next) }
            let updateError: string | null = null
            try {
              await entry.update({ config: next })
            } catch (error) {
              updateError = messageOf(error)
            }
            // 等一拍让 fiber 重建，再回报现场（同 entryId 是否还在 standing 树里、
            // 是否仍在运行、配置是否已变）—— 这就是"能否热改配置"的判据。
            await new Promise((resolve) => setTimeout(resolve, 1200))
            return { updateError, before: maskDescribed(before), after: maskDescribed(await describeRow(server)) }
          },
        },
      ], true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/debug/collect`,
      handler: handle('POST', async () => {
        // P5（W3）：先挂载后快照（新工具进 catalog），串行；挂载失败不阻断快照。
        try {
          const { ensureOpenMountsForDebug } = await import('./index')
          await ensureOpenMountsForDebug().catch(() => undefined)
        } catch {
          /* 挂载失败不阻断快照 */
        }
        await triggerSnapshot()
        return { diag: catalogRuntime.diag }
      }, true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/mcp/toolToggle`,
      handler: handle('POST', async (req) => {
        // 工具级禁用：serverName + 工具全名（mcp__<server>__<tool>）
        const parsed = JSON.parse((await readBody(req)) || '{}') as { serverName?: string; toolName?: string; disabled?: boolean }
        if (typeof parsed.serverName !== 'string' || parsed.serverName.length === 0) throw new Error('serverName is required')
        if (typeof parsed.toolName !== 'string' || parsed.toolName.length === 0) throw new Error('toolName is required')
        await setToolDisabled(parsed.serverName, parsed.toolName, Boolean(parsed.disabled))
        invalidateMcp()
        return {
          serverName: parsed.serverName,
          toolName: parsed.toolName,
          disabled: Boolean(parsed.disabled),
          disabledTools: [...disabledToolsOf(parsed.serverName)],
        }
      }, true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/mcp/toolBulk`,
      handler: handleAny([
        {
          method: 'POST',
          run: async (req) => {
            // 工具级批量禁用/启用：面板的「全部禁用 / 全部启用 / 按当前过滤」。
            // toolNames **三态**（判定实现在 resolveToolBulkTargets，纯函数可直测）：
            //   · 省略/缺字段 = 该 server 面板视图里的全部工具（live schemas，缺失时回退
            //     catalog 快照 —— 与逐个开关看到的列表完全同源，不会漏项）；
            //   · 显式数组 = 精确集合（[] 为合法空操作：不写盘、changed=0、仍 200）；
            //   · 非数组，或非空却一条都不匹配 → 400（不静默降级为「全部」也不静默 no-op）。
            // 命中数少于点名数时，未识别的名字由响应 ignoredToolNames 回传（目录漂移可见化）。
            const parsed = JSON.parse((await readBody(req)) || '{}') as {
              serverName?: string
              disabled?: boolean
              toolNames?: unknown
              session?: string
            }
            if (typeof parsed.serverName !== 'string' || parsed.serverName.length === 0) throw new Error('serverName is required')
            if (typeof parsed.disabled !== 'boolean') throw new Error('disabled (boolean) is required')
            const serverName = parsed.serverName
            const view = await cachedMcp(parsed.session)
            const row = view.mcp.find((item) => item.serverName === serverName)
            if (!row) throw new Error(`unknown MCP server: ${serverName}`)
            const known = row.toolList ?? []
            if (known.length === 0) {
              // 目录不可得（server 从未启动且无 catalog 快照）：批量无从下手，明确报错，
              // 而不是静默写 0 条让用户以为已生效。
              throw new Error(`no tool catalog for ${serverName} (enable it once so its tools can be discovered)`)
            }
            const resolved = resolveToolBulkTargets(known.map((tool) => tool.name), parsed.toolNames)
            if ('error' in resolved) throw new Error(resolved.error)
            // E2：内核一次 state.json 读-改-写（绝不 N 次写盘）。
            // 目标为空（显式 `[]`）= 合法空操作：连内核都不进，天然不写盘。
            const changed = resolved.targets.length === 0
              ? 0
              : await setToolsDisabledBulk(serverName, resolved.targets, parsed.disabled)
            invalidateMcp()
            // E1：与 /mcp/toolToggle 同形（disabledTools 为全名数组），另给计数与翻转条数
            const disabledTools = [...disabledToolsOf(serverName)]
            return {
              serverName,
              disabled: parsed.disabled,
              disabledTools,
              disabledCount: disabledTools.length,
              changed,
              // WARN-1：客户端点名了但不在当前 known 里的名字（60s 缓存可能已过期）——
              // 调用方据此察觉「以为动了 N 条，实际只动了交集」的偏差。
              ignoredToolNames: resolved.ignored,
            }
          },
        },
      ], true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/mcp/preview`,
      handler: handle('POST', async (req) => {
        // 快速迁移预览：粘贴的 mcpServers JSON → 解析 + 转 dsh-mcp-client YAML patch
        const parsed = JSON.parse((await readBody(req)) || '{}') as { json?: string }
        if (typeof parsed.json !== 'string' || parsed.json.trim().length === 0) throw new Error('json is required')
        const { servers, errors, warnings } = parseMcpServersJson(parsed.json)
        if (errors.length > 0) throw new Error(errors.join('；'))
        if (Object.keys(servers).length === 0) throw new Error('未解析出任何 MCP server')
        return { names: Object.keys(servers), yaml: serversToPatchYaml(servers), warnings }
      }, true),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/mcp/add`,
      handler: handle('POST', async (req) => {
        // 快速迁移添加：粘贴 JSON → target=global（profile patch）| project（.dsh/mcps/mcp.json）
        const parsed = JSON.parse((await readBody(req)) || '{}') as {
          json?: string
          target?: string
          workspace?: string
        }
        if (typeof parsed.json !== 'string' || parsed.json.trim().length === 0) throw new Error('json is required')
        const target = parsed.target === 'project' ? 'project' : 'global'
        const { servers, errors, warnings } = parseMcpServersJson(parsed.json)
        if (errors.length > 0) throw new Error(`转换失败：${errors.join('；')}`)
        if (Object.keys(servers).length === 0) throw new Error('没有可添加的 MCP server')
        if (target === 'global') {
          const result = await addGlobalMcp(ctx, servers)
          if (result.added === 0) {
            throw new Error(`全部跳过（已存在或挂载失败）：${result.skipped.join('、') || '未知原因'}`)
          }
          invalidateMcp()
          return { target, ...result, warnings }
        }
        // project：写入 <workspace>/.dsh/mcps/mcp.json 并重扫挂载（立即生效）
        // 目标工作区：显式传参 > 最近进入会话的工作区（随切换更新）> resolveAgent 兜底
        let workspace = typeof parsed.workspace === 'string' && parsed.workspace.length > 0 ? parsed.workspace : undefined
        if (!workspace) workspace = getActiveWorkspace() ?? resolveAgent(ctx, undefined)?.session?.header?.cwd
        if (typeof workspace !== 'string' || workspace.length === 0) {
          throw new Error('project 目标需要 workspace（当前会话工作空间）')
        }
        const written = await writeProjectMcp(workspace, servers)
        await remountWorkspace(ctx, workspace)
        invalidateMcp()
        return { target: 'project', ...written, workspace, added: Object.keys(servers).length, warnings }
      }, true),
    },
  ]
  // 旧前缀兼容（0.3.1 及以前）：同一组路由在新旧前缀下都注册
  return [
    ...routes,
    ...routes.map((route) => ({
      ...route,
      path: route.path.replace(API_PREFIX, LEGACY_API_PREFIX),
    })),
  ]
}
