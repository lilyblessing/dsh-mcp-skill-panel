/**
 * 私有 MCP catalog —— 采集 / 检索 / 持久化（P1）。
 *
 * 纯逻辑模块：不依赖 Cordis 运行时（仅类型），持久化函数显式接收目录，
 * 这样既能在插件 apply 里对 ~/.dsh/dsh-mcp-skill-panel 使用，也能被
 * scripts/selftest-mcp.mjs 用临时目录做往返自测。
 *
 * 数据形状：
 *   Catalog = { [serverName]: { tools: CatalogEntry[], fetchedAt, source } }
 *   CatalogEntry.name 是完整工具 id（mcp__<server>__<tool>），description 一句话，
 *   parameters 是 JSON Schema 参数对象。
 */

/** 单个工具的目录条目（完整 id + 描述 + 参数 schema）。 */
export interface CatalogEntry {
  name: string
  description: string
  parameters: unknown
}

/** 一个 MCP server 的快照。 */
export interface CatalogServer {
  tools: CatalogEntry[]
  fetchedAt: number
  source: 'live' | 'cached'
}

/** 私有 catalog：按 serverName 索引。 */
export type Catalog = Record<string /* serverName */, CatalogServer>

/** 检索命中：server + 工具。 */
export interface SearchHit {
  server: string
  tool: CatalogEntry
}

/** 从完整 tool name 解析 server 段（与 src/index.ts serverOf 一致）。 */
export function serverOfMcp(name: string): string | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const at = rest.indexOf('__')
  if (at < 0) return null
  return rest.slice(0, at)
}

/**
 * 从 tools.schemas(scope) 的结果里，按 `mcp__<serverName>__` 前缀抽取该 server
 * 的全部工具条目。name 是完整工具 id；参数取原样 JSON Schema。
 */
export function snapshotFromSchemas(
  schemas: ReadonlyArray<{ name?: unknown; description?: unknown; parameters?: unknown }>,
  serverName: string,
): CatalogEntry[] {
  const prefix = `mcp__${serverName}__`
  const out: CatalogEntry[] = []
  for (const schema of schemas) {
    const name = String(schema?.name ?? '')
    if (!name.startsWith(prefix)) continue
    out.push({
      name,
      description: String(schema?.description ?? ''),
      parameters: schema?.parameters ?? {},
    })
  }
  // 稳定排序，便于 diff 与展示
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 按空白 / 下划线 / 连字符切分小写化。 */
function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
}

/** 从工具参数 JSON Schema 提取参数名集合（properties 键）。 */
function paramNamesOf(parameters: unknown): Set<string> {
  const names = new Set<string>()
  if (parameters && typeof parameters === 'object') {
    const props = (parameters as Record<string, unknown>).properties
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props)) names.add(key.toLowerCase())
    }
  }
  return names
}

/**
 * 关键词全文检索 top-K。
 * 打分：工具名命中 3 / 工具名前缀 2 / 描述命中 2 / 描述前缀 1 / 参数名 1。
 * 返回按分数降序（同分按 server、name 字典序稳定）的命中数组。
 */
export function searchCatalog(catalog: Catalog, query: string, limit = 5): SearchHit[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const scored: Array<{ hit: SearchHit; score: number }> = []
  for (const [server, serverInfo] of Object.entries(catalog)) {
    for (const tool of serverInfo.tools) {
      const nameTokens = tokenize(tool.name)
      const descTokens = tokenize(tool.description)
      const paramTokens = paramNamesOf(tool.parameters)
      let score = 0
      for (const token of tokens) {
        if (nameTokens.includes(token)) score += 3
        else if (nameTokens.some((t) => t.startsWith(token))) score += 2
        if (descTokens.includes(token)) score += 2
        else if (descTokens.some((t) => t.startsWith(token))) score += 1
        if (paramTokens.has(token)) score += 1
      }
      if (score > 0) scored.push({ hit: { server, tool }, score })
    }
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.hit.server.localeCompare(b.hit.server) ||
      a.hit.tool.name.localeCompare(b.hit.tool.name),
  )
  const k = Math.max(1, Math.floor(Number(limit) || 1))
  return scored.slice(0, k).map((s) => s.hit)
}

/**
 * 列出某 server 的全部工具（精简：name + description）。
 * 返回 undefined 表示该 server 不在 catalog 中。
 */
export function listServer(catalog: Catalog, server: string): Array<{ name: string; description: string }> | undefined {
  const serverInfo = catalog[server]
  if (!serverInfo) return undefined
  return serverInfo.tools.map((tool) => ({ name: tool.name, description: tool.description }))
}

/** catalog 文件路径：<dir>/catalog.json。 */
export function catalogFileFor(dir: string): string {
  return `${dir.replace(/[\\/]$/, '')}/catalog.json`
}

/** 从目录加载 catalog；文件不存在 / 解析失败时返回空 catalog。 */
export async function loadCatalog(dir: string): Promise<Catalog> {
  try {
    const text = await import('node:fs/promises').then((fsp) => fsp.readFile(catalogFileFor(dir), 'utf8'))
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Catalog
    return {}
  } catch {
    return {}
  }
}

/** 原子写回 catalog（tmp + rename，0600）。调用方负责 mkdir。 */
export async function saveCatalog(dir: string, catalog: Catalog): Promise<void> {
  const fsp = await import('node:fs/promises')
  await fsp.mkdir(dir, { recursive: true })
  const file = catalogFileFor(dir)
  const json = JSON.stringify(catalog, null, 2)
  await fsp.writeFile(`${file}.tmp`, json, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(`${file}.tmp`, file)
}
