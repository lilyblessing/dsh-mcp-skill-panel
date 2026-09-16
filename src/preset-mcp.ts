/**
 * rc.1 standing 组合 preset 行读取（空面板修复A 0.5.5 + 预设直通 0.5.6，2026-09-08）。
 *
 * 背景：dsh 0.1.2-rc.1 起 preset 行挂在 standing 组合（agent scope 树），不再进
 * `ctx.loader.entries()`（实证 host/agent loader 156 行零 MCP，而
 * `compositionInventory()` 显示 standard-mcp 10 行、filesystem fiberState=2 运行中）。
 * collectMcp 只扫 loader → mcp[]==0 空面板（0.5.5 补行修复）；mcp_call 也因
 * findMcpEntry miss 而报「不在 loader 中」（0.5.6 直通修复见 mcpcall.ts call()）。
 *
 * 本模块只经 `ctx.agentPresets` 服务读数（compositionInventory/resolve/read），
 * 不直连 `livePresetMounts` 模块实例（host 与面板各装一份，模块态不共享），
 * 不产生运行时新依赖（type-only import，tsdown external 无影响）。
 */

import type { Context } from '@deepseek-ai/cordis'

/** preset 文件文本解析出的单行 MCP 配置（key = 短 rowId，如 mcp-filesystem）。
 *
 * P1 直读（2026-09-09）：除 serverName/transport/超时外，追加 dsh-mcp-client
 * 挂载所需的全键（command/args/env/cwd/url/headers/failOnStartupError）。
 * env/headers 的值是**求值后**的最终字符串（`!!js` 在解析时即用 process.env
 * 求值，与 loader 加载时语义一致；失败回落 ''）。transport 缺省时按
 * mcp-convert.ts:108-119 规则推断（有 command→stdio/有 url→http），推断不出
 * 才为 null（兼容旧行为）。
 */
export interface PresetMcpParsed {
  serverName: string
  transport: string | null
  toolCallTimeoutMs?: number
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  failOnStartupError?: boolean
}

/** 短 rowId 回落 serverName（preset 文本缺 serverName 键时用；覆盖已知例外）。 */
function fallbackServerName(rowId: string): string {
  if (rowId === 'mcp-anki') return 'anki-mcp'
  return rowId.replace(/^mcp-/, '')
}

/**
 * 解析 preset 组合文本，抽取全部 `mcp-*` 行的 serverName/transport/超时/挂载全键。
 * 纯文本正则（preset 文件结构稳定）：按 `^- id:` 切块，块内抓 serverName/
 * transport/toolCallTimeoutMs/command/args/env/cwd/url/headers/failOnStartupError。
 * 键锚定行首（防注释/长键误命中）；值允许可选双引号（YAML `"stdio"` 形态）。
 * `!!js "..."` 表达式在解析时即求值（process.env 语义，与 loader 一致）。
 * transport 缺省按 mcp-convert.ts:108-119 推断（有 command→stdio/有 url→http）。
 * 纯函数，可被 selftest 直接覆盖。
 */
