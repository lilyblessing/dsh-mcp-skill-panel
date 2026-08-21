/**
 * HTTP 路由层：控制动作（toggleMcp/toggleSkill）与全部 /api/mcp-skill-panel/* 端点。
 *
 * 从 index.ts 拆出（可维护性批次 P1-1），并收敛端点样板（P2-6）：
 * defineHandler 统一 method 校验 / 异步错误响应 / {ok:true,...} 包装。
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile } from 'node:fs/promises'
import { readState, writeState, stateApplyMode, type ApplyMode } from './state'
import { setSkillFlag, rowDisabledState } from './preset'
import { pendingMcp, applyPendingMcp } from './pending'
import { resolveAgent, collectMcp, collectSkills, confirmedSkills, pruneExpired, DOMAIN_TTL_MS, SKILL_TOGGLE_POLL_MS, type DomainCaches, type Deps } from './collect'
import { isMcpEntry, serverNameOf } from './mcp-entry'
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

function readBody(req: Req): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    const onData = (chunk: Buffer | string) => {
      body += String(chunk)
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`))
      }
    }
    const onEnd = () => {
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
 */
function handleAny(entries: Array<{ method: 'GET' | 'POST'; run: (req: Req) => Promise<object> }>, guardPosts = false): (req: Req, res: Res) => void {
  return (req, res) => {
    const entry = entries.find((e) => e.method === req.method)
    if (!entry) {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (guardPosts && req.method === 'POST' && !tokenOk(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    handle(entry.method, entry.run)(req, res)
  }
}

/* ── 控制动作 ──────────────────────────────────────────────────────────── */

async function toggleMcp(deps: Deps, entryId: string, disabled: boolean, applyMode?: ApplyMode) {
  const { ctx } = deps
  const mode = applyMode ?? stateApplyMode(await readState())
  const entry = ctx.loader.resolve(entryId)
  // 只允许启停 MCP 行：防止调用方传入任意 loader 行（含核心/其他插件行）被误停用。
  if (!isMcpEntry(entry)) {
    throw new Error(`entry "${entryId}" is not an MCP row`)
  }
  const rowId = entry.options.id
  // P1 会话边界生效（v0.5.0）：next-session 模式只记意图（进入待生效队列），
  // 不立即 entry.update —— 运行时 tools 前缀不变 → 当前会话零缓存失效、零费用。
  // 生效时机：新会话 agent/session-start 首次请求前 applyPendingMcp，或重启后
  // syncPresetFiles 物化预设。immediate（默认）保持原行为：下轮即生效（会 miss）。
  const deferred = mode === 'next-session'
  if (deferred) {
    pendingMcp.set(entryId, { entryId, file: (entry.parent?.tree as { filename?: string } | undefined)?.filename ?? null, rowId, disabled })
  } else {
    pendingMcp.delete(entryId)
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
  while (Date.now() < deadline) {
    const after = await ctx.skills.get(skillName, { scope: agent, cwd })
    if (after && after.invocation?.modelInvocable === !disabled) {
      confirmed = true
      break
    }
    await ctx.timeout(SKILL_TOGGLE_POLL_MS)
  }
  // 记录确认值，供 collectState 覆盖 snapshot 的陈旧 candidate（watcher 未及失效）
  pruneExpired(confirmedSkills, Date.now())
  if (confirmed) confirmedSkills.set(skillName, { modelInvocable: !disabled, at: Date.now() })
  return { name: skillName, disabled, modelInvocable: !disabled, path: def.path, confirmed }
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
      handler: handle('POST', async () => {
        // P1 会话边界：「立即应用待生效变更」强制生效入口。把 next-session 模式积压的
        // 待办一次性 entry.update（=临时转 immediate），随后的请求会 miss（调用方提示费用）。
        const applied = await applyPendingMcp(deps)
        invalidateMcp()
        return { applied }
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
      path: `${API_PREFIX}/config`,
      handler: handleAny([
        {
          method: 'GET',
          run: async () => {
            const state = await readState()
            return {
              autoManage: catalogRuntime.autoManage,
              applyMode: stateApplyMode(state),
              configAutoManage: config.autoManage ?? null,
            }
          },
        },
        {
          method: 'POST',
          run: async (req) => {
            const parsed = JSON.parse((await readBody(req)) || '{}') as {
              autoManage?: boolean
              applyMode?: ApplyMode
            }
            const state = await readState()
            state.config ??= {}
            if (typeof parsed.autoManage === 'boolean') {
              state.config.autoManage = parsed.autoManage
            }
            if (parsed.applyMode === 'immediate' || parsed.applyMode === 'next-session') {
              state.config.applyMode = parsed.applyMode
            }
            await writeState(state)
            if (typeof parsed.autoManage === 'boolean') catalogRuntime.applyAutoManage(parsed.autoManage)
            return { autoManage: catalogRuntime.autoManage, applyMode: stateApplyMode(state) }
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
        return { diag: catalogRuntime.diag, catalog }
      }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/debug/collect`,
      handler: handle('POST', async () => {
        await triggerSnapshot()
        return { diag: catalogRuntime.diag }
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
