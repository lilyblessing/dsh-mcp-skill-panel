/**
 * dsh-mcp-skill-panel — Host 半区
 *
 * 设置页「MCP 与技能管理面板」的数据与控制面：
 * - MCP 页：枚举 loader 预设子树中的 mcp-* 行 + tools.schemas(scope) 聚合工具数/token，
 *   启停 = loader entry.update({disabled})（实时生效）。
 * - Skill 页：skills.snapshot/get 枚举目录，启停 = SKILL.md frontmatter
 *   `disable-model-invocation: true` 注入/移除（watcher 实时失效 catalog）。
 *
 * Phase A 实测结论（2026-08-15，动态探针验证）：
 * - ctx.loader.entries() 枚举全部行（含嵌套预设行，id 如 include:agent-presets:mcp-cheatengine）
 * - loader.resolve() 需要完整嵌套 id；entry.update({disabled}) 实时 dispose/restart
 * - 预设树（PresetTree）write() 是 no-op → loader.update 不写盘
 * - tools.schemas(scope) 必须传 scopeOf(agent.ctx)（agent 对象/standingKey 会落回全局视图）
 * - skill 文件经 skills.get(name, {scope, cwd}).path 定位；改 frontmatter 由
 *   dsh-skill-filesystem 的 chokidar watcher 实时失效
 *
 * MCP 持久化（v0.1.1 修复，2026-08-15）：
 * 运行期禁止写 agent.cordis.yml —— dsh-agent-presets 的 ensureStanding 用
 * {mtimeMs, size} stamp 检测预设文件变化，变化时删除 standing 记录并重挂，
 * 但旧 standing 的 fiber/scope 不 dispose → 旧 mcp-client 实例的 serverName
 * 仍占用 → 新挂载全部 "already in use" → 会话创建/resume 失败（实测事故）。
 * 持久化改为：toggle 只写插件自己的状态文件（~/.dsh/dsh-runtime-inventory/state.json），
 * 插件 apply 时（启动早期、standing 未挂载）再物化到预设文件 —— 此时写文件安全。
 */
import Schema from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'runtime-inventory'

export const inject = ['fs', 'skills', 'tools', 'agents', 'agentPresets', 'loader']

export interface Config {
  /** @deprecated 0.3.0 起分域缓存由事件驱动失效，TTL 为常量；保留字段仅为向后兼容 */
  cacheTtlMs?: number
}

export const Config: Schema<Config> = Schema.object({
  cacheTtlMs: Schema.number().min(0),
})

const API_PREFIX = '/api/mcp-skill-panel'
/** 旧前缀（0.3.1 及以前为 /api/runtime-inventory），保留兼容 */
const LEGACY_API_PREFIX = '/api/runtime-inventory'
const DISABLE_KEY = 'disable-model-invocation'
/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
const DOMAIN_TTL_MS = 60_000
/** skill toggle 后等待 watcher 失效 catalog 的最长时间 */
const SKILL_TOGGLE_CONFIRM_MS = 5_000
/** 已确认的 skill 状态在 collectState 中覆盖 snapshot 旧值的有效期 */
const CONFIRMED_SKILL_TTL_MS = 60_000

/**
 * 最近一次 toggle 确认过的 skill 状态（name → modelInvocable）。
 * 服务端轮询用 skills.get 实时读文件确认，早于 snapshot 的发现缓存失效，
 * 用它覆盖 collectState 里的陈旧 candidate 值。
 */
const confirmedSkills = new Map<string, { modelInvocable: boolean; at: number }>()

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

interface McpEntryView {
  entryId: string
  rowId: string
  serverName: string
  transport: string | null
  disabled: boolean
  running: boolean
  tools: number
  tokens: number
  status: 'active' | 'disabled' | 'idle' | 'failed'
}

interface SkillView {
  name: string
  description: string
  source: string
  modelInvocable: boolean
  userInvocable: boolean
  path?: string
}