export function parsePresetMcpText(text: string): Map<string, PresetMcpParsed> {
  const out = new Map<string, PresetMcpParsed>()
  const blocks = String(text ?? '').split(/(?=^- id:\s*)/m)
  for (const block of blocks) {
    const idMatch = /^-\s*id:\s*"?([^"\s]+)"?\s*$/m.exec(block)
    if (!idMatch) continue
    const rowId = idMatch[1]
    if (!rowId.startsWith('mcp-')) continue
    const sn = /^\s*serverName:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*(?:#.*)?$/m.exec(block)
    const tr = /^\s*transport:\s*['"]?(\S+?)['"]?\s*(?:#.*)?$/m.exec(block)
    const tm = /^\s*toolCallTimeoutMs:\s*['"]?(\d+)['"]?\s*(?:#.*)?$/m.exec(block)
    const cmd = /^\s*command:\s*['"]?([^'"\n]+?)['"]?\s*(?:#.*)?$/m.exec(block)
    const cwd = /^\s*cwd:\s*['"]?([^'"\n]+?)['"]?\s*(?:#.*)?$/m.exec(block)
    const url = /^\s*url:\s*['"]?([^'"\n\s]+?)['"]?\s*(?:#.*)?$/m.exec(block)
    const fos = /^\s*failOnStartupError:\s*['"]?(\S+?)['"]?\s*(?:#.*)?$/m.exec(block)
    const args = parseYamlStringList(block, 'args')
    const env = parseYamlStringMap(block, 'env')
    const headers = parseYamlStringMap(block, 'headers')
    const command = cmd ? processScalar(cmd[1].trim()) : undefined
    // transport 缺省推断（mcp-convert.ts:108-119 同规则）：显式值优先归一，
    // 否则有 command→stdio、有 url→http，推断不出才 null。
    // WARN-4：未知值统一小写存放（presetConfigOf 全等比较小写，不可挂载≠丢弃）。
    let transport: string | null = tr ? (normalizeTransportToken(tr[1]) ?? tr[1].toLowerCase()) : null
    if (!transport) {
      if (command !== undefined) transport = 'stdio'
      else if (url) transport = 'streamable-http'
    }
    const parsed: PresetMcpParsed = {
      serverName: sn ? sn[1] : fallbackServerName(rowId),
      transport,
    }
    if (tm) {
      const n = Number(tm[1])
      if (Number.isFinite(n) && n > 0) parsed.toolCallTimeoutMs = n
    }
    if (command !== undefined) parsed.command = command
    if (args) parsed.args = args.map((a) => processScalar(a))
    if (env) {
      const outEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(env)) outEnv[k] = processScalar(v)
      parsed.env = outEnv
    }
    if (cwd) parsed.cwd = processScalar(cwd[1].trim())
    if (url) parsed.url = processScalar(url[1].trim())
    if (headers) {
      const outHeaders: Record<string, string> = {}
      for (const [k, v] of Object.entries(headers)) outHeaders[k] = processScalar(v)
      parsed.headers = outHeaders
    }
    if (fos) {
      const token = unquoteYamlScalar(fos[1].trim()).toLowerCase()
      if (token === 'true') parsed.failOnStartupError = true
      else if (token === 'false') parsed.failOnStartupError = false
    }
    out.set(rowId, parsed)
  }
  return out
}

/** transport 显式值归一（mcp-convert.ts:112-113 同规则；未知返回 undefined 交上层原样保留）。 */
function normalizeTransportToken(token: string): string | undefined {
  const t = token.toLowerCase()
  if (t === 'stdio' || t === 'command') return 'stdio'
  if (t === 'streamable-http' || t === 'http' || t === 'sse') return 'streamable-http'
  return undefined
}

/** 去 YAML 标量外层引号（单/双引号各一层；`!!js` 前缀保留给 evalJsScalar 处理）。 */
function unquoteYamlScalar(value: string): string {
  const v = value.trim().replace(/^!!js\s+/, '')
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1)
    // YAML 单引号标量 '' 转义还原
    return v.startsWith("'") ? inner.replace(/''/g, "'") : inner
  }
  return v
}

/**
 * `!!js "..."` 标量求值（与 loader 加载时语义对齐的子集）：
 * 表达式可以是任意 JS（模板字面量/三元/|| 回落，如
 * `process.env.X ? `Bearer ${process.env.X}` : ''`），用当前 process.env
 * 求值；无 `!!js` 前缀/求值失败返回 undefined（调用方回落原串）。
 *
 * 信任假设（WARN-1）：预设文件是本地可信配置，与 loader 的 `!!js` 求值信任
 * 等级相同（loader 加载时同样求值）。若预设文件来源不可信（远端拉取未审
 * 核），不要启用本解析——`new Function` 可执行任意 JS。
 * 求值失败（表达式抛错）返回 undefined → 调用方回落原串（原串可能含
 * `process.env.X` 字面量，发出后由远端报可见错误，不静默吞错）。
 */
function evalJsScalar(value: string): string | undefined {
  const raw = value.trim()
  const m = /^!!js\s+([\s\S]+)$/.exec(raw)
  if (!m) return undefined
  let expr = m[1].trim()
  // 外层 YAML 引号包装：双引号用 JSON.parse 还原（内含 ` 与 ${} 不影响 JSON 解析）；
  // 单引号剥一层并还原 '' 转义（与 unquoteYamlScalar 同规则）。
  if (expr.length >= 2 && expr.startsWith("'") && expr.endsWith("'")) {
    expr = expr.slice(1, -1).replace(/''/g, "'")
  } else if (expr.length >= 2 && expr.startsWith('"') && expr.endsWith('"')) {
    try {
      expr = JSON.parse(expr) as string
    } catch {
      return undefined
    }
  }
  expr = expr.trim()
  if (!expr) return undefined
  try {
    // 任意表达式求值：仅 process.env 可见（与预设 `!!js` 的求值环境子集一致；
    // 预设文件是本地可信配置，与 loader 求值信任等级相同）。
    const fn = new Function('process', `return (${expr});`)
    const out = fn({ env: process.env })
    if (out === undefined || out === null) return ''
    return typeof out === 'string' ? out : String(out)
  } catch {
    return undefined
  }
}

/**
 * 标量全处理（P1 直读统一入口）：`!!js` 先求值，否则去引号，最后解 `${VAR}`。
 * 调用方一律走本函数，不再自行组合 unquote/eval/resolve（防 `!!js` 前缀被
 * unquote 提前剥掉导致 eval 失效）。
 * WARN-6：`!!js` 求值成功分支跳过二次 `${VAR}` 展开（loader 不二次展开；
 * 求值结果里的字面 `${}` 原样保留，不改写密钥）。
 */
function processScalar(raw: string): string {
  const evaluated = evalJsScalar(raw)
  if (evaluated !== undefined) return evaluated
  return resolveEnvRefsInText(unquoteYamlScalar(raw))
}

/** 文本内 `${VAR}` → process.env 求值；缺失保留占位符（与 resolveServersEnv 同语义）。 */
function resolveEnvRefsInText(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const env = (process.env as Record<string, string | undefined>)[name]
    return env !== undefined ? env : `\${${name}}`
  })
}

