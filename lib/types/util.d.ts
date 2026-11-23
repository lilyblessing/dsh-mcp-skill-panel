/** 通用小工具（index / collect / routes 共用）。 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
/** 把未知错误投影为可读字符串（日志与 HTTP 错误响应）。 */
export declare function messageOf(error: unknown): string;
/**
 * 取根上下文。
 *
 * cordis 4.2 移除了 `ctx.root` 这个普通属性：插件 fiber 内直接读会落进 service 代理的
 * 注入校验并抛 `cannot get property "root" without inject`（root 不是可注入服务，
 * 声明 inject: ['root'] 也修不了），必须走 Symbol。
 * 旧版（<= 4.0.x）没有该 Symbol，回退读 `ctx.root`；两代都拿不到时退回自身 ctx。
 */
export declare function rootContext(ctx: Context): Context;
/**
 * 取「根 agent」列表。
 *
 * DSH 0.2.3-alpha.2 起 `AgentRegistry.roots()` 被移除（dsh-agent 类型里全文已无 roots，
 * 只剩 `get(id)` 与 `list()`），而面板多处需要"根会话 agent"。
 * 旧版走 `roots()`；新版回退 `list()`。两代都失败时返回空数组（调用方本就有空值分支）。
 */
export declare function agentRoots(ctx: Context): readonly Agent[];
