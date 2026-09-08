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

/** preset 文件文本解析出的单行 MCP 配置（key = 短 rowId，如 mcp-filesystem）。 */
export interface PresetMcpParsed {
  serverName: string
  transport: string | null
  toolCallTimeoutMs?: number
}

/** 短 rowId 回落 serverName（preset 文本缺 serverName 键时用；覆盖已知例外）。 */
function fallbackServerName(rowId: string): string {
  if (rowId === 'mcp-anki') return 'anki-mcp'
  return rowId.replace(/^mcp-/, '')
}

/**
 * 解析 preset 组合文本，抽取全部 `mcp-*` 行的 serverName/transport/超时。
 * 纯文本正则（preset 文件结构稳定）：按 `^- id:` 切块，块内抓三个键。
 * 键锚定行首（防注释/长键误命中）；值允许可选双引号（YAML `"stdio"` 形态）。
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
    const sn = /^\s*serverName:\s*"?([A-Za-z0-9_-]+)"?\s*(?:#.*)?$/m.exec(block)
    const tr = /^\s*transport:\s*"?(\S+?)"?\s*(?:#.*)?$/m.exec(block)
    const tm = /^\s*toolCallTimeoutMs:\s*"?(\d+)"?\s*(?:#.*)?$/m.exec(block)
    const parsed: PresetMcpParsed = {
      serverName: sn ? sn[1] : fallbackServerName(rowId),
      transport: tr ? tr[1] : null,
    }
    if (tm) {
      const n = Number(tm[1])
      if (Number.isFinite(n) && n > 0) parsed.toolCallTimeoutMs = n
    }
    out.set(rowId, parsed)
  }
  return out
}

/** standing 组合中的一行 MCP（inventory 行 + preset 文本配置的合并）。 */
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
    rows.push({
      entryId,
      rowId,
      serverName,
      transport: info?.transport ?? null,
      toolCallTimeoutMs: info?.toolCallTimeoutMs,
      disabled,
      running,
      file: presetPath,
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
      },
    }
  }
  return undefined
}
