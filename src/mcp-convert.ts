/**
 * mcpServers JSON → dsh-mcp-client 行 的纯转换模块。
 *
 * 用户从其它 harness（Claude Code / Codex / Roo 等）复制的 `.mcp.json` 是
 * `{ "mcpServers": { <name>: { command|url, args, env, cwd, headers } } }` JSON
 * 形态。本模块把它解析并转换为 `@deepseek-ai/dsh-mcp-client` 插件行：
 * - transport 推断：显式 `type`/`transport` 优先（"http"/"sse" 归一 streamable-http），
 *   否则有 `command` → stdio、有 `url` → streamable-http；
 * - serverName 校验：dsh-mcp-client 要求 `[A-Za-z0-9_-]{1,32}`；
 * - `${VAR}` 环境变量占位：全局 YAML 形态 → `!!js` 模板表达式（loader 加载时求值），
 *   运行时挂载形态 → 挂载时解析 `process.env`（缺失保留占位符，让远端报可见错误）。
 *
 * 纯逻辑、零依赖（仅类型），可被 scripts/selftest 用构建产物直接覆盖。
 */

/** 单个 MCP server 的规范化配置（与 dsh-mcp-client 的 config 形状对齐）。 */
export interface McpServerConfig {
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

/** serverName → 配置（JSON 键即 serverName）。 */
export type McpServers = Record<string, McpServerConfig>

/** dsh-mcp-client 插件行（loader entry 形状）。 */
export interface McpRowConfig {
  id: string
  name: string
  config: Record<string, unknown>
}

/** 解析结果：合法 server + 逐条错误 + 非致命警告（如非字符串值被强制转换）。 */
export interface ParseResult {
  servers: McpServers
  errors: string[]
  warnings: string[]
}

/** dsh-mcp-client 的 serverName 约束（存活实例全局唯一 + 命名长度）。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** `${VAR}` 环境变量占位（VAR 为 JS 标识符）。 */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
/** dsh-mcp-client 的插件包名。 */
export const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 字符串数组：number/boolean 项强制转字符串（同行 harness 常见，如 args: [3000]），
 * 其余非标量项跳过并记警告——不再静默清空整个数组。
 */
function strArray(value: unknown, warnings: string[], label: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
    else if (typeof item === 'number' || typeof item === 'boolean') {
      out.push(String(item))
      warnings.push(`${label}: ${typeof item} 项已转为字符串 "${String(item)}"`)
    } else {
      warnings.push(`${label}: 忽略非标量项（${Array.isArray(item) ? 'array' : typeof item}）`)
    }
  }
  return out
}

/**
 * 字符串字典：number/boolean 值强制转字符串（如 env: { PORT: 3000 }），
 * 其余非标量值跳过并记警告——不再静默清空整个字段。
 */
function strDict(value: unknown, warnings: string[], label: string): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') {
      out[key] = String(item)
      warnings.push(`${label}.${key}: ${typeof item} 值已转为字符串 "${String(item)}"`)
    } else {
      warnings.push(`${label}.${key}: 忽略非标量值（${Array.isArray(item) ? 'array' : typeof item}）`)
    }
  }
  return out
}

/** 解析单个 server 配置；失败返回错误文案。 */
function parseServer(name: string, value: unknown, warnings: string[]): McpServerConfig | { error: string } {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return { error: `server "${name}": serverName 需匹配 [A-Za-z0-9_-]{1,32}` }
  }
  if (!isPlainObject(value)) {
    return { error: `server "${name}": 配置需为对象` }
  }
  const cfg = value as Record<string, unknown>
  const explicit = String(cfg.type ?? cfg.transport ?? '').toLowerCase()
  const command = str(cfg.command)
  const url = str(cfg.url)
  let transport: McpServerConfig['transport'] | undefined
  if (explicit === 'stdio' || explicit === 'command') transport = 'stdio'
  else if (explicit === 'streamable-http' || explicit === 'http' || explicit === 'sse') transport = 'streamable-http'
  else if (command !== undefined) transport = 'stdio'
  else if (url !== undefined) transport = 'streamable-http'

  if (transport === undefined) {
    return { error: `server "${name}": 无法推断传输方式（需要 command=stdio 或 url=http）` }
  }
  const toolCallTimeoutMs = typeof cfg.toolCallTimeoutMs === 'number' && Number.isFinite(cfg.toolCallTimeoutMs) ? cfg.toolCallTimeoutMs : undefined
  if (transport === 'stdio') {
    if (command === undefined) return { error: `server "${name}": stdio 需要 command` }
    const label = `server "${name}"`
    return {
      serverName: name,
      transport,
      command,
      args: strArray(cfg.args, warnings, `${label}.args`) ?? [],
      env: strDict(cfg.env, warnings, `${label}.env`) ?? {},
      cwd: str(cfg.cwd),
      toolCallTimeoutMs,
    }
  }
  if (url === undefined) return { error: `server "${name}": http 需要 url` }
  return {
    serverName: name,
    transport,
    url,
    headers: strDict(cfg.headers, warnings, `server "${name}".headers`) ?? {},
    toolCallTimeoutMs,
  }
}

/**
 * 解析 mcpServers JSON 文本。
 * 同时接受 `{ "mcpServers": {...} }` 与直接 `{ <name>: {...} }` 两种形态。
 */
