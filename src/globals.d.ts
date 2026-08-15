/**
 * 触发各官方包的 Context 类型增强（declare module '@deepseek-ai/cordis'），
 * 使 ctx.tools / ctx.skills / ctx.agents / ctx.loader / ctx.agentPresets /
 * ctx.webServer / ctx.sessions 获得精确类型。仅类型导入，无运行时依赖。
 */
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
