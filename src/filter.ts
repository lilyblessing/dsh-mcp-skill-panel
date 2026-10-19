/**
 * 装配过滤 + PTC 数据层遮蔽 + 直调守卫（P2-1 → 0.2.1-rc.2 PTC 扩展）。
 *
 * ## 1. native 路径：system-prompt/assemble 过滤（既有）
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
 * ### 按模型分流（P3b）
 *
 * 两个控制工具（dsh_mcp_search / dsh_mcp_call）**不再随中间层整体挂载/卸载**，
 * 而是每次装配按当前模型路由决定投放与否（`gateFor`）。原因：工具注册表是进程
 * 级的一份，两个不同模型的会话可能并发，挂载/卸载做不到按会话分流。
 *
 * 注意 server 可见性过滤是**无条件**的，不随 gate 变化：AI 临时启用的 server
 * 必须对所有模型隐藏。否则 A 会话的保活启用会让 B 会话（gate 关闭的模型）
 * 凭空多出一批工具、30 秒后又消失 —— 与中间层无关的会话被反复打断前缀缓存。
 *
 * ### 隐藏范围
 *
 * `hideAll` 为真时，命中中间层的模型看不到**任何** mcp__ 工具（哪怕该 server
 * 在面板里是启用状态），一律经控制工具按需取用；gate 关闭的模型不受影响，
 * 照常直连。server 本身保持挂载运行 —— 用停用 server 来省上下文会连带把它对
 * 所有模型藏起来，而这里只改「这一次装配对这个模型」的可见性。
 *
 * ## 2. PTC 路径（0.2.1-rc.2 mode:ptc 新增）
 *
 * PTC 下全部 MCP 工具 schema 经 `ToolRuntime.sdkSchemas(scope)` 进入
 * `tools:sdk` 提示词段，不走 `assembly.tools`，上面的装配过滤完全够不着。
 * 两条补丁（同一 `ctx.effect` 内安装，dispose 一并还原）：
 *
 * ### T1 数据层遮蔽 sdkSchemas
 *
 * 在 `ctx.tools` 实例上挂**自有属性**包装函数遮蔽原型方法：先调原方法拿全量
 * 投影，再按 server 可见性过滤掉被隐藏的 `mcp__*` 条目。运行时（0.2.1-rc.2）
 * `sdkSchemas` 是原型方法（dsh-tools lib :3123，仅定义 + sdkSection 一处调用），
 * 实例自有属性遮蔽后只影响提示词渲染，`schemas()`（bindings 投影）与执行面
 * 完全不变 —— 这正是「降占用但保留可调用性」，执行边界由 T2 守卫补上。
 *
 * - **幂等**：模块级 Symbol 作实例自有标记；已带标记 ⇒ 跳过再包装（不叠加），
 *   本次 install 的 dispose 对遮蔽部分为 no-op（遮蔽归首次 install 所有）。
 * - **可还原**：dispose 删除自有属性（原型方法自然恢复）；若 install 时实例
 *   已有他人挂的自有 `sdkSchemas`，则按安装时捕获的属性描述符原样写回。
 * - **已知简化**：遮蔽过滤**忽略 scope / gate 按模型分流**，server 可见性维度
 *   仍是 server 级粒度（`buildVisibility()` 无参，按回合构建）；`hideAll='all'`
 *   是全局配置（与 agent 无关），故在 PTC SDK 段**全局生效**：剔除全部 `mcp__*`
 *   条目，只留 `dsh_mcp_search` / `dsh_mcp_call` 等非前缀条目；`'disabled'` 档
 *   维持 server 级可见性过滤。native 路径的 `assembly.tools` 过滤不受影响，仍按
 *   模型分流。理由：hideAll 直接应用，无需 scope→agent 反查（scope 不必然携带
 *   agent，反查风险高）。
 *
 * ### T2 tools/pre-execute 直调守卫
 *
 * 模型若绕过中间层直调 `mcp__*`（PTC 下 schema 已从 SDK 段隐藏，但注册表仍
 * 可执行），守卫返回 `{ kind: 'deny' }` 引导错误「请经 dsh_mcp_call 调用」。
 * 放行顺序（短路，见 {@link shouldBlockDirectCall}）：
 *
 * 1. `exec.parent !== void 0` —— 中间层内层派发（dsh-tools prepareExecution
 *    的 waterfall 在折叠后不到这里，带 parent 的 nested 会到，必须放行）；
 * 2. 非 `mcp__` 前缀 —— run_code / 原生工具一概不拦；
 * 3. 控制工具（CONTROL_TOOL_NAMES，来自 ./mcpcall，防前缀策略改动后误伤）；
 * 4. gate 未开 —— native 模型直连是正常用法，不因中间层策略打死别的模型；
 * 5. gate.on && !hideAll 且 server 可见 —— 用户显式启用，放行。
 *
 * 拦截 = gate.on 且（hideAll 或 server 不可见）；解析不出 server 的畸形名
 * 保守放行（与装配过滤同口径，不误伤）。判定与装配过滤**同源**：共用
 * {@link serverOfMcp} / {@link hiddenByServerVisibility}，保证「提示词里
 * 看不到的，也调不到」不随两处分叉。
 *
 * 与 auto-review 的 pre-execute 守卫并列不冲突：其对
 * `exec.callId.startsWith("mcp-call-")` 的内层派发直接短路放行
 * （dsh-experimental-auto-review/lib/index.js:469），面板内层派发 callId
 * 恒为 `mcp-call-${randomUUID()}`，命中其短路。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
// G1（评审 §4 BLOCK-2）：控制工具名只认 mcpcall.ts 的常量（批 A 已改名为 dsh_mcp_*）。
// 若这里写旧名字面量，gate 恒不命中 → 控制工具对**所有**模型无条件投放，且无任何报错。
import { CONTROL_TOOL_NAMES } from './mcpcall'

const MCP_TOOL_PREFIX = 'mcp__'

/** 从完整 tool name 解析 server 段（与 catalog.serverOfMcp 一致，保持本模块零依赖）。 */
function serverOfMcp(name: string): string | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const at = rest.indexOf('__')
  if (at < 0) return null
  return rest.slice(0, at)
}

