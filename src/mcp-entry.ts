/**
 * MCP loader entry 判定与 serverName 提取（DRY 收敛）。
 *
 * 「某行是不是 MCP 行 + 它的 serverName 是什么」在 collectMcp / snapshotEnabled /
 * findMcpEntry / buildVisibility / toggleMcp 中重复 4+ 次，统一收敛到本模块。
 * 纯逻辑、零依赖（仅类型），可被 selftest 覆盖。
 */
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

/** dsh-mcp-client 行的 config 形状（只取本插件关心的字段）。 */
export interface McpEntryConfig {
  serverName?: unknown
  transport?: unknown
  toolCallTimeoutMs?: unknown
}

/** 判定 loader entry 是否为 MCP 行（dsh-mcp-client 或带 serverName 配置的行）。 */
export function isMcpEntry(entry: Entry): boolean {
  if (entry.options.group) return false
  const cfg = entry.options.config
  return (
    entry.options.name === '@deepseek-ai/dsh-mcp-client' ||
    (cfg !== null && typeof cfg === 'object' && 'serverName' in (cfg as object))
  )
}

/** 取 MCP 行的 serverName（config.serverName 缺省回落 entry id）。 */
export function serverNameOf(entry: Entry): string {
  const cfg = entry.options.config as McpEntryConfig | null | undefined
  return String(cfg?.serverName ?? entry.options.id)
}

/** 取 MCP 行的 config（供 transport / toolCallTimeoutMs 读取）。 */
export function mcpEntryConfig(entry: Entry): McpEntryConfig | null {
  const cfg = entry.options.config
  return cfg !== null && typeof cfg === 'object' ? (cfg as McpEntryConfig) : null
}
