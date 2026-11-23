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
 * 3. 官方 L1 loader（`mcp__<server>__load_tools`，0.2.3-alpha.1 起的按需加载
 *    入口，见 {@link isL1LoaderTool}）—— 拦它 = 官方 L1 被面板掐死，全量放行；
 * 4. 控制工具（CONTROL_TOOL_NAMES，来自 ./mcpcall，防前缀策略改动后误伤）；
 * 5. gate 未开 —— native 模型直连是正常用法，不因中间层策略打死别的模型；
 * 6. gate.on && !hideAll 且 server 可见 —— 用户显式启用，放行。
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
import { rootContext } from './util'

const MCP_TOOL_PREFIX = 'mcp__'

/**
 * 官方 L1 loader 工具判定（0.2.3-alpha.1 起）：`mcp__<server>__load_tools`。
 * 宿主官方按需加载（toolLoading: on-demand）的入口工具，调用它只装载 schema、
 * 不执行任何 MCP 工具本体。装配过滤与 T2 守卫对它**全量放行**（见两处调用点），
 * 否则官方 L1 在中间层开启时会被面板彻底掐死。
 */
function isL1LoaderTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) && name.endsWith('__load_tools')
}

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
 * 「该工具对这次装配是否隐藏」的**唯一判定核心**：装配过滤、SDK 段遮蔽（A）、
 * definitions 遮蔽（B′）、直调守卫（T2′）四处共用，保证「提示词里看不到的，
 * 也调不到」不随实现分叉。
 *
 * 放行顺序：非 mcp__ → L1 loader → 控制工具 → gate 未开 → 可见（或 hideAll）。
 */
function hiddenForAssembly(
  name: string,
  gate: AssemblyGate,
  visibility: ReadonlyMap<string, boolean>,
): boolean {
  // 非 mcp__ 前缀：run_code / 原生工具 / 控制工具（dsh_mcp_*）一概不隐藏
  if (!name.startsWith(MCP_TOOL_PREFIX)) return false
  // 0.2.3 L1 loader 放行（mcp__<server>__load_tools）：官方按需加载机制的入口，
  // 藏它 = 官方 L1 在中间层开启时不可用。它不执行 MCP 工具本体，放行无直调风险。
  if (isL1LoaderTool(name)) return false
  // 控制工具显式放行（前缀策略若变，这里兜底；G1 铁律：控制工具不得以 mcp_ 开头）
  if (CONTROL_TOOL_NAMES.has(name)) return false
  // gate 未开：native 模型直连是正常用法，不因中间层策略打死别的模型
  if (!gate.on) return false
  // 命中中间层 + hideAll：一律引导走控制工具
  if (gate.hideAll) return true
  return hiddenByServerVisibility(name, visibility)
}