/**
 * mcp__ 工具按 server 可见性的隐藏判定（装配过滤与 pre-execute 守卫共用的
 * 同源判定核心）。畸形名（解析不出 server 段）保守返回 false —— 不隐藏、
 * 不拦截，与装配过滤「不误伤」口径一致。
 */
function hiddenByServerVisibility(name: string, visibility: ReadonlyMap<string, boolean>): boolean {
  const server = serverOfMcp(name)
  if (server === null) return false
  return !(visibility.get(server) ?? true)
}

/**
 * T2 守卫判定：模型**直调**（exec.parent 为空）该工具是否应被拦。
 * 放行顺序见文件头 T2 说明；与装配过滤共用 serverOfMcp / hiddenByServerVisibility。
 */
function shouldBlockDirectCall(
  name: string,
  gate: AssemblyGate,
  visibility: ReadonlyMap<string, boolean>,
): boolean {
  // 非 mcp__ 前缀：run_code / 原生工具 / 控制工具（dsh_mcp_*）一概不拦
  if (!name.startsWith(MCP_TOOL_PREFIX)) return false
  // 控制工具显式放行（前缀策略若变，这里兜底；G1 铁律：控制工具不得以 mcp_ 开头）
  if (CONTROL_TOOL_NAMES.has(name)) return false
  // gate 未开：native 模型直连是正常用法，不因中间层策略打死别的模型
  if (!gate.on) return false
  // 命中中间层 + hideAll：一律引导走控制工具
  if (gate.hideAll) return true
  return hiddenByServerVisibility(name, visibility)
}

/** 一次装配的中间层判定：是否生效 + 是否隐藏全部 MCP server。 */
export interface AssemblyGate {
  on: boolean
  hideAll: boolean
}

/** 遮蔽标记（模块级 Symbol，作 ctx.tools 实例的自有属性）。 */
const SDK_SCHEMAS_SHADOW = Symbol('mcp-skill-panel: sdkSchemas shadow')

/** sdkSchemas 投影条目的最小接口（运行时另带 description/parameters 等，此处只关心名字）。 */
interface SdkSchemaItem {
  name?: string
}

/** T1 遮蔽的目标面：原方法签名（scope 透传，类型从简 —— devDep 0.1.2-rc.1 里 sdkSchemas 是 private）。 */
type SdkSchemasFn = (scope?: unknown) => SdkSchemaItem[]

/** 从原型链解析出的原方法（遮蔽前调用面）。 */
function resolveSdkSchemas(tools: object): SdkSchemasFn | undefined {
  const fn = (tools as { sdkSchemas?: unknown }).sdkSchemas
  return typeof fn === 'function' ? (fn as SdkSchemasFn) : undefined
}