export interface McpView {
  sessionId: string | null
  preset: string | null
  cwd: string | null
  mcp: McpEntryView[]
  mcpTotal: number
  mcpDisabled: number
  mcpToolsTotal: number
  mcpTokensTotal: number
  errors: string[]
}

export interface SkillsView {
  sessionId: string | null
  preset: string | null
  cwd: string | null
  skills: SkillView[]
  skillsTotal: number
  skillsModelVisible: number
  errors: string[]
}

/** part=all（缺省）时的完整响应 */
export type RuntimeState = McpView & SkillsView

/* ── 工具函数 ──────────────────────────────────────────────────────────── */

function tokenEstimate(parameters: unknown): number {
  try {
    return Math.max(1, Math.round(JSON.stringify(parameters ?? {}).length / 4))
  } catch {
    return 1
  }
}

function serverOf(name: string): string | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const at = rest.indexOf('__')
  if (at < 0) return null
  return rest.slice(0, at)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 新行分隔符：跟随原文件。 */
function lineSep(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 在组合文件中对 `- id: <rowId>` 行做 `  <key>: <value>` 标记的插入/移除。
 * 逐行文本编辑，保留注释与 !!js 表达式原样（loader 的 yaml.dump 会丢注释，故不用）。
 */
export function setRowFlag(text: string, rowId: string, key: string, value: boolean): string {
  const nl = lineSep(text)
  const lines = text.split(/\r?\n/)
  const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`)
  const idx = lines.findIndex((line) => rowRe.test(line))
  if (idx < 0) throw new Error(`row "- id: ${rowId}" not found in composition file`)
  let end = idx + 1
  while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1
  const block = lines.slice(idx, end)
  const flagRe = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(true|false)\\s*$`)
  const flagAt = block.findIndex((line) => flagRe.test(line))
  if (value && flagAt < 0) {
    lines.splice(idx + 1, 0, `  ${key}: true`)
    return lines.join(nl)
  }
  if (!value && flagAt >= 0) {
    // flagAt 是行块（block = lines.slice(idx, end)）内的偏移 → 全局偏移为 idx + flagAt
    lines.splice(idx + flagAt, 1)
    return lines.join(nl)
  }
  return text
}

/** SKILL.md frontmatter 的 disable-model-invocation 键注入/移除（kebab-case 是唯一合法形式）。 */
export function setSkillFlag(text: string, value: boolean): string {
  const nl = lineSep(text)
  const has = new RegExp(`^${DISABLE_KEY}:\\s*true\\s*$`, 'm').test(text)
  if (value && !has) {
    const m = /^---\s*(\r?\n)/.exec(text)
    if (!m) throw new Error('skill file has no frontmatter block')
    return text.slice(0, m.index + m[0].length) + `${DISABLE_KEY}: true${nl}` + text.slice(m.index + m[0].length)
  }
  if (!value && has) {
    return text.replace(new RegExp(`^${DISABLE_KEY}:\\s*true\\s*${nl}`, 'm'), '')
  }
  return text
}

