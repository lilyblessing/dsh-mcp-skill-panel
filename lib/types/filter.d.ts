/**
 * 装配过滤 —— 模型侧核心（P2-1，v0.4.2 按 server 状态过滤，v0.4.3 回合内缓存）。
 *
 * 注册 `system-prompt/assemble` Waterfall：把装配好的 tools 里「对模型不可见」
 * 的 MCP 工具过滤掉。可见性由调用方提供的 `buildVisibility()` 判定：
 *
 * - 每回合只构建一次 server → 可见性 Map（一次 loader 遍历），后续按工具名 O(1)
 *   查表 —— 避免对每个 mcp__ 工具重复遍历 loader entries（56 工具 × 10 entries）。
 * - 用户打开的 server（disabled=false 且非 AI 临时启用）→ 工具进上下文
 *   （用户启停 = 上下文占用 + 模型可见性开关；memory 高灵敏召回）
 * - 用户停用的 server（disabled=true）→ 过滤，模型经 mcp_search/mcp_call
 *   按需临时启用调用（中间层）
 * - AI 临时启用的 server（mcp_call 保活中）→ 仍过滤，保持按需不污染
 *
 * tools registry 不受影响，`tools.execute` 照常可对任意 `mcp__*` 调用。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare function installMcpVisibilityFilter(ctx: Context, buildVisibility: () => ReadonlyMap<string, boolean>): () => void;