/** T2′ 守卫判定（薄封装，语义见 {@link hiddenForAssembly}）。 */
function shouldBlockDirectCall(
  name: string,
  gate: AssemblyGate,
  visibility: ReadonlyMap<string, boolean>,
): boolean {
  return hiddenForAssembly(name, gate, visibility)
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

/**
 * C2（0.2.3 预适配）：T1 sdkSchemas 遮蔽的降级状态（/debug 只读曝光）。
 * dsh ≥ 0.2.2 移除了 `ToolRuntime.sdkSchemas`，T1 遮蔽随之**未生效（inactive）**
 * —— 不抛错、不崩，装配过滤（assembly.tools）与 T2 守卫照常工作，只是 PTC
 * SDK 段失去按可见性遮蔽能力。该状态必须可观测（/debug `sdkMasking` 字段），
 * 否则「hideAll 开了但 SDK 段没遮」无法定位。
 */
export interface SdkMaskingStatus {
  /** true = T1 遮蔽已安装且生效；false = 降级/未安装。 */
  active: boolean
  /** 人读原因（inactive 时说明为何，active 时说明安装形态）。 */
  reason: string
}

let sdkMaskingStatus: SdkMaskingStatus = { active: false, reason: '中间层未挂载（T1 未安装）' }

/** /debug 读取 T1 遮蔽的当下状态（C2 降级可观测）。 */
export function sdkMaskingStatusForDebug(): SdkMaskingStatus {
  return { ...sdkMaskingStatus }
}

/** 从原型链解析出的原方法（遮蔽前调用面）。 */
function resolveSdkSchemas(tools: object): SdkSchemasFn | undefined {
  const fn = (tools as { sdkSchemas?: unknown }).sdkSchemas
  return typeof fn === 'function' ? (fn as SdkSchemasFn) : undefined
}

// ───────────────────────────────────────────────────────────────────────────
// 0.2.3-alpha.2 修复：A（tools:sdk 段重渲染）+ B′（definitions 遮蔽）+ T2′
//
// 背景：dsh ≥0.2.2 删掉 ToolRuntime.sdkSchemas（T1 因此 inactive）；PTC 的 SDK
// 声明段改由 PtcExecutor.renderSdk 从 ToolsService.definitions(scope,toolSet) 渲染
// （dsh-tools/lib/index.js:610），而 waterfall 载荷（:680-684）根本没有 tools 字段
// → 旧的 assembly.tools 过滤同样空转。两个真实泄漏点：
//   L1 常驻：用户开着 / hideAll='all' 的 server 工具照样进 SDK 段；
//   L2 借用：dsh_mcp_call 临时拉起的 server 在 keepAlive 窗口内注册 → 进段。
//
// A：在 system-prompt/assemble 里找到 name='tools:sdk' 的 section，用官方
//    renderToolsSdk（dsh-tool-executor-ptc 导出）按过滤后的 definitions 重建
//    text。canary：先对**全量** definitions 重渲染一次，必须与宿主原文逐字节
//    一致，否则说明宿主渲染形态变了 → fail-open（不改文本）+ 告警。
// B′：遮蔽 ctx.tools.definitions（实例自有属性，链式调用原方法后过滤）。它是
//    SDK 段、native tools header（:419）与 run_code bindings（schemas()，:590）
//    三处投影的**同一数据源**；executable()（:530-534）不经它 → 执行面不变，
//    面板的 dsh_mcp_call 内层派发不受影响。
// T2′：守卫不再看 exec.parent（内层派发也带 parent），改看 callId —— 模型在
//    run_code 里的直调 callId 形如 '<run_code callId>:ptc:<n>'，面板内层派发
//    恒为 'mcp-call-<uuid>'。只治理前者，避免误伤宿主/其它插件的内部派发。
// ───────────────────────────────────────────────────────────────────────────

/** B′ 遮蔽标记（模块级 Symbol，作 ctx.tools 的自有属性，幂等 + dispose 归属）。 */
const DEFINITIONS_SHADOW = Symbol('mcp-skill-panel: definitions shadow')

/** definitions 的最小签名（真实返回 ToolDefinition[]，这里只关心 name）。 */
type DefinitionsFn = (scope?: unknown, toolSet?: unknown) => Array<{ name?: string }>

/** 渲染器看到的最小定义形状（与 PtcExecutor.renderSdk 的投影入参一致）。 */
interface ToolDefinitionLike {
  name?: string
  output?: { schema?: unknown }
}

/** 官方 SDK 段渲染器的惰性句柄（拿到即可逐字节复现宿主渲染结果）。 */
interface SdkRenderer {
  render: (definitions: readonly ToolDefinitionLike[]) => string
}

let sdkRendererPromise: Promise<SdkRenderer | null> | undefined
let sdkSectionMaskStatus: SdkMaskingStatus = { active: false, reason: '中间层未挂载（A 未安装）' }
let mcpServersMaskStatus: SdkMaskingStatus = { active: false, reason: '中间层未挂载（A-2 未安装）' }
let definitionsShadowStatus: SdkMaskingStatus = { active: false, reason: '中间层未挂载（B′ 未安装）' }
let warnedSdkCanary = false
let warnedSectionMask = false

/** /debug：A（tools:sdk 段重渲染）的当下状态。 */
export function sdkSectionMaskStatusForDebug(): SdkMaskingStatus {
  return { ...sdkSectionMaskStatus }
}

/** /debug：A-2（mcp-resource-servers 名清单重渲染）的当下状态。 */
export function mcpServersMaskStatusForDebug(): SdkMaskingStatus {
  return { ...mcpServersMaskStatus }
}

/** /debug：B′（definitions 遮蔽）的当下状态。 */
export function definitionsShadowStatusForDebug(): SdkMaskingStatus {
  return { ...definitionsShadowStatus }
}

function resolveDefinitions(tools: object): DefinitionsFn | undefined {
  const fn = (tools as { definitions?: unknown }).definitions
  return typeof fn === 'function' ? (fn as DefinitionsFn) : undefined
}

/**
 * 惰性装载官方渲染器。包不在本仓 deps 里：用**变量 specifier + 动态 import**
 * 让类型检查与打包器都不静态解析它；宿主上解析失败（无 PTC executor / 换包名）
 * 时返回 null，A 自动跳过（B′ 仍然生效）。宿主与插件共用同一份物理拷贝时
 * （profile junction → workspace store），拿到的是同一个 renderToolsSdk。
 */
/**
 * 先按裸 specifier import；失败则用 createRequire 解析出绝对路径再 import。
 *
 * 为什么需要两条路：ESM 的裸 specifier 只看插件自身的 node_modules 链 —— 部署目录
 * 的 @deepseek-ai 是 web profile 的 junction，而 dsh-tool-executor-ptc 只存在于
 * profiles\\node_modules（hoisted 层），ESM 走不到；CJS 的 createRequire 能命中
 * 同一物理文件，解析后用 file URL import 即可拿到**宿主正在用的那一份**模块
 * （同一 realpath → 同一个模块实例）。
 */
async function importBySpecifier(specifier: string): Promise<Record<string, unknown>> {
  try {
    return (await import(specifier)) as Record<string, unknown>
  } catch {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const requireFromBundle = createRequire(import.meta.url)
    const resolved = requireFromBundle.resolve(specifier)
    return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>
  }
}
function loadSdkRenderer(ctx: Context): Promise<SdkRenderer | null> {
  if (sdkRendererPromise !== undefined) return sdkRendererPromise
  sdkRendererPromise = (async (): Promise<SdkRenderer | null> => {
    try {
      const ptcSpecifier = '@deepseek-ai/dsh-tool-executor-ptc'
      const toolsSpecifier = '@deepseek-ai/dsh-tools'
      const [ptcModule, toolsModule] = await Promise.all([
        importBySpecifier(ptcSpecifier),
        importBySpecifier(toolsSpecifier),
      ])
      const renderToolsSdk = ptcModule.renderToolsSdk
      const projectToolSchema = toolsModule.projectToolSchema
      if (typeof renderToolsSdk !== 'function' || typeof projectToolSchema !== 'function') return null
      const project = projectToolSchema as (definition: unknown, withOutput?: boolean) => Record<string, unknown>
      const render = renderToolsSdk as (schemas: unknown[], format: string) => string
      return {
        render: (definitions) => {
          // programFormat 只在渲染时需要；服务缺失 / 未 inject 时回退宿主默认值。
          let format: string | undefined
          try {
            format = (ctx as { ptcRuntime?: { programFormat?: string } }).ptcRuntime?.programFormat
          } catch {
            format = undefined
          }
          return render(
            definitions.map((definition) => ({
              ...project(definition, false),
              output: definition.output?.schema,
            })),
            format ?? 'function-body',
          )
        },
      }
    } catch {
      return null
    }
  })()
  return sdkRendererPromise
}

/**
 * B′：遮蔽 ctx.tools.definitions（实例自有属性）。
 *
 * - 只在**给了 scope**（某个 agent 的视图）时过滤；全局视图原样返回 —— 面板 /
 *   宿主自身的清单读取要完整，隐藏只针对「装配与绑定」两个消费点。
 * - 无隐藏项时返回同一个数组引用（零扰动：宿主 committed.text 判定不误判）。
 * - dispose 原样还原安装前的属性描述符（若无人挂过自有属性则删除，原型方法恢复）。
 */
function installDefinitionsShadow(
  tools: object,
  gateFor: (agent: Agent | undefined) => AssemblyGate,
  buildVisibility: () => ReadonlyMap<string, boolean>,
): () => void {
  if (Object.prototype.hasOwnProperty.call(tools, DEFINITIONS_SHADOW)) {
    definitionsShadowStatus = { active: true, reason: 'B′ 遮蔽由首次 install 持有（幂等跳过重复安装）' }
    return () => {}
  }
  const original = resolveDefinitions(tools)
  if (original === undefined) {
    definitionsShadowStatus = { active: false, reason: 'ctx.tools.definitions 不存在（宿主版本不支持），B′ 跳过' }
    return () => {}
  }
  const previous = Object.getOwnPropertyDescriptor(tools, 'definitions')
  const shadowed = function (this: unknown, scope?: unknown, toolSet?: unknown): Array<{ name?: string }> {
    const all = original.call(this ?? tools, scope, toolSet)
    if (scope === undefined) return all
    // 只对**真正的 Agent 视图**过滤。面板采集（collect.ts:124 ctx.tools.schemas(scopeKey)）、
    // mcpcall 注册等待、cordis host-runner 沙箱 façade 传的都是 opaque scope key：
    // 那类 key 交给 gateFor 会被当成「无路由」回退到总开关，从而把面板自己的采集链
    // 一起过滤掉（采不到工具 → catalog 断流）。真 Agent 必带 session.requestHeader
    // （assembleContextFor 在 dsh-agent/lib/index.js:406-412 直接 scope: agent）。
    const agentLike = scope as { session?: { requestHeader?: unknown } }
    if (typeof agentLike?.session?.requestHeader !== 'function') return all
    // 判定源（路由解析 / loader 遍历）任何异常都 fail-open：definitions 是宿主的
    // 热路径，抛错会连带打死装配与 run_code bindings。
    let gate: AssemblyGate
    let visibility: ReadonlyMap<string, boolean>
    try {
      gate = gateFor(scope as Agent)
      if (!gate.on) return all
      visibility = buildVisibility()
    } catch {
      return all
    }
    const kept = all.filter((definition) => !hiddenForAssembly(String(definition?.name ?? ''), gate, visibility))
    return kept.length === all.length ? all : kept
  }
  Object.defineProperty(tools, DEFINITIONS_SHADOW, { value: true, enumerable: false, configurable: true })
  Object.defineProperty(tools, 'definitions', {
    configurable: true,
    enumerable: previous?.enumerable ?? false,
    writable: true,
    value: shadowed,
  })
  definitionsShadowStatus = {
    active: true,
    reason: 'B′ definitions 遮蔽已安装（SDK 段 / native header / bindings 同步隐藏；executable 不受影响）',
  }
  return () => {
    definitionsShadowStatus = { active: false, reason: '中间层已卸下（B′ 未安装）' }
    if (previous === undefined) {
      Reflect.deleteProperty(tools, 'definitions')
      Reflect.deleteProperty(tools, DEFINITIONS_SHADOW)
      return
    }
    Object.defineProperty(tools, 'definitions', previous)
  }
}

/**
 * A：在装配 waterfall 里重建 tools:sdk 段文本。
 *
 * 只在本步 gate 打开、段存在、且 canary（全量重渲染 == 宿主原文）通过时改写；
 * 任何异常/不匹配都原样放行（fail-open），绝不让半截 TypeScript 进提示词。
 */
/** `mcp-resource-servers` 段的宿主模板（@deepseek-ai/dsh-mcp-resources/lib/index.js:128-132）。 */
const MCP_SERVERS_PREFIX =
  '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: '

/** 与宿主逐字同构地重渲染该段（names 已排序；空集 → 空串，宿主同样返回 ""）。 */
function renderMcpServers(names: string[]): string {
  return names.length === 0 ? '' : MCP_SERVERS_PREFIX + JSON.stringify(names) + '.'
}

/** 从宿主段文本里解析 server 名单（模板不符 → null，调用方 fail-open）。 */
function parseMcpServers(text: string): string[] | null {
  if (!text.startsWith(MCP_SERVERS_PREFIX)) return null
  const tail = text.slice(MCP_SERVERS_PREFIX.length).trim()
  if (!tail.endsWith('.')) return null
  try {
    const parsed: unknown = JSON.parse(tail.slice(0, -1))
    return Array.isArray(parsed) ? parsed.map((name) => String(name)) : null
  } catch {
    return null
  }
}

/** server 级隐藏判定（与 hiddenForAssembly 同源口径：hideAll 或该 server 不可见）。 */
function hiddenServerForAssembly(
  name: string,
  gate: AssemblyGate,
  visibility: ReadonlyMap<string, boolean>,
): boolean {
  return gate.on && (gate.hideAll || visibility.get(name) === false)
}

/**
 * A-1：重渲染 `tools:sdk`（工具声明面）。
 * canary = 用官方 renderToolsSdk 对**全量** definitions 重渲染，必须与宿主原文逐字节
 * 相同；不符说明宿主渲染形态变了 → 不改文本（fail-open）+ 告警。
 */
async function maskToolsSdkSection(
  ctx: Context,
  sections: Array<{ name?: string; text?: unknown }> | undefined,
  scope: Agent | undefined,
  toolSet: unknown,
  gate: AssemblyGate,
  visibility: ReadonlyMap<string, boolean>,
): Promise<void> {
  const section = sections?.find((candidate) => candidate.name === 'tools:sdk')
  if (section === undefined || typeof section.text !== 'string' || section.text.length === 0) return
  const renderer = await loadSdkRenderer(ctx)
  if (renderer === null) {
    sdkSectionMaskStatus = {
      active: false,
      reason: '渲染器不可用（@deepseek-ai/dsh-tool-executor-ptc 解析失败或未导出 renderToolsSdk），A 跳过',
    }
    return
  }
  const definitionsFn = resolveDefinitions(ctx.tools as unknown as object)
  if (definitionsFn === undefined) return
  const definitions = definitionsFn.call(ctx.tools, scope, toolSet) as ToolDefinitionLike[]
  if (definitions.length === 0) return
  if (renderer.render(definitions) !== section.text) {
    sdkSectionMaskStatus = { active: false, reason: 'canary 不符（宿主渲染形态可能已变），A fail-open' }
    if (!warnedSdkCanary) {
      warnedSdkCanary = true
      ctx.logger.warn('mcp-skill-panel: tools:sdk canary mismatch — 本轮不改写段文本（fail-open）')
    }
    return
  }
  const kept = definitions.filter((definition) => !hiddenForAssembly(String(definition?.name ?? ''), gate, visibility))
  if (kept.length !== definitions.length) {
    section.text = renderer.render(kept)
    sdkSectionMaskStatus = {
      active: true,
      reason: 'A 段重渲染已生效（本步隐藏 ' + (definitions.length - kept.length) + ' 个工具）',
    }
  } else {
    sdkSectionMaskStatus = { active: true, reason: 'A 已安装（本步无可隐藏项）' }
  }
}

/**
 * A-2：重渲染 `mcp-resource-servers`（server 名清单）。
 * 宿主按 scope 合并注册的 server 名（`dsh-mcp-resources/lib/index.js:126-131`），
 * 借用窗口会让清单抖动并泄漏 server 名。这里按同一 gate/可见性过滤：隐藏的 server
 * 不进清单；全部隐藏 → 空串（宿主对空集同样返回 ""，不产生 delta）。
 */
function maskMcpServersSection(
  sections: Array<{ name?: string; text?: unknown }> | undefined,
  gate: AssemblyGate,
  visibility: ReadonlyMap<string, boolean>,
): void {
  const section = sections?.find((candidate) => candidate.name === 'mcp-resource-servers')
  if (section === undefined || typeof section.text !== 'string' || section.text.length === 0) return
  const names = parseMcpServers(section.text)
  if (names === null) {
    mcpServersMaskStatus = { active: false, reason: '模板不符（宿主段落格式可能已变），A-2 fail-open' }
    return
  }
  if (renderMcpServers(names) !== section.text) {
    mcpServersMaskStatus = { active: false, reason: 'canary 不符（宿主渲染形态可能已变），A-2 fail-open' }
    return
  }
  const kept = names.filter((name) => !hiddenServerForAssembly(name, gate, visibility))
  if (kept.length !== names.length) {
    section.text = renderMcpServers(kept)
    mcpServersMaskStatus = {
      active: true,
      reason: 'A-2 已生效（本步隐藏 ' + (names.length - kept.length) + ' 个 server 名）',
    }
  } else {
    mcpServersMaskStatus = { active: true, reason: 'A-2 已安装（本步无可隐藏 server）' }
  }
}

/**
 * A：在装配 waterfall 里重渲染两处提示词段（工具声明 + MCP server 名清单）。
 *
 * 只在本步 gate 打开、且 scope 是**真 Agent 视图**时介入；任何异常/模板不符都
 * 原样放行（fail-open），绝不让半截 TypeScript 或错乱清单进提示词。
 */
function installSdkSectionMask(
  ctx: Context,
  gateFor: (agent: Agent | undefined) => AssemblyGate,
  buildVisibility: () => ReadonlyMap<string, boolean>,
): () => void {
  // 无 tools 服务（自测 harness / 非 PTC 宿主）就没有可遮蔽的数据源：不注册监听，
  // 免得与既有装配过滤抢同一个事件的单测桩（真实 cordis waterfall 是链式组合）。
  if ((ctx as { tools?: unknown }).tools === undefined) {
    sdkSectionMaskStatus = { active: false, reason: 'ctx.tools 不可用（自测 harness / 非 PTC 宿主），A 跳过' }
    return () => {}
  }
  return rootContext(ctx).on(
    'system-prompt/assemble',
    async (
      assembly: PromptAssembly,
      context: unknown,
      next: () => Promise<PromptAssembly>,
    ): Promise<PromptAssembly> => {
      try {
        const sections = (assembly as { sections?: Array<{ name?: string; text?: unknown }> }).sections
        const scope = (context as { scope?: Agent } | undefined)?.scope
        const agentLike = scope as { session?: { requestHeader?: unknown } } | undefined
        if (typeof agentLike?.session?.requestHeader !== 'function') return next()
        const gate = gateFor(scope)
        if (!gate.on) return next()
        const visibility = buildVisibility()
        const toolSet = (context as { toolSet?: unknown } | undefined)?.toolSet
        await maskToolsSdkSection(ctx, sections, scope, toolSet, gate, visibility)
        maskMcpServersSection(sections, gate, visibility)
        return next()
      } catch (error) {
        if (!warnedSectionMask) {
          warnedSectionMask = true
          ctx.logger.warn(
            'mcp-skill-panel: prompt section mask failed: ' +
              (error instanceof Error ? error.message : String(error)),
          )
        }
        return next()
      }
    },
  )
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
    const off = rootContext(ctx).on(
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
            // 0.2.3 L1 loader（mcp__<server>__load_tools）保持可见：它是官方按需
            // 加载的自面，被 hideAll/可见性过滤藏掉 = 官方 L1 对模型不可用
            // （与 T2 守卫的放行口径一致，见 isL1LoaderTool）。
            if (isL1LoaderTool(name)) return true
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
          // C2：遮蔽可安装 —— 置生效态（/debug sdkMasking.active=true）
          sdkMaskingStatus = { active: true, reason: 'T1 遮蔽已安装（实例自有属性遮蔽原型 sdkSchemas）' }
          // install 时的自有属性描述符（正常为 undefined —— 原型方法；若有则是他人挂的，dispose 原样写回）
          const previous = Object.getOwnPropertyDescriptor(tools, 'sdkSchemas')
          const shadowed = (scope?: unknown): SdkSchemaItem[] => {
            const all = original.call(tools, scope)
            if (!Array.isArray(all)) return all
            // hideAll='all'：全局配置（与 agent 无关）直接生效 —— 剔除全部 mcp__*
            // 条目，不做 scope→agent 反查（见文件头 T1）。官方 L1 loader 除外（同装配过滤口径）。
            if (hidesOf() === 'all') {
              return all.filter((item) => {
                const name = String(item?.name ?? '')
                return isL1LoaderTool(name) || !name.startsWith(MCP_TOOL_PREFIX)
              })
            }
            // 'disabled' 档：只按 server 可见性过滤（忽略 scope / gate 分流），见文件头 T1
            const visibility = buildVisibility()
            return all.filter((item) => {
              const name = String(item?.name ?? '')
              if (!name.startsWith(MCP_TOOL_PREFIX)) return true
              // 官方 L1 loader 不按 server 可见性隐藏（同装配过滤口径）
              if (isL1LoaderTool(name)) return true
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
            // C2：遮蔽随中间层卸载（restore 只在遮蔽安装成功时存在）
            sdkMaskingStatus = { active: false, reason: 'T1 遮蔽已随中间层卸载（dispose）' }
          }
        } else {
          // C2 降级：sdkSchemas 缺失（dsh ≥ 0.2.2 移除 ToolRuntime.sdkSchemas）。
          // 显式走「未生效（inactive）」分支：不抛错、不崩，装配过滤与 T2 守卫
          // 不受影响，仅 PTC SDK 段失去按可见性遮蔽能力 —— /debug sdkMasking 可观测。
          sdkMaskingStatus = {
            active: false,
            reason: 'sdkSchemas missing（dsh ≥ 0.2.2 移除 ToolRuntime.sdkSchemas）：T1 遮蔽未生效，PTC SDK 段无法按可见性遮蔽；装配过滤与 T2 守卫不受影响',
          }
        }
      } else {
        // C2：遮蔽归首次 install 所有（幂等跳过），仍生效
        sdkMaskingStatus = { active: true, reason: 'T1 遮蔽由首次 install 持有（幂等跳过重复安装）' }
      }
    } else {
      // C2：自测 harness 的 ctx 没有 tools 字段 → 遮蔽跳过（守卫监听照常注册）
      sdkMaskingStatus = { active: false, reason: 'ctx.tools 不可用（自测 harness），T1 跳过' }
    }

    // ── A + B′：0.2.3-alpha.2 的真隐藏（段文本重渲染 + definitions 遮蔽）──────
    // 两者同源、互为校验：B′ 在数据源头过滤（SDK 段 / native header / run_code bindings
    // 三处投影同一 definitions），A 在提示面用官方渲染器重渲染并做 canary 逐字节校验。
    // 注意二者都依赖 definitions：宿主要是连 definitions 都没了，两者一起跳过（fail-open）
    // —— 不存在「B′ 失效而 A 兜底」的情形，/debug 的 ptcMasking 字段按此如实读数。
    const restoreDefinitions =
      tools !== undefined ? installDefinitionsShadow(tools as unknown as object, gateFor, buildVisibility) : () => {}
    const offSdkMask = installSdkSectionMask(ctx, gateFor, buildVisibility)

    // ── T2：tools/pre-execute 直调守卫 ┊────────────────────────────────────
    const offGuard = rootContext(ctx).on(
      'tools/pre-execute',
      (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        // 1) 「模型直调」的两种形态（其余一律放行，避免误伤宿主 / 其它插件的内部派发）：
        //    a. native 顶层直调：exec.parent 为空、callId 由模型签发（无 ':ptc:'）。
        //       B′ 让它从工具清单消失，但模型仍可能凭记忆直调 → 必须在这里拦。
        //    b. PTC 程序内 binding：callId 形如 '<run_code callId>:ptc:<n>'
        //       （dsh-tool-executor-ptc lib/_chunks/ptc-calls:468）。
        //    面板内层派发恒为 'mcp-call-<uuid>'（mcpcall.ts:611/717/791/1175），豁免；
        //    带 parent 的非面板内部派发（含 'mcp-call-x:ptc:n' 形态）同样豁免。
        const callId = String(exec.callId ?? '')
        const isPanelInner = callId.startsWith('mcp-call-')
        const isPtcBinding = callId.includes(':ptc:')
        const isModelDirect = !isPanelInner && (isPtcBinding || exec.parent === void 0)
        if (!isModelDirect) return next()
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
      offSdkMask()
      restoreDefinitions()
      restoreSdkSchemas?.()
    }
  }, 'mcp-skill-panel: mcp visibility filter')
}
