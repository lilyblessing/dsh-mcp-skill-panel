/**
 * 触发各官方包的 Context 类型增强（declare module '@deepseek-ai/cordis'），
 * 使 ctx.tools / ctx.skills / ctx.agents / ctx.loader / ctx.agentPresets /
 * ctx.webServer / ctx.sessions 获得精确类型。仅类型导入，无运行时依赖。
 *
 * ctx.agentPresets 的类型由 `@deepseek-ai/dsh-agent-preset-registry` 提供
 * （该包声明同一服务名 `agentPresets`；0.1.7 起旧的复数包已不存在）。
 */
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/cordis-plugin-timer'