/**
 * 块内 YAML 字符串列表抓取（args 形态）：
 * flow 单行 `args: ['a', 'b']` 优先（quote-aware 逗号切分，单/双引号内逗号、
 * Windows 反斜杠、CJK 均保留）；无 flow 才按 block 节（`args:` 独占一行 +
 * 缩进更深的 `- item` 行）逐行收，直到遇到同级/更浅键。
 * 值原串保留（`!!js`/引号/注释均不动，上层 processScalar 统一处理）。
 */
function parseYamlStringList(block: string, key: string): string[] | undefined {
  const lines = block.split('\n')
  const headAnyRe = new RegExp(`^(\\s*)${key}:(.*)$`)
  let headLine = -1
  let baseIndent = 0
  let headRest = ''
  for (let i = 0; i < lines.length; i += 1) {
    const m = headAnyRe.exec(lines[i])
    if (m) {
      headLine = i
      baseIndent = m[1].length
      headRest = stripTrailingComment(m[2].trim())
      break
    }
  }
  if (headLine < 0) return undefined
  // flow 单行形态：`args: [...]`（行尾注释已剥，见 headRest）
  if (headRest.startsWith('[')) {
    return parseFlowStringList(headRest)
  }
  if (headRest !== '') return undefined
  const out: string[] = []
  for (let i = headLine + 1; i < lines.length; i += 1) {
    const line = lines[i]
    // WARN-2：节内纯注释/空行跳过，不截断（mimo-image:407-408 风格注释紧贴节）
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent <= baseIndent) break
    const item = /^\s*-\s+(.*?)\s*$/.exec(line)
    if (!item) break
    // 行尾注释剥离（引号内的 # 保留），值原串保留交上层 processScalar
    out.push(stripTrailingComment(item[1]))
  }
  return out
}

/**
 * flow 单行字符串列表解析（quote-aware）：
 * `['-u', 'D:\\a\\b.py']` → [`-u`, `D:\\a\\b.py`]。外层 `[]` 必备；
 * 项内单/双引号配对剥离（单引号内 `''` 转义还原），引号内逗号不切分；
 * 反斜杠原样保留（Windows 路径）；空项跳过。格式非法返回 undefined。
 */