/** 组合文件中某行当前 disabled 状态：行块内有 disabled 键 → true/false；无键 → null。 */
export function rowDisabledState(text: string, rowId: string): boolean | null {
  const lines = text.split(/\r?\n/)
  const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`)
  const idx = lines.findIndex((line) => rowRe.test(line))
  if (idx < 0) return null
  let end = idx + 1
  while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1
  const flagRe = /^\s*disabled:\s*(true|false)\s*$/
  for (let i = idx + 1; i < end; i += 1) {
    const m = flagRe.exec(lines[i])
    if (m) return m[1] === 'true'
  }
  return null
}

/* ── MCP 持久化（状态文件 + 启动早期物化，v0.1.1） ─────────────────────── */

const LEGACY_STATE_DIR = join(homedir(), '.dsh', 'dsh-runtime-inventory')
const STATE_DIR = join(homedir(), '.dsh', 'dsh-mcp-skill-panel')
const STATE_FILE = join(STATE_DIR, 'state.json')

/** 每个预设文件（key=文件绝对路径）→ 每个 mcp 行 → 意图与上次物化状态。 */
interface McpRowState {
  /** toggle 时用户意图：是否停用 */
  desired: boolean
  /** toggle 时该行在文件中的实际状态（true/false/null=无 disabled 键） */
  lastApplied: boolean | null
}

type StateFile = { mcp?: Record<string, Record<string, McpRowState>> }

async function readState(): Promise<StateFile> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as StateFile
  } catch {
    // 0.2.0 改名迁移：旧状态目录（dsh-runtime-inventory）有数据则搬过来
    try {
      const legacy = join(LEGACY_STATE_DIR, 'state.json')
      const text = await readFile(legacy, 'utf8')
      await mkdir(STATE_DIR, { recursive: true })
      await rename(legacy, STATE_FILE)
      return JSON.parse(text) as StateFile
    } catch {
      return {}
    }
  }
}

async function writeState(state: StateFile): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2), 'utf8')
  await rename(`${STATE_FILE}.tmp`, STATE_FILE)
}

/**
 * 启动早期物化：把状态文件里的 MCP 启停意图写入预设组合文件。
 * 只在「没有任何 agent 在跑」时执行 —— 有会话时写文件会触发
 * dsh-agent-presets 的 stamp 重挂（旧实例不 dispose → serverName 冲突事故）。
 */
export async function syncPresetFiles(ctx: Context): Promise<number> {
  if (ctx.agents.list().length > 0) return 0
  const state = await readState()
  const mcp = state.mcp
  if (!mcp || Object.keys(mcp).length === 0) return 0
  let materialized = 0
  for (const [file, rows] of Object.entries(mcp)) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    let changed = false
    const next: Record<string, McpRowState> = {}
    for (const [rowId, entry] of Object.entries(rows)) {
      const cur = rowDisabledState(text, rowId)
      if (cur !== entry.lastApplied) {
        // 文件被外部（用户）修改过：尊重现状，放弃对该行的管理
        continue
      }
      const curBool = cur === true
      if (curBool !== entry.desired) {
        try {
          text = setRowFlag(text, rowId, 'disabled', entry.desired)
          changed = true
          materialized += 1
        } catch {
          // 行已不存在（用户删除）：放弃管理
          continue
        }
      }
      next[rowId] = { desired: entry.desired, lastApplied: curBool }
    }
    if (changed) await writeFile(file, text, 'utf8')
    mcp[file] = next
  }
  await writeState(state)
  return materialized
}

/* ── 数据收集 ──────────────────────────────────────────────────────────── */

interface Deps {
  ctx: Context
  caches: DomainCaches
}

function resolveAgent(ctx: Context, sessionId: string | undefined) {
  if (sessionId) {
    // SessionId 是品牌类型；HTTP query 字符串需显式转换
    const byId = ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    if (byId) return byId
  }
  const roots = ctx.agents.roots()
  if (roots.length > 0) return roots[0]
  return ctx.agents.list()[0]
}

function baseView(
  ctx: Context,
  agent: ReturnType<typeof resolveAgent>,
  cwd: string | undefined,
): Pick<McpView, 'sessionId' | 'preset' | 'cwd'> {
  let preset: string | null = null
  try {
    if (agent) preset = ctx.agentPresets.composedPreset(agent.ctx) ?? null
  } catch {
    preset = null
  }
  return { sessionId: agent ? agent.id : null, preset, cwd: cwd ?? null }
}

/** MCP 工具聚合结果：per-server 工具数 + token 估算。tools/change 间隙复用，跳过 schemas 深克隆。 */
interface McpAggregate {
  byServer: Map<string, { tools: number; tokens: number }>
  mcpToolsTotal: number
  mcpTokensTotal: number
}

function computeAggregate(schemas: Array<{ name?: string; parameters?: unknown }>): McpAggregate {
  const byServer = new Map<string, { tools: number; tokens: number }>()
  let mcpToolsTotal = 0
  let mcpTokensTotal = 0
  for (const schema of schemas) {
    const server = serverOf(String(schema.name ?? ''))
    if (!server) continue
    const entry = byServer.get(server) ?? { tools: 0, tokens: 0 }
    entry.tools += 1
    entry.tokens += tokenEstimate(schema.parameters)
    byServer.set(server, entry)
    mcpToolsTotal += 1
    mcpTokensTotal += tokenEstimate(schema.parameters)
  }
  return { byServer, mcpToolsTotal, mcpTokensTotal }
}

/**
 * 按 scope 复用的 MCP 聚合缓存（C 项优化）：tools.schemas 深克隆 300+ 工具是
 * collectMcp 最重的一步；聚合结果在 tools/change 事件间隙直接复用，
 * TTL 只是事件丢失时的兜底。key = scopeKey（null 表示全局视图）。
 */
function getMcpAggregate(
  ctx: Context,
  caches: DomainCaches,
  scopeKey: object | undefined,
  errors: string[],
): McpAggregate {
  const key = scopeKey ?? null
  const hit = caches.mcpAggregates.get(key)
  if (hit && Date.now() - hit.at < DOMAIN_TTL_MS) return hit.value
  let schemas: Array<{ name?: string; parameters?: unknown }> = []
  try {
    schemas = scopeKey ? ctx.tools.schemas(scopeKey) : ctx.tools.schemas()
  } catch (error) {
    errors.push(`tools.schemas: ${messageOf(error)}`)
  }
  const value = computeAggregate(schemas)
  caches.mcpAggregates.set(key, { at: Date.now(), value })
  return value
}

async function collectMcp(deps: Deps, sessionId: string | undefined): Promise<McpView> {
  const { ctx } = deps
  const errors: string[] = []
  const agent = resolveAgent(ctx, sessionId)
  const scopeKey = agent ? scopeOf(agent.ctx) : undefined
  const cwd = agent?.session?.header?.cwd ?? undefined

  // MCP：loader 行 × schema 聚合（聚合结果版本化复用）
  const { byServer, mcpToolsTotal, mcpTokensTotal } = getMcpAggregate(ctx, deps.caches, scopeKey, errors)

  const mcp: McpEntryView[] = []
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry.options.group) continue
      const cfg = entry.options.config
      const isMcp =
        entry.options.name === '@deepseek-ai/dsh-mcp-client' ||
        (cfg !== null && typeof cfg === 'object' && 'serverName' in (cfg as object))
      if (!isMcp) continue
      const serverName = String((cfg as { serverName?: unknown } | undefined)?.serverName ?? entry.options.id)
      const agg = byServer.get(serverName)
      const tools = agg?.tools ?? 0
      const running = entry.fiber !== undefined
      const disabled = entry.disabled
      const status: McpEntryView['status'] = disabled
        ? 'disabled'
        : running
          ? tools > 0
            ? 'active'
            : 'idle'
          : 'failed'
      mcp.push({
        entryId: entry.id,
        rowId: entry.options.id,
        serverName,
        transport: (cfg as { transport?: unknown } | undefined)?.transport
          ? String((cfg as { transport?: unknown }).transport)
          : null,
        disabled,
        running,
        tools,
        tokens: agg?.tokens ?? 0,
        status,
      })
    }
  } catch (error) {
    errors.push(`loader.entries: ${messageOf(error)}`)
  }
  mcp.sort((a, b) => a.serverName.localeCompare(b.serverName))

  return {
    ...baseView(ctx, agent, cwd),
    mcp,
    mcpTotal: mcp.length,
    mcpDisabled: mcp.filter((row) => row.disabled).length,
    mcpToolsTotal,
    mcpTokensTotal,
    errors,
  }
}

async function collectSkills(deps: Deps, sessionId: string | undefined): Promise<SkillsView> {
  const { ctx } = deps
  const errors: string[] = []
  const agent = resolveAgent(ctx, sessionId)
  const cwd = agent?.session?.header?.cwd ?? undefined

  // Skills
  const skills: SkillView[] = []
  let skillsModelVisible = 0
  try {
    const snapshot = await ctx.skills.snapshot({ scope: agent, cwd })
    for (const summary of snapshot.skills) {
      // toggle 确认值覆盖：snapshot 的 candidate 缓存可能落后于 watcher 失效
      // （skills.get 实时读文件已确认新值，snapshot 的发现缓存要等 watcher 200ms 生效）。
      // 60s 内确认过的 skill 以确认值为准，避免 UI 翻回 + state 缓存钉住旧值。
      const confirmed = confirmedSkills.get(summary.name)
      const modelInvocable =
        confirmed && Date.now() - confirmed.at < CONFIRMED_SKILL_TTL_MS ? confirmed.modelInvocable : summary.invocation?.modelInvocable !== false
      if (modelInvocable) skillsModelVisible += 1
      skills.push({
        name: summary.name,
        description: summary.description ?? '',
        source: summary.source ?? 'unknown',
        modelInvocable,
        userInvocable: summary.invocation?.userInvocable !== false,
      })
    }
  } catch (error) {
    errors.push(`skills.snapshot: ${messageOf(error)}`)
  }

  return {
    ...baseView(ctx, agent, cwd),
    skills,
    skillsTotal: skills.length,
    skillsModelVisible,
    errors,
  }
}

/* ── 控制动作 ──────────────────────────────────────────────────────────── */

async function toggleMcp(deps: Deps, entryId: string, disabled: boolean) {
  const { ctx } = deps
  const entry = ctx.loader.resolve(entryId)
  const rowId = entry.options.id
  await entry.update({ disabled })
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
    await delay(80)
  }
  // 记录确认值，供 collectState 覆盖 snapshot 的陈旧 candidate（watcher 未及失效）
  if (confirmed) confirmedSkills.set(skillName, { modelInvocable: !disabled, at: Date.now() })
  return { name: skillName, disabled, modelInvocable: !disabled, path: def.path, confirmed }
}

/* ── HTTP 路由 ────────────────────────────────────────────────────────── */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function json(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, code: number, body: unknown) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: { on: (event: 'data' | 'end', cb: (chunk?: unknown) => void) => void }): Promise<string> {
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

export function makeRoutes(
  ctx: Context,
  caches: DomainCaches,
  config: Config = {},
): Array<{
  kind: 'exact'
  path: string
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
}> {
  const deps: Deps = { ctx, caches }
  const { mcpCache, skillsCache, invalidateMcp, invalidateSkills } = caches

  const cachedMcp = (sessionId: string | undefined) => {
    const key = sessionId ?? '*'
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
    const hit = skillsCache.get(key)
    if (hit && Date.now() - hit.at < DOMAIN_TTL_MS) return hit.promise
    const promise = collectSkills(deps, sessionId).catch((error) => {
      skillsCache.delete(key)
      throw error
    })
    skillsCache.set(key, { at: Date.now(), promise })
    return promise
  }

  const routes: Array<{
    kind: 'exact'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
  }> = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const url = req.url ?? ''
        const sessionId = queryParam(url, 'session')
        const part = queryParam(url, 'part') ?? 'all'
        const respond = (state: unknown) => json(res, 200, { ok: true, state })
        const fail = (error: unknown) => json(res, 500, { ok: false, error: messageOf(error) })
        if (part === 'mcp') {
          cachedMcp(sessionId).then(respond, fail)
          return
        }
        if (part === 'skills') {
          cachedSkills(sessionId).then(respond, fail)
          return
        }
        // all（缺省）：完整视图
        Promise.all([cachedMcp(sessionId), cachedSkills(sessionId)])
          .then(([mcp, skills]) => respond({ ...mcp, ...skills, errors: [...mcp.errors, ...skills.errors] }))
          .catch(fail)
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/mcp/toggle`,
      handler: (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        readBody(req)
          .then((body) => JSON.parse(body || '{}') as { entryId?: string; disabled?: boolean })
          .then((parsed) => {
            if (!parsed.entryId) throw new Error('entryId is required')
            return toggleMcp(deps, parsed.entryId, Boolean(parsed.disabled))
          })
          .then((result) => {
            invalidateMcp()
            json(res, 200, { ok: true, ...result })
          })
          .catch((error) => json(res, 400, { ok: false, error: messageOf(error) }))
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/skill/toggle`,
      handler: (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        readBody(req)
          .then((body) => JSON.parse(body || '{}') as { name?: string; disabled?: boolean; session?: string })
          .then(async (parsed) => {
            if (!parsed.name) throw new Error('name is required')
            return toggleSkill(deps, parsed.name, Boolean(parsed.disabled), parsed.session)
          })
          .then((result) => {
            invalidateSkills()
            json(res, 200, { ok: true, ...result })
          })
          .catch((error) => json(res, 400, { ok: false, error: messageOf(error) }))
      },
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

/* ── 插件主体 ──────────────────────────────────────────────────────────── */

/** 分域缓存句柄：apply 创建，makeRoutes 消费，事件失效由 apply 订阅。 */
interface DomainCaches {
  mcpCache: Map<string, { at: number; promise: Promise<McpView> }>
  skillsCache: Map<string, { at: number; promise: Promise<SkillsView> }>
  /** MCP 工具聚合缓存（per scope），tools/change 时随 mcpCache 一起清 */
  mcpAggregates: Map<object | null, { at: number; value: McpAggregate }>
  invalidateMcp: () => void
  invalidateSkills: () => void
}

function createDomainCaches(): DomainCaches {
  const mcpCache = new Map<string, { at: number; promise: Promise<McpView> }>()
  const skillsCache = new Map<string, { at: number; promise: Promise<SkillsView> }>()
  const mcpAggregates = new Map<object | null, { at: number; value: McpAggregate }>()
  return {
    mcpCache,
    skillsCache,
    mcpAggregates,
    invalidateMcp: () => {
      mcpCache.clear()
      mcpAggregates.clear()
    },
    invalidateSkills: () => skillsCache.clear(),
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  // 启动早期物化 MCP 启停意图（仅当无会话在跑时；有会话则下次重启再物化）。
  // 不阻塞 apply；失败只记日志，不拖累插件挂载。
  void syncPresetFiles(ctx).then(
    (count) => {
      if (count > 0) ctx.logger.info(`runtime-inventory: materialized ${count} MCP row state(s) into preset composition`)
    },
    (error: unknown) => {
      ctx.logger.warn(`runtime-inventory: preset sync skipped: ${messageOf(error)}`)
    },
  )

  // 分域缓存 + 事件驱动失效。事件在 root ctx emit（tools/change 来自工具注册表、
  // skills/change 来自 skill registry），必须挂 root 监听才能收到；用 ctx.effect
  // 确保插件卸载时解除监听（root 上的监听不随 fiber 自动清理）。
  const caches = createDomainCaches()
  ctx.effect(
    () => {
      const offTools = ctx.root.on('tools/change', caches.invalidateMcp)
      const offLoader = ctx.root.on('loader/partial-dispose', caches.invalidateMcp)
      const offSkills = ctx.root.on('skills/change', caches.invalidateSkills)
      return () => {
        offTools()
        offLoader()
        offSkills()
      }
    },
    'runtime-inventory: cache invalidation',
  )

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const routes = makeRoutes(httpCtx, caches, config)
      const disposers = routes.map((route) => httpCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'runtime-inventory: routes')
  })
}
