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
 * - 用户停用的 server（disabled=true）→ 过滤，模型经控制工具按需临时启用调用
 * - AI 临时启用的 server（保活中）→ 仍过滤，保持按需不污染
 *
 * ## 按模型分流（P3b）
 *
 * 两个控制工具（dsh_mcp_search / dsh_mcp_call）**不再随中间层整体挂载/卸载**，
 * 而是每次装配按当前模型路由决定投放与否（`gateFor`）。原因：工具注册表是进程
 * 级的一份，两个不同模型的会话可能并发，挂载/卸载做不到按会话分流。
 *
 * 注意 server 可见性过滤是**无条件**的，不随 gate 变化：AI 临时启用的 server
 * 必须对所有模型隐藏。否则 A 会话的保活启用会让 B 会话（gate 关闭的模型）
 * 凭空多出一批工具、30 秒后又消失 —— 与中间层无关的会话被反复打断前缀缓存。
 *
 * ## 隐藏范围
 *
 * `hideAll` 为真时，命中中间层的模型看不到**任何** mcp__ 工具（哪怕该 server
 * 在面板里是启用状态），一律经控制工具按需取用；gate 关闭的模型不受影响，
 * 照常直连。server 本身保持挂载运行 —— 用停用 server 来省上下文会连带把它对
 * 所有模型藏起来，而这里只改「这一次装配对这个模型」的可见性。
 *
 * tools registry 不受影响，`tools.execute` 照常可对任意 `mcp__*` 调用。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
/** 一次装配的中间层判定：是否生效 + 是否隐藏全部 MCP server。 */
export interface AssemblyGate {
    on: boolean;
    hideAll: boolean;
}
export declare function installMcpVisibilityFilter(ctx: Context, buildVisibility: () => ReadonlyMap<string, boolean>, gateFor: (agent: Agent | undefined) => AssemblyGate): () => void;
