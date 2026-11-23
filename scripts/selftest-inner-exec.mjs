/**
 * 内层派发桥（soft: src/inner-exec.ts）的节点自测（node scripts/selftest-inner-exec.mjs）。
 *
 * 为什么必须单独测：这是 0.2.3 API 变更的修复核心（0.2.1 的单 exec 形 → 0.2.3 的
 * prepare/dispatch/complete 三段）。三段顺序、实例复用、post-result 短路、旧版回退
 * 四条任一错都会让 dsh_mcp_call 全量失败，而失败现象只有一句
 * 「Tool batch execution failed」，线上无法区分。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'lib', 'inner-exec.js')
const mod = await import(`file://${entry.replace(/\\/g, '/')}`)
const { dispatchInner, loadInnerPipeline, resetInnerPipelineCache } = mod

let failed = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    console.log('  --- expected ---')
    console.log(JSON.stringify(expected))
    console.log('  --- actual ---')
    console.log(JSON.stringify(actual))
  }
}

const input = {
  callId: 'mcp-call-selftest',
  rootCallId: 'root-1',
  name: 'mcp__obsidian__tag_list',
  arguments: {},
  agent: { id: 'agent-1' },
  signal: new AbortController().signal,
  parent: { token: 'tok-1' },
}

// ① 三段式：prepare(dispatch) → dispatch → complete，同一实例、exec 原样传递
const trace = []
const seen = {}
class FakePipeline {
  constructor(ctx) {
    seen.ctx = ctx
    trace.push('ctor')
  }
  async prepare(i) {
    trace.push('prepare')
    seen.input = i
    return { kind: 'dispatch', exec: { id: 'exec-1' } }
  }
  async dispatch(exec) {
    trace.push(`dispatch:${exec.id}`)
    return { kind: 'post-result', result: { isError: false, content: [{ type: 'text', text: 'ok' }] } }
  }
  async complete(exec, outcome) {
    trace.push(`complete:${exec.id}:${outcome.kind}`)
    return outcome.result
  }
}
const ctx = { tools: { fake: true } }
const out1 = await dispatchInner(ctx, { execute: async () => ({ via: 'fallback' }) }, input, { ctor: FakePipeline })
check('① 三段顺序 + 实例复用', trace, ['ctor', 'prepare', 'dispatch:exec-1', 'complete:exec-1:post-result'])
check('① 结果原样透传', out1, { isError: false, content: [{ type: 'text', text: 'ok' }] })
check('① ctx 原样交给构造器', seen.ctx === ctx, true)
check('① 输入逐字段原样（含 parent）', seen.input, input)

// ② prepare 直接给 post-result（如 policy 拒绝/取消）→ 不得 dispatch，仍要 complete
const trace2 = []
class ShortPipeline {
  async prepare() {
    trace2.push('prepare')
    return { kind: 'post-result', exec: { id: 'e2' }, result: { isError: true, error: { message: 'denied' } } }
  }
  async dispatch() {
    trace2.push('dispatch')
    return { kind: 'post-result', result: {} }
  }
  async complete(exec, outcome) {
    trace2.push(`complete:${outcome.kind}`)
    return outcome.result
  }
}
const out2 = await dispatchInner({}, undefined, input, { ctor: ShortPipeline })
check('② post-result 短路 dispatch', trace2, ['prepare', 'complete:post-result'])
check('② 短路结果透传', out2, { isError: true, error: { message: 'denied' } })

// ③ final-result 同样短路
const trace3 = []
class FinalPipeline {
  async prepare() {
    trace3.push('prepare')
    return { kind: 'final-result', exec: { id: 'e3' }, result: { final: true } }
  }
  async dispatch() {
    trace3.push('dispatch')
  }
  async complete(exec, outcome) {
    trace3.push(`complete:${outcome.kind}`)
    return outcome.result
  }
}
const out3 = await dispatchInner({}, undefined, input, { ctor: FinalPipeline })
check('③ final-result 短路', trace3, ['prepare', 'complete:final-result'])
check('③ 结果透传', out3, { final: true })

// ④ 旧版回退：ctor 显式 null（模拟 0.2.1-rc.2 无 ./pipeline）→ 走单 exec execute
const calls = []
const out4 = await dispatchInner(
  {},
  { execute: async (i) => { calls.push(i); return { via: 'single-exec' } } },
  input,
  { ctor: null },
)
check('④ 回退单 exec 一次', calls.length, 1)
check('④ 回退输入原样（逐字节同旧路径）', calls[0], input)
check('④ 回退结果透传', out4, { via: 'single-exec' })

// ⑤ 既无 pipeline 也无 fallback → 显式失败（不静默丢调用）
let thrown = null
try {
  await dispatchInner({}, undefined, input, { ctor: null })
} catch (error) {
  thrown = error instanceof Error ? error.message : String(error)
}
check('⑤ 双缺失显式报错', typeof thrown === 'string' && thrown.includes('内层派发不可用'), true)

// ⑥ 真实加载：仓库钉的 dsh-tools(0.1.2-rc.1) 无 ./pipeline → undefined，且不得抛
resetInnerPipelineCache()
let loaded
try {
  loaded = await loadInnerPipeline()
} catch (error) {
  loaded = `threw: ${String(error)}`
}
check('⑥ 真实加载不抛（undefined 或函数）', loaded === undefined || typeof loaded === 'function', true)

console.log(failed === 0 ? '\nselftest-inner-exec: all ok' : `\nselftest-inner-exec: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