export function installMcpVisibilityFilter(
  ctx: Context,
  buildVisibility: () => ReadonlyMap<string, boolean>,
  gateFor: (agent: Agent | undefined) => AssemblyGate,
  // PTC SDK 段的 hideAll 档位（全局配置，与 agent 无关）。可选：未传时回退
  // 'disabled' 保持旧行为（仅 server 可见性过滤），兼容只传 3 参的自测 harness。
  hidesFor?: () => 'disabled' | 'all',
): () => void {
  return ctx.effect(() => {
    const off = ctx.root.on(
      'system-prompt/assemble',
      (
        assembly: PromptAssembly,
        context: unknown,
        next: () => Promise<PromptAssembly>,
      ): Promise<PromptAssembly> => {
        if (assembly && Array.isArray(assembly.tools)) {
          const agent = (context as { agent?: Agent } | undefined)?.agent
          // 本次装配的模型是否使用中间层（控制工具投放与否 + 隐藏范围）
          const gate = gateFor(agent)
          // 每回合一次 loader 遍历构建可见性表，工具过滤全部 O(1) 查表
          const visibility = buildVisibility()
          assembly.tools = assembly.tools.filter((tool) => {
            const name = String(tool.name ?? '')
            // 控制工具：只投放给 gate 打开的模型
            if (CONTROL_TOOL_NAMES.has(name)) return gate.on
            if (!name.startsWith(MCP_TOOL_PREFIX)) return true
            // hideAll：命中中间层的模型一律不直连 MCP 工具
            if (gate.on && gate.hideAll) return false
            // 畸形工具名（解析不出 server）保守保留，不误伤
            return !hiddenByServerVisibility(name, visibility)
          })
        }
        return next()
      },
    )

    // ── T1：PTC 数据层遮蔽 sdkSchemas（实例自有属性覆盖原型方法）──────────
    // 自测 harness 的 ctx 没有 tools 字段 → 判空跳过遮蔽（守卫监听照常注册）。
    const tools = ctx.tools as unknown as (object & Record<PropertyKey, unknown>) | undefined
    // hideAll 档位读取（每次遮蔽调用取现值，/config 热改后下一轮即生效）；
    // 未传 hidesFor 时回退 'disabled'，与既有 3 参调用点的旧行为逐字一致。
    const hidesOf = hidesFor ?? ((): 'disabled' | 'all' => 'disabled')
    let restoreSdkSchemas: (() => void) | undefined
    if (tools !== undefined) {
      // 幂等：已带标记 ⇒ 遮蔽归首次 install 所有，本次跳过（dispose 对遮蔽为 no-op）
      if (!Object.prototype.hasOwnProperty.call(tools, SDK_SCHEMAS_SHADOW)) {
        const original = resolveSdkSchemas(tools)
        if (original !== undefined) {
          // install 时的自有属性描述符（正常为 undefined —— 原型方法；若有则是他人挂的，dispose 原样写回）
          const previous = Object.getOwnPropertyDescriptor(tools, 'sdkSchemas')
          const shadowed = (scope?: unknown): SdkSchemaItem[] => {
            const all = original.call(tools, scope)
            if (!Array.isArray(all)) return all
            // hideAll='all'：全局配置（与 agent 无关）直接生效 —— 剔除全部 mcp__*
            // 条目，不做 scope→agent 反查（见文件头 T1）
            if (hidesOf() === 'all') {
              return all.filter((item) => !String(item?.name ?? '').startsWith(MCP_TOOL_PREFIX))
            }
            // 'disabled' 档：只按 server 可见性过滤（忽略 scope / gate 分流），见文件头 T1
            const visibility = buildVisibility()
            return all.filter((item) => {
              const name = String(item?.name ?? '')
              if (!name.startsWith(MCP_TOOL_PREFIX)) return true
              return !hiddenByServerVisibility(name, visibility)
            })
          }
          Object.defineProperty(tools, 'sdkSchemas', {
            value: shadowed,
            writable: true,
            configurable: true,
            enumerable: false,
          })
          Object.defineProperty(tools, SDK_SCHEMAS_SHADOW, {
            value: true,
            writable: false,
            configurable: true,
            enumerable: false,
          })
          restoreSdkSchemas = () => {
            if (previous !== undefined) Object.defineProperty(tools, 'sdkSchemas', previous)
            else delete tools.sdkSchemas
            delete tools[SDK_SCHEMAS_SHADOW]
          }
        }
      }
    }

    // ── T2：tools/pre-execute 直调守卫 ┊────────────────────────────────────
    const offGuard = ctx.root.on(
      'tools/pre-execute',
      (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        // 1) 中间层内层派发（dsh_mcp_call → ctx.tools.execute 的 nested 调用）必须放行：
        //    prepareExecution 的 waterfall 只对未折叠（ready）执行触发，nested 全到这里
        if (exec.parent !== void 0) return next()
        const gate = gateFor(exec.agent)
        const visibility = buildVisibility()
        if (!shouldBlockDirectCall(exec.name, gate, visibility)) return next()
        // 拦截：引导走控制工具（materialize 为 Error 文本结果）
        return Promise.resolve({
          kind: 'deny',
          reason: `MCP 工具 ${exec.name} 未在本次装配中投放（dsh-mcp-skill-panel 中间层托管）：请经 dsh_mcp_call 调用（检索用 dsh_mcp_search）`,
        })
      },
    )

    return () => {
      off()
      offGuard()
      restoreSdkSchemas?.()
    }
  }, 'mcp-skill-panel: mcp visibility filter')
}
