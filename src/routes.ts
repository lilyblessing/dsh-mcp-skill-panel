/**
 * HTTP 路由层：控制动作（toggleMcp/toggleSkill）与全部 /api/mcp-skill-panel/* 端点。
 *
 * 从 index.ts 拆出（可维护性批次 P1-1），并收敛端点样板（P2-6）：
 * defineHandler 统一 method 校验 / 异步错误响应 / {ok:true,...} 包装。
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile } from 'node:fs/promises'
import { readState, writeState } from './state'
import { setSkillFlag, rowDisabledState } from './preset'
import { resolveAgent, collectMcp, collectSkills, confirmedSkills, pruneExpired, DOMAIN_TTL_MS, SKILL_TOGGLE_POLL_MS, type DomainCaches, type Deps } from './collect'
import { serverNameOf } from './mcp-entry'
import type { McpCallController } from './mcpcall'
import type { CatalogRuntime, Config } from './index'
import { messageOf } from './util'

const API_PREFIX = '/api/mcp-skill-panel'
/** 旧前缀（0.3.1 及以前为 /api/runtime-inventory），保留兼容 */
const LEGACY_API_PREFIX = '/api/runtime-inventory'
/** skill toggle 后等待 watcher 失效 catalog 的最长时间 */
const SKILL_TOGGLE_CONFIRM_MS = 5_000

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
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => resolve(body))
  })
}

function queryParam(url: string, key: string): string | undefined {
  const m = new RegExp(`[?&]${key}=([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : undefined
}

/** 端点样板：method 校验 + 异步执行 + {ok:true} 包装 + 统一错误码（POST 参数错 400 / GET 服务错 500）。 */
function handle(method: 'GET' | 'POST', run: (req: Req) => Promise<object>): (req: Req, res: Res) => void {
  return (req, res) => {
    if (req.method !== method) {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    Promise.resolve(run(req))
      .then((data) => ok(res, data))
      .catch((error) => json(res, method === 'POST' ? 400 : 500, { ok: false, error: messageOf(error) }))
  }
}

/* ── 控制动作 ──────────────────────────────────────────────────────────── */

async function toggleMcp(deps: Deps, entryId: string, disabled: boolean) {
  const { ctx } = deps
  const entry = ctx.loader.resolve(entryId)
  const rowId = entry.options.id
  await entry.update({ disabled })
  // 用户手动打开（!disabled）：清除 AI 临时启用标记（aiEnabled/计数/lastUsed +
  // state.json ai owner）—— 转为「用户打开」语义：模型立即可见、回收器不再回收。
  // 用户手动关闭（disabled）：AI 标记保持原样（若原本 AI 启用中，回收器/失败恢复照常管理）。
  if (!disabled && deps.controller) {
    deps.controller.markUserEnabled(serverNameOf(entry))
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
        const result = await toggleMcp(deps, parsed.entryId, Boolean(parsed.disabled))
        invalidateMcp()
        return result
      }),
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
      }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: handle('POST', async (req) => {
        const parsed = JSON.parse((await readBody(req)) || '{}') as { autoManage?: boolean }
        const on = Boolean(parsed.autoManage)
        const state = await readState()
        state.config ??= {}
        state.config.autoManage = on
        await writeState(state)
        catalogRuntime.applyAutoManage(on)
        return { autoManage: catalogRuntime.autoManage }
      }),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: handle('GET', async () => ({
        autoManage: catalogRuntime.autoManage,
        configAutoManage: config.autoManage ?? null,
      })),
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
      }),
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
