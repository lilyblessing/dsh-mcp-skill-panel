/**
 * 装配过滤 —— 模型侧核心（P2-1）。
 *
 * 注册 `system-prompt/assemble` Waterfall：把装配好的 tools 里所有以 `mcp__`
 * 开头的工具过滤掉，让模型永远不会直接看到 MCP 工具 schema（零长尾污染）。
 * tools registry 不受影响，`tools.execute` 照常可对 `mcp__*` 调用。
 *
 * 影响范围：autoManage 模式下所有 MCP 工具对模型不可见（含用户手动启用的）——
 * 统一入口（mcp_search / mcp_call）的设计意图。
 *
 * 该事件在 root ctx 上 emit，root 监听不随 fiber 自动清理，因此用 ctx.effect
 * 包裹返回 disposer；返回的 disposer 即卸载时解除监听。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

const MCP_TOOL_PREFIX = 'mcp__'

export function installMcpVisibilityFilter(ctx: Context): () => void {
  return ctx.effect(() => {
    const off = ctx.root.on(
      'system-prompt/assemble',
      (
        assembly: PromptAssembly,
        _context: unknown,
        next: () => Promise<PromptAssembly>,
      ): Promise<PromptAssembly> => {
        if (assembly && Array.isArray(assembly.tools)) {
          assembly.tools = assembly.tools.filter((tool) => !String(tool.name ?? '').startsWith(MCP_TOOL_PREFIX))
        }
        return next()
      },
    )
    return off
  }, 'mcp-skill-panel: mcp visibility filter')
}