export function parseMcpServersJson(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { servers: {}, errors: [`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`], warnings: [] }
  }
  if (!isPlainObject(raw)) {
    return { servers: {}, errors: ['期望 JSON 对象（mcpServers 映射）'], warnings: [] }
  }
  const map = isPlainObject(raw.mcpServers) ? raw.mcpServers : (raw as Record<string, unknown>)
  const servers: McpServers = {}
  const errors: string[] = []
  const warnings: string[] = []
  for (const [name, value] of Object.entries(map)) {
    const parsed = parseServer(name, value, warnings)
    if ('error' in parsed) {
      errors.push(parsed.error)
      continue
    }
    servers[name] = parsed
  }
  return { servers, errors, warnings }
}

/** 字符串是否含 `${VAR}` 环境变量占位。 */
export function hasEnvRef(value: string): boolean {
  ENV_REF.lastIndex = 0
  return ENV_REF.test(value)
}

/** 把含 `${VAR}` 的字符串转成 JS 模板字面量文本（`!!js` 表达式体）。 */
export function toJsTemplate(value: string): string {
  // ' 转义为 \'：外层 yamlScalar 用 YAML 单引号标量包装（'' 翻倍），
  // YAML 解析后 JS 收到 \'（合法转义）→ 求值还原为 '，避免多出引号字符。
  const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/'/g, "\\'")
  const withEnv = escaped.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '${process.env.$1}')
  return `\`${withEnv}\``
}

/** 运行时解析 `${VAR}` → process.env 值；缺失的保留占位符原样（远端报可见错误）。 */
export function resolveEnvRefs(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const env = process.env[name]
    return env !== undefined ? env : `\${${name}}`
  })
}

/** 递归解析对象内所有字符串值的 ${VAR}（挂载时调用）。 */
export function resolveServersEnv(servers: McpServers): McpServers {
  const out: McpServers = {}
  for (const [name, server] of Object.entries(servers)) {
    const copy: McpServerConfig = { ...server }
    if (copy.command !== undefined) copy.command = resolveEnvRefs(copy.command)
    if (copy.cwd !== undefined) copy.cwd = resolveEnvRefs(copy.cwd)
    if (copy.url !== undefined) copy.url = resolveEnvRefs(copy.url)
    if (copy.env) {
      const env: Record<string, string> = {}
      for (const [key, item] of Object.entries(copy.env)) env[key] = resolveEnvRefs(item)
      copy.env = env
    }
    if (copy.headers) {
      const headers: Record<string, string> = {}
      for (const [key, item] of Object.entries(copy.headers)) headers[key] = resolveEnvRefs(item)
      copy.headers = headers
    }
    if (copy.args) copy.args = copy.args.map((item) => resolveEnvRefs(item))
    out[name] = copy
  }
  return out
}

/** 把 McpServers 转成 dsh-mcp-client 插件行（loader entry 形状）。 */
export function serversToRows(servers: McpServers, idPrefix = 'mcp'): McpRowConfig[] {
  const rows: McpRowConfig[] = []
  for (const server of Object.values(servers)) {
    const config: Record<string, unknown> = { transport: server.transport, serverName: server.serverName }
    if (server.transport === 'stdio') {
      config.command = server.command
      if (server.args && server.args.length > 0) config.args = server.args
      if (server.env && Object.keys(server.env).length > 0) config.env = server.env
      if (server.cwd) config.cwd = server.cwd
    } else {
      config.url = server.url
      if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers
    }
    if (server.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = server.toolCallTimeoutMs
    rows.push({ id: `${idPrefix}-${server.serverName}`, name: MCP_CLIENT_NAME, config })
  }
  return rows
}

/** JSON 双引号字符串是合法 YAML 标量（内嵌转义由 JSON.stringify 处理）。 */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/** 单个字符串值 → YAML 标量：含 ${VAR} → `!!js` 模板表达式；否则 JSON 字符串。 */
function yamlScalar(value: string): string {
  if (!hasEnvRef(value)) return yamlString(value)
  const template = toJsTemplate(value)
  return `!!js '${template.replace(/'/g, "''")}'`
}

/** 迷你 YAML 序列化：对象/数组/字符串/数字/布尔（配置结构简单，无需完整 YAML 库）。 */
function emitYaml(obj: Record<string, unknown>, indent: string): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    if (isPlainObject(value)) {
      out.push(`${indent}${key}:`)
      out.push(...emitYaml(value, `${indent}  `))
    } else if (Array.isArray(value)) {
      out.push(`${indent}${key}:`)
      for (const item of value) out.push(`${indent}  - ${yamlScalar(String(item))}`)
    } else if (typeof value === 'string') {
      out.push(`${indent}${key}: ${yamlScalar(value)}`)
    } else {
      out.push(`${indent}${key}: ${String(value)}`)
    }
  }
  return out
}

/** 生成全局 profile 可追加的 `- insert:` patch 块（dsh-mcp-client 行，!!js 环境插值）。 */
export function serversToPatchYaml(servers: McpServers): string {
  const lines: string[] = []
  for (const row of serversToRows(servers)) {
    lines.push('- insert:')
    lines.push(`    - id: ${row.id}`)
    lines.push(`      name: '${row.name.replace(/'/g, "''")}'`)
    lines.push('      config:')
    lines.push(...emitYaml(row.config, '        '))
  }
  return lines.join('\n') + '\n'
}
