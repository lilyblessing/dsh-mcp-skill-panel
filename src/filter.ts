/**
 * 装配过滤 —— 模型侧核心（P2-1，v0.4.2 改为按 server 状态过滤）。
 *
 * 注册 `system-prompt/assemble` Waterfall：把装配好的 tools 里「对模型不可见」
 * 的 MCP 工具过滤掉。可见性由调用方提供的 `isMcpVisible(serverName)` 判定：
 *
 * - 用户打开的 server（disabled=false 且非 AI 临时启用）→ 工具进上下文
 *   （用户启停 = 上下文占用 + 模型可见性开关；memory 高灵敏召回）
 * - 用户停用的 server（disabled=true）→ 过滤，模型经 mcp_search/mcp_call
 *   按需临时启用调用（中间层）
 * - AI 临时启用的 server（mcp_call 保活中）→ 仍过滤，保持按需不污染
 *
 * tools registry 不受影响，`tools.execute` 照常可对任意 `mcp__*` 调用。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

const MCP_TOOL_PREFIX = 'mcp__'

/** 从完整 tool name 解析 server 段（与 catalog.serverOfMcp 一致，保持本模块零依赖）。 */
function serverOfMcp(name: string): string | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const at = rest.indexOf('__')
  if (at < 0) return null
  return rest.slice(0, at)
}

export function installMcpVisibilityFilter(
  ctx: Context,
  isMcpVisible: (serverName: string) => boolean,
): () => void {
  return ctx.effect(() => {
    const off = ctx.root.on(
      'system-prompt/assemble',
      (
        assembly: PromptAssembly,
        _context: unknown,
        next: () => Promise<PromptAssembly>,
      ): Promise<PromptAssembly> => {
        if (assembly && Array.isArray(assembly.tools)) {
          assembly.tools = assembly.tools.filter((tool) => {
            const name = String(tool.name ?? '')
            if (!name.startsWith(MCP_TOOL_PREFIX)) return true
            const server = serverOfMcp(name)
            // 畸形工具名（解析不出 server）保守保留，不误伤
            return server === null ? true : isMcpVisible(server)
          })
        }
        return next()
      },
    )
    return off
  }, 'mcp-skill-panel: mcp visibility filter')
}