function parseFlowStringList(rest: string): string[] | undefined {
  const s = rest.trim()
  if (!s.startsWith('[')) return undefined
  const end = findFlowListEnd(s)
  if (end < 0) return undefined
  const body = s.slice(1, end)
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let hasToken = false
  const push = () => {
    if (!hasToken) return
    const token = cur.trim()
    hasToken = false
    cur = ''
    if (token === '') return
    out.push(token)
  }
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (inSingle) {
      if (ch === "'") {
        if (body[i + 1] === "'") {
          cur += "'"
          i += 1
        } else {
          inSingle = false
        }
      } else {
        cur += ch
      }
      continue
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < body.length) {
        cur += ch + body[i + 1]
        i += 1
        continue
      }
      if (ch === '"') inDouble = false
      else cur += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      hasToken = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      hasToken = true
      continue
    }
    if (ch === ',') {
      push()
      continue
    }
    if (/\s/.test(ch) && !hasToken) continue
    hasToken = true
    cur += ch
  }
  push()
  return out
}

/** flow 列表外层 `]` 定位（跳过引号内 `]`；反斜杠转义识别）。 */
function findFlowListEnd(s: string): number {
  let inSingle = false
  let inDouble = false
  for (let i = 1; i < s.length; i += 1) {
    const ch = s[i]
    if (inSingle) {
      if (ch === "'") {
        if (s[i + 1] === "'") i += 1
        else inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === ']') return i
  }
  return -1
}

/**
 * 块内 YAML 字符串字典抓取（env/headers 形态）：
 * flow 单行 `env: {K: v}` 暂不支持（实块均为 block 形态，遇 flow 返回 undefined
 * 交上层缺省；NIT-4 注记）；block 节定位，收 `KEY: value` 行；非标量值跳过。
 * 值原串保留（`!!js` 交上层 processScalar 统一求值）。
 */
function parseYamlStringMap(block: string, key: string): Record<string, string> | undefined {
  const lines = block.split('\n')
  const headRe = new RegExp(`^(\\s*)${key}:\\s*(?:#.*)?$`)
  let start = -1
  let baseIndent = 0
  for (let i = 0; i < lines.length; i += 1) {
    const m = headRe.exec(lines[i])
    if (m) {
      start = i
      baseIndent = m[1].length
      break
    }
  }
  if (start < 0) return undefined
  const out: Record<string, string> = {}
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    // WARN-2：节内纯注释/空行跳过，不截断
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent <= baseIndent) break
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line)
    if (!kv) break
    const rawValue = kv[2]
    // 剥行尾注释（引号/反引号模板内的 # 保留）：找不在引号内的第一个 #（前有空白）
    const value = stripTrailingComment(rawValue)
    if (value === '') continue
    // 嵌套结构（下一行更深缩进）暂不支持：跳过该键（env/headers 均为扁平）
    const next = lines[i + 1]
    const nextIndent = next !== undefined && !/^\s*$/.test(next) ? (next.match(/^\s*/)?.[0].length ?? 0) : 0
    if (next !== undefined && !/^\s*$/.test(next) && nextIndent > indent && !/^\s*-\s+/.test(next)) continue
    // 值原串保留（引号/`!!js` 均不动，上层 processScalar 统一处理）
    out[kv[1]] = value
  }
  return out
}

/** 剥行尾注释：引号外的 ` #` 起为注释；引号内/反引号模板内的 # 保留（WARN-7）。
 *
 * 跟踪单引号（含 `''` 转义）/双引号（反斜杠转义）/反引号模板（含 `${}` 嵌套
 * 的引号不干扰外层反引号状态）。
 */
function stripTrailingComment(raw: string): string {
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inBacktick) {
      // 反引号模板内：`${...}` 是表达式（其内引号不干扰模板状态），`\\` 转义跳过
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === '`') {
        inBacktick = false
        continue
      }
      if (ch === '$' && raw[i + 1] === '{') {
        // 跳过 ${...} 整段（嵌套花括号计数；其内 # 永不算注释）
        let depth = 1
        i += 2
        let q: string | null = null
        for (; i < raw.length; i += 1) {
          const c = raw[i]
          if (q) {
            if (c === '\\') {
              i += 1
              continue
            }
            if (c === q) q = null
            continue
          }
          if (c === "'" || c === '"' || c === '`') {
            q = c
            continue
          }
          if (c === '{') depth += 1
          else if (c === '}') {
            depth -= 1
            if (depth === 0) break
          }
        }
        continue
      }
      continue
    }
    if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = true
      continue
    }
    if (ch === "'" && !inDouble) {
      // YAML 单引号内 '' 是转义引号，跳过一对
      if (inSingle && raw[i + 1] === "'") {
        i += 1
        continue
      }
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      const escaped = i > 0 && raw[i - 1] === '\\'
      if (!escaped) inDouble = !inDouble
      continue
    }
    if (ch === '#' && !inSingle && !inDouble && !inBacktick && i > 0 && /\s/.test(raw[i - 1])) {
      return raw.slice(0, i).trimEnd()
    }
  }
  return raw.trim()
}

