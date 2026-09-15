/**
 * 当前会话的模型路由解析（provider/model）—— AI 中间层按模型分流的基础。
 *
 * ## 为什么需要自己解析
 *
 * `system-prompt/assemble` 的 AssembleContext 带 `agent`，但**不带模型**：
 * `dsh-agent` 的 installModelSelection 是在 `await next()` **之后**才把
 * provider/model 写进 `assembly.variables`（见闭包 dsh-agent/lib/index.js），
 * 装配过滤跑在 next() 之前，那时变量还不存在。
 *
 * 所以这里复刻 `dsh-api-session-controller` 决定「下一个请求用哪个模型」的
 * 同一套优先级（闭包 dsh-api-session-controller/lib/index.js 的 selectionFor）：
 *
 *   1. modelSelection 投影的 `pending` —— 用户刚切了模型、还没发出请求
 *   2. `session.requestHeader()!.config` —— 最近一次已落盘的请求头
 *   3. `agentDefaultModel.currentSelection()` —— 部署默认
 *
 * 有第 1 步才没有 off-by-one：切模型后**紧接着那一轮**装配就按新模型判定，
 * 而不是等下一轮。全链路同步（零 IO），可以直接在装配过滤里调用。
 *
 * ## 服务可选性
 *
 * `sessionProjections` / `agentDefaultModel` 都不是本插件 inject 的硬依赖 ——
 * 缺失的部署（无 host / 精简组合）必须照常工作，只是降级到第 2、3 步。
 * 因此用 ctx.inject 的可选作用域把引用捞进 holder，并对 Context 做结构化断言
 * （闭包类型未列入 devDependencies，与 client 半区同样走「最小契约」路线）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 一条模型路由：注册的 provider 路由 + 该 provider 自有的 model id。 */
export interface ModelRoute {
  provider: string
  model: string
}

/** modelSelection 投影状态的最小契约（闭包 dsh-api-session-controller 注册）。 */
interface ModelSelectionState {
  lastUsed: { provider?: unknown; model?: unknown } | null
  pending: { provider?: unknown; model?: unknown } | null
}

/** sessionProjections 服务的最小契约（只用 stateOf）。 */
interface ProjectionsLike {
  stateOf(session: unknown, key: string): unknown
}

/** agentDefaultModel 服务的最小契约（只用 currentSelection）。 */
interface DefaultModelLike {
  currentSelection(): { provider?: unknown; model?: unknown }
}

/** llm 服务的最小契约（面板的 provider/模型目录用）。 */
interface LlmLike {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>
}

/** 装配过滤同步读取的服务引用（ctx.inject 可选作用域维护）。 */
export interface RouteServices {
  projections?: ProjectionsLike
  defaultModel?: DefaultModelLike
  /** 面板 /models 端点用；cordis 对未 inject 的服务属性会抛错，必须经 inject 捕获。 */
  llm?: LlmLike
}

/**
 * 挂载可选服务捕获：服务在时填 holder，随作用域卸载时清空。
 * @returns holder —— 装配过滤同步读；服务缺失时字段为 undefined。
 */
export function installRouteServices(ctx: Context): RouteServices {
  const holder: RouteServices = {}
  ctx.inject(['sessionProjections'], (scoped) => {
    holder.projections = (scoped as unknown as { sessionProjections?: ProjectionsLike }).sessionProjections
    return () => {
      holder.projections = undefined
    }
  })
  ctx.inject(['agentDefaultModel'], (scoped) => {
    holder.defaultModel = (scoped as unknown as { agentDefaultModel?: DefaultModelLike }).agentDefaultModel
    return () => {
      holder.defaultModel = undefined
    }
  })
  ctx.inject(['llm'], (scoped) => {
    holder.llm = (scoped as unknown as { llm?: LlmLike }).llm
    return () => {
      holder.llm = undefined
    }
  })
  return holder
}

/** 两个字段都是非空字符串才算一条可用路由。 */
function asRoute(value: { provider?: unknown; model?: unknown } | null | undefined): ModelRoute | undefined {
  if (!value) return undefined
  const provider = value.provider
  const model = value.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * 解析该 agent 下一个请求会用的模型路由。
 * 三级回退与 dsh-api-session-controller 一致；每步都对异常兜底
 * （装配过滤是热路径，任何抛出都会打断整轮提示词装配）。
 * @param services - 可选服务 holder（{@link installRouteServices} 产出）。
 * @param agent - 本次装配所属 agent；缺省（诊断装配）返回 undefined。
 * @returns 解析到的路由，或全部落空时 undefined。
 */
export function resolveRoute(services: RouteServices, agent: Agent | undefined): ModelRoute | undefined {
  if (!agent) return undefined
  // 1) 用户已选、尚未发出请求的模型
  try {
    const state = services.projections?.stateOf(agent.session, 'modelSelection') as ModelSelectionState | undefined
    const pending = asRoute(state?.pending)
    if (pending) return pending
  } catch {
    // 投影未注册/键不匹配：继续回退
  }
  // 2) 最近一次已落盘的请求头
  try {
    const header = agent.session.requestHeader()
    const logged = asRoute(header?.config as { provider?: unknown; model?: unknown } | undefined)
    if (logged) return logged
  } catch {
    // 会话尚无请求头：继续回退
  }
  // 3) 部署默认
  try {
    return asRoute(services.defaultModel?.currentSelection())
  } catch {
    return undefined
  }
}

/** 一条路由的精确键（provider/model）——按模型的覆盖项用它。 */
export function routeKey(route: ModelRoute): string {
  return `${route.provider}/${route.model}`
}

/** 中间层判定结果：是否生效 + 依据哪条规则（面板展示 + 诊断）。 */
export interface RouteDecision {
  on: boolean
  /** 'model' = provider/model 精确项；'provider' = provider 项；'master' = 总开关；'no-route' = 未解析出模型。 */
  source: 'model' | 'provider' | 'master' | 'no-route'
  route: ModelRoute | undefined
}

/**
 * 按路由决定 AI 中间层是否对本次装配生效。
 *
 * 查表顺序 `provider/model` → `provider` → 总开关；没有任何覆盖项时
 * 等价于旧行为（纯总开关），所以升级零配置零行为变化。
 * 未解析出路由时保守走总开关 —— 宁可维持既有行为，也不静默改变工具集。
 * @param route - {@link resolveRoute} 的结果。
 * @param master - 面板总开关（state.json 的 config.autoManage）。
 * @param byRoute - 覆盖表（键为 provider 或 provider/model）。
 * @returns 生效与否及其依据。
 */
export function routeDecision(
  route: ModelRoute | undefined,
  master: boolean,
  byRoute: Readonly<Record<string, boolean>> | undefined,
): RouteDecision {
  if (!route) return { on: master, source: 'no-route', route: undefined }
  if (byRoute) {
    const exact = byRoute[routeKey(route)]
    if (typeof exact === 'boolean') return { on: exact, source: 'model', route }
    const byProvider = byRoute[route.provider]
    if (typeof byProvider === 'boolean') return { on: byProvider, source: 'provider', route }
  }
  return { on: master, source: 'master', route }
}
