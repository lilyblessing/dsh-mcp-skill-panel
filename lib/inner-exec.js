//#region src/inner-exec.ts
/**
* 子路径规格串：拼接而非字面量。
* 目的：让 tsc（moduleResolution: bundler）与 tsdown 都**不**静态解析它 ——
* 仓库 devDependencies 钉的 dsh-tools 是 0.1.2-rc.1，没有 `./pipeline` 导出，
* 字面量 import 会直接让 typecheck / build 失败。
*/
const PIPELINE_SPEC = ["@deepseek-ai", "dsh-tools/pipeline"].join("/");
let pipelineCtorPromise;
/** 清空加载缓存（selftest 用）。 */
function resetInnerPipelineCache() {
	pipelineCtorPromise = void 0;
}
/**
* 惰性加载 `ToolExecutionPipeline`；宿主没有该子路径（<= 0.2.1）时返回 undefined。
* 结果缓存（成功/失败都缓存）：调用发生在工具执行热路径上，避免每次 MCP 调用都试一次 import。
*/
function loadInnerPipeline() {
	pipelineCtorPromise ??= (async () => {
		try {
			const ctor = (await import(PIPELINE_SPEC))?.ToolExecutionPipeline;
			return typeof ctor === "function" ? ctor : void 0;
		} catch {
			return;
		}
	})();
	return pipelineCtorPromise;
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
async function dispatchInner(ctx, fallback, input, options = {}) {
	const explicit = options.ctor;
	const Ctor = explicit === null ? void 0 : explicit ?? await loadInnerPipeline();
	if (Ctor) {
		const pipeline = new Ctor(ctx);
		const prepared = await pipeline.prepare(input);
		const outcome = prepared.kind === "dispatch" ? await pipeline.dispatch(prepared.exec) : prepared;
		return pipeline.complete(prepared.exec, outcome);
	}
	if (!fallback || typeof fallback.execute !== "function") throw new Error("内层派发不可用：宿主 dsh-tools 既无 ./pipeline 子路径导出，也无单 exec execute()");
	return fallback.execute(input);
}
//#endregion
export { dispatchInner, loadInnerPipeline, resetInnerPipelineCache };