/** standing 组合中的一行 MCP（inventory 行 + preset 文本配置的合并）。
 *
 * P1 直读（2026-09-09）：新增可选 `config`，为该行的 dsh-mcp-client 全量挂载
 * 配置（与 McpServerConfig 形状对齐的子集；`!!js`/`${VAR}` 已在解析时求值）。
 * 旧字段语义不变：disabled/running 仍是 inventory 快照。
 */
export interface PresetMcpRow {
  /** inventory 长 id（含 standing 前缀，如 include:agent-presets:mcp-filesystem）。 */
  entryId: string
  /** preset 文件内短 id（如 mcp-filesystem；state.json row 键）。 */
  rowId: string
  serverName: string
  transport: string | null
  toolCallTimeoutMs?: number
  disabled: boolean
  running: boolean
  /** preset 组合文件绝对路径（state.json mcp 段的文件键）。 */
  file: string
  /** 该行的 dsh-mcp-client 全量挂载配置（P1 直读新增；缺省=旧快照行）。 */
  config?: PresetMcpClientConfig
}

/** dsh-mcp-client 行 config 全量子集（与 mcp-convert.ts McpServerConfig 对齐）。 */
export interface PresetMcpClientConfig {
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

/** 由 PresetMcpParsed 组装挂载 config（transport 归一失败/缺失时返回 undefined）。 */
export function presetConfigOf(parsed: PresetMcpParsed): PresetMcpClientConfig | undefined {
  const t = parsed.transport
  const transport = t === 'stdio' || t === 'streamable-http' ? t : undefined
  if (!transport) return undefined
  const config: PresetMcpClientConfig = { serverName: parsed.serverName, transport }
  if (transport === 'stdio') {
    if (parsed.command === undefined) return undefined
    config.command = parsed.command
    if (parsed.args && parsed.args.length > 0) config.args = [...parsed.args]
    if (parsed.env && Object.keys(parsed.env).length > 0) config.env = { ...parsed.env }
    if (parsed.cwd !== undefined) config.cwd = parsed.cwd
  } else {
    if (parsed.url === undefined) return undefined
    config.url = parsed.url
    if (parsed.headers && Object.keys(parsed.headers).length > 0) config.headers = { ...parsed.headers }
  }
  if (parsed.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = parsed.toolCallTimeoutMs
  if (parsed.failOnStartupError !== undefined) config.failOnStartupError = parsed.failOnStartupError
  return config
}

/**
 * 按 serverName 在某 preset 的 standing 行里定位（mcp_call 预设直调用，0.5.6）。
 * serverName 大小写敏感精确匹配（与 serverNameOf/config.serverName 同语义）；
 * preset 文本缺 serverName 键时按 fallbackServerName 回落（与 listPresetMcpRows
 * 同规则，覆盖 mcp-anki→anki-mcp 例外）。若重复取首行（上游保证唯一）。
 */
export async function findPresetRowByServerName(
  ctx: Context,
  presetId: string,
  serverName: string,
): Promise<PresetMcpRow | undefined> {
  const { rows } = await listPresetMcpRows(ctx, presetId)
  return rows.find((r) => r.serverName === serverName)
}

/**
 * 列出某 preset 在 standing 组合中的全部 MCP 行。
 * inventory 给 entryId/enabled/fiberState，preset 文本给 serverName/transport/超时。
 */
export async function listPresetMcpRows(
  ctx: Context,
  presetId: string,
): Promise<{ rows: PresetMcpRow[]; presetPath: string }> {
  const presets = ctx.agentPresets as unknown as {
    compositionInventory(): Promise<unknown>
    resolve(id: string): Promise<unknown>
    read(id: string): Promise<unknown>
  }
  const inventory = (await presets.compositionInventory()) as Array<{
    id?: unknown
    rows?: Array<{ entryId?: unknown; moduleName?: unknown; enabled?: unknown; fiberState?: unknown }>
  }>
  const found = (Array.isArray(inventory) ? inventory : []).find((c) => String(c?.id ?? '') === presetId)
  if (!found) throw new Error(`preset "${presetId}" not in compositionInventory`)
  const resolved = (await presets.resolve(presetId)) as { path?: unknown }
  const presetPath = String(resolved?.path ?? '')
  if (!presetPath) throw new Error(`preset "${presetId}" has no path`)
  const text = String((await presets.read(presetId)) as unknown as string)
  const parsed = parsePresetMcpText(text)
  const rows: PresetMcpRow[] = []
  for (const r of found.rows ?? []) {
    if (String(r?.moduleName ?? '') !== '@deepseek-ai/dsh-mcp-client') continue
    const entryId = String(r?.entryId ?? '')
    if (!entryId) continue
    const rowId = entryId.split(':').pop() ?? entryId
    const info = parsed.get(rowId)
    const serverName = info?.serverName ?? fallbackServerName(rowId)
    // inventory enabled 恒为 boolean（mcp 行 disabled 无 !!js）；缺席/非 false 保守按启用处理
    const disabled = (r as { enabled?: unknown })?.enabled === false
    // fiberState：inventory 只在 fiber 存在时带该键；判 running 用 != null（防 null/0 误判）
    const fiberState = (r as { fiberState?: unknown })?.fiberState
    const running = fiberState !== undefined && fiberState !== null
    // NIT-3：config 不可挂载（undefined）时不留键，避免显式 config: undefined
    const mountConfig = info ? presetConfigOf(info) : undefined
    rows.push({
      entryId,
      rowId,
      serverName,
      transport: info?.transport ?? null,
      toolCallTimeoutMs: info?.toolCallTimeoutMs,
      disabled,
      running,
      file: presetPath,
      ...(mountConfig ? { config: mountConfig } : {}),
    })
  }
  return { rows, presetPath }
}

/**
 * 按长 entryId 反查其所属 preset 行（toggleMcp 预设兜底用）。
 * 逐 preset 找 entryId 命中，找到即 resolve+read+parse 该 preset。
 */
export async function findPresetRowByEntryId(
  ctx: Context,
  entryId: string,
): Promise<{ presetId: string; row: PresetMcpRow; presetPath: string } | undefined> {
  const presets = ctx.agentPresets as unknown as {
    compositionInventory(): Promise<unknown>
    resolve(id: string): Promise<unknown>
    read(id: string): Promise<unknown>
  }
  const inventory = (await presets.compositionInventory()) as Array<{
    id?: unknown
    rows?: Array<{ entryId?: unknown; moduleName?: unknown; enabled?: unknown; fiberState?: unknown }>
  }>
  for (const c of Array.isArray(inventory) ? inventory : []) {
    const pid = String(c?.id ?? '')
    if (!pid) continue
    const hit = (c.rows ?? []).find(
      (r) => String(r?.entryId ?? '') === entryId && String(r?.moduleName ?? '') === '@deepseek-ai/dsh-mcp-client',
    )
    if (!hit) continue
    const resolved = (await presets.resolve(pid)) as { path?: unknown }
    const presetPath = String(resolved?.path ?? '')
    if (!presetPath) continue
    const text = String((await presets.read(pid)) as unknown as string)
    const parsed = parsePresetMcpText(text)
    const rowId = entryId.split(':').pop() ?? entryId
    const info = parsed.get(rowId)
    const serverName = info?.serverName ?? fallbackServerName(rowId)
    const disabled = (hit as { enabled?: unknown })?.enabled === false
    const hitFiber = (hit as { fiberState?: unknown })?.fiberState
    const running = hitFiber !== undefined && hitFiber !== null
    // NIT-3：config 不可挂载（undefined）时不留键
    const mountConfig = info ? presetConfigOf(info) : undefined
    return {
      presetId: pid,
      presetPath,
      row: {
        entryId,
        rowId,
        serverName,
        transport: info?.transport ?? null,
        toolCallTimeoutMs: info?.toolCallTimeoutMs,
        disabled,
        running,
        file: presetPath,
        ...(mountConfig ? { config: mountConfig } : {}),
      },
    }
  }
  return undefined
}
