/**
 * 内层派发桥（DSH 0.2.3 适配，2026-11-23）。
 *
 * 背景：`dsh_mcp_call` 的所有「插件内调用宿主工具」站点原先走
 * `ctx.tools.execute(<单次 exec>)`。0.2.3 把 `ToolsService.execute` 改成**批量**
 * （`execute(input: ToolBatchInput)`，只认 `{calls, signal, agent, toolSet}`），
 * 旧单 exec 形传进去 `input.calls === undefined` → `pipeline.js` 里
 * `toolCalls.map` 抛 TypeError → 被包成 `ToolBatchExecutionError`
 * （对外只显示 "Tool batch execution failed"）→ 恒报「MCP 调用异常」。
 *
 * 为什么不能改成批量 `execute({ calls: [block] })`：
 * 1) `ToolBatchInput` **没有 parent 字段**。parent = 「本调用是外层 transport 的子派发」
 *    的唯一凭据，两处硬依赖它：
 *    - PTC executor 的 reject 谓词：无 parent 的调用只允许 run_code，其余按 UNKNOWN_TOOL
 *      拒绝（contracts.d.ts："only calls with a parent may execute a native tool name"）；
 *    - 本插件自己的 T2 直调守卫（filter.ts）与本仓库 AR 补丁：nested（parent !== void 0）
 *      才放行/短路。
 * 2) 0.2.3 依然导出 `@deepseek-ai/dsh-tools/pipeline` 的 `ToolExecutionPipeline`，
 *    两个官方 executor（native / ptc）**都**用它做 prepare → dispatch → complete 三段，
 *    且 prepare 的输入就是 0.2.1 那个 `ToolExecutionInput`（含 `parent`）。
 *    所以「单次派发 + 带 parent」在 0.2.3 的正规做法就是自己走这三段。
 *
 * 兼容性：0.2.1-rc.2 及更早的 dsh-tools **没有** `./pipeline` 子路径导出，
 * 且旧版 `execute(exec)` 的单 exec 语义本来就是对的。因此这里的子路径用
 * **非字面量 dynamic import** 加载（tsc 的 moduleResolution 与 tsdown 打包都不介入，
 * 不会在编译期把老版本依赖打成硬失败），加载失败即回退旧的 `execute(exec)`。
 *
 * 本文件刻意不 import 任何 `@deepseek-ai/*`：它有独立的 tsdown 产物
 * （lib/inner-exec.js），可被 scripts/selftest-inner-exec.mjs 在仓库内直接加载自测。
 */

/** 内层派发的输入：0.2.3 `ToolExecutionInput` 的可移植子集，字段原样透传。 */
export type InnerExecInput = Record<string, unknown>

/** 旧的单 exec 派发面（dsh-tools <= 0.2.1 的 `ToolsService.execute(exec)`）。 */
export interface InnerExecFallback {
  execute(exec: unknown): Promise<unknown>
}

/** 单个调度阶段的结果（`kind: 'dispatch' | 'post-result' | 'final-result'`）。 */
export interface InnerStage {
  kind?: string
  exec?: unknown
  result?: unknown
}

/** `ToolExecutionPipeline` 的最小结构面（只用三段式方法）。 */
export interface InnerPipeline {
  prepare(input: unknown): Promise<InnerStage>
  dispatch(exec: unknown): Promise<InnerStage>
  complete(exec: unknown, outcome: InnerStage): Promise<unknown>
}

export type InnerPipelineCtor = new (ctx: unknown, source?: unknown) => InnerPipeline

/**
 * 子路径规格串：拼接而非字面量。
 * 目的：让 tsc（moduleResolution: bundler）与 tsdown 都**不**静态解析它 ——
 * 仓库 devDependencies 钉的 dsh-tools 是 0.1.2-rc.1，没有 `./pipeline` 导出，
 * 字面量 import 会直接让 typecheck / build 失败。
 */
const PIPELINE_SPEC = ['@deepseek-ai', 'dsh-tools/pipeline'].join('/')

let pipelineCtorPromise: Promise<InnerPipelineCtor | undefined> | undefined

/** 清空加载缓存（selftest 用）。 */
export function resetInnerPipelineCache(): void {
  pipelineCtorPromise = undefined
}

/**
 * 惰性加载 `ToolExecutionPipeline`；宿主没有该子路径（<= 0.2.1）时返回 undefined。
 * 结果缓存（成功/失败都缓存）：调用发生在工具执行热路径上，避免每次 MCP 调用都试一次 import。
 */
export function loadInnerPipeline(): Promise<InnerPipelineCtor | undefined> {
  pipelineCtorPromise ??= (async () => {
    try {
      const mod = (await import(PIPELINE_SPEC)) as { ToolExecutionPipeline?: unknown }
      const ctor = mod?.ToolExecutionPipeline
      return typeof ctor === 'function' ? (ctor as InnerPipelineCtor) : undefined
    } catch {
      return undefined
    }
  })()
  return pipelineCtorPromise
}

export interface DispatchInnerOptions {
  /** 显式注入构造器（selftest）；传 null 强制走回退分支。默认惰性加载。 */
  ctor?: InnerPipelineCtor | null
}

/**
 * 派发一次内层工具调用。
 *
 * 0.2.3+：`prepare` →（`kind === 'dispatch'` 才 `dispatch`）→ `complete`，
 * 三段必须由**同一个** pipeline 实例持有（执行态挂在实例的 WeakMap/WeakSet 上）。
 * 旧版：直接 `fallback.execute(input)`（旧 execute 就是单调用，输入形状一致）。
 *
 * @param ctx - 宿主 Context（pipeline 需要 `ctx.tools` 与 `ctx.waterfall`）。
 * @param fallback - 视图上的 `tools` 服务（提供旧的单 exec `execute`）。
 * @param input - 单次派发输入（callId/name/arguments/agent/signal[/parent/rootCallId]）。
 */
export async function dispatchInner(
  ctx: unknown,
  fallback: InnerExecFallback | undefined,
  input: InnerExecInput,
  options: DispatchInnerOptions = {},
): Promise<unknown> {
  const explicit = options.ctor
  const Ctor = explicit === null ? undefined : (explicit ?? (await loadInnerPipeline()))
  if (Ctor) {
    const pipeline = new Ctor(ctx)
    const prepared = await pipeline.prepare(input)
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
    return pipeline.complete(prepared.exec, outcome)
  }
  if (!fallback || typeof fallback.execute !== 'function') {
    // 理论上不可达：0.2.1 有 execute(exec)，0.2.3 有 ./pipeline。留显式失败而非静默丢调用。
    throw new Error('内层派发不可用：宿主 dsh-tools 既无 ./pipeline 子路径导出，也无单 exec execute()')
  }
  return fallback.execute(input)
}
