/**
 * HTTP 路由层：控制动作（toggleMcp/toggleSkill）与全部 /api/mcp-skill-panel/* 端点。
 *
 * 从 index.ts 拆出（可维护性批次 P1-1），并收敛端点样板（P2-6）：
 * defineHandler 统一 method 校验 / 异步错误响应 / {ok:true,...} 包装。
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises'
import { basename, dirname, join, parse as parsePath } from 'node:path'
import { homedir } from 'node:os'
import { readState, writeState, stateApplyMode, type ApplyMode } from './state'
import { setSkillFlag, rowDisabledState, isValidSkillName, buildSkillMd } from './preset'
import { pendingMcp, applyPendingMcp } from './pending'
import { resolveAgent, collectMcp, collectSkills, confirmedSkills, pruneExpired, DOMAIN_TTL_MS, SKILL_TOGGLE_POLL_MS, type DomainCaches, type Deps } from './collect'
import { isMcpEntry, serverNameOf } from './mcp-entry'
import { parseMcpServersJson, serversToPatchYaml, serversToRows, type McpServers, type McpRowConfig } from './mcp-convert'
import { remountWorkspace, projectServerOwner, getActiveWorkspace } from './project-mcp'
import { disabledToolsOf, setToolDisabled } from './tool-disable'
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
    handle(entry.method, entry.run, guardPosts)(req, res)
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

/** 已存在检查：loader 存活行或 patch 文本里已有同 id。 */
function existingRowIds(ctx: Context, patchText: string): Set<string> {
  const ids = new Set<string>()
  for (const entry of ctx.loader.entries()) {
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
