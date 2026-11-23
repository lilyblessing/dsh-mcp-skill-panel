/**
 * selftest-ptc-mask：0.2.3-alpha.2「真隐藏」改动的单元自测。
 *
 * 覆盖：B′（definitions 遮蔽：scoped 过滤 / 全局放行 / dispose 还原）、
 *       A（tools:sdk 段重渲染：canary 不符 fail-open、无可隐藏项不动文本）、
 *       T2′（只治理 ':ptc:' 直调，mcp-call- 内层派发与其它内部派发放行）。
 *
 * 说明：A 的「成功剔除」路径在真机上由宿主与插件共用同一 definitions 源保证；
 * 这里只断言不变量（不改错、不误伤、可还原），真实剔除由部署后的会话日志探针验收。
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 默认打本仓 lib；dev 仓缺 peer（dsh-agent-preset-registry）时可用参数指向 .deploy 的 lib：
//   node scripts/selftest-ptc-mask.mjs ../.deploy/dsh-mcp-skill-panel/lib/index.js
const libArg = process.argv[2]
const libUrl = libArg ? pathToFileURL(resolve(libArg)).href : new URL('../lib/index.js', import.meta.url).href
const libAbs = fileURLToPath(libUrl)
const index = await import(libUrl)

const results = []
function check(name, fn) {
  try { fn(); results.push(`ok   ${name}`) } catch (error) { results.push(`FAIL ${name}: ${error?.message ?? error}`); failed = true }
}
let failed = false

function makeCtx(definitions) {
  const handlers = new Map()
  const ctx = {
    root: {
      on: (event, fn) => {
        const list = handlers.get(event) ?? []
        list.push(fn)
        handlers.set(event, list)
        return () => { handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== fn)) }
      },
    },
    effect: (fn) => fn(),
    logger: { warn: () => {} },
    tools: { definitions },
  }
  return { ctx, handlers }
}

async function runHandlers(handlers, event, value, context) {
  let current = value
  for (const handler of handlers.get(event) ?? []) {
    // 与 cordis waterfall 同形：next() 返回下游结果，处理器可原地改 current 后返回。
    current = await handler(current, context, async () => current)
  }
  return current
}

const mkDef = (name) => ({ name, description: `${name} desc`, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' } } })
const list = () => [mkDef('mcp__srv__x'), mkDef('mcp__open__y'), mkDef('read')]
const visibility = new Map([['srv', false], ['open', true]])
const gateFor = (agent) => ({ on: agent !== undefined, hideAll: false })
// 真 Agent 的最小形状：B′/A 只对带 session.requestHeader 的视图生效（见 filter.ts 注释）。
const agentView = { id: 'a', session: { requestHeader: () => undefined } }

// ── B′ ────────────────────────────────────────────────────────────────
{
  const original = list
  const { ctx } = makeCtx(() => original().slice())
  const before = ctx.tools.definitions
  const dispose = index.installMcpVisibilityFilter(ctx, () => visibility, gateFor, () => 'disabled')
  check('B′ 已安装（definitions 被替换）', () => assert.notEqual(ctx.tools.definitions, before))
  check('B′ scoped：隐藏 srv，保留 open/非 mcp', () => {
    const names = ctx.tools.definitions(agentView).map((d) => d.name)
    assert.deepEqual(names, ['mcp__open__y', 'read'])
  })
  check('B′ 全局视图（scope undefined）不过滤', () => {
    assert.equal(ctx.tools.definitions(undefined).length, 3)
  })
  check('B′ 非 Agent 视图（面板采集用的 scope key）不过滤', () => {
    assert.equal(ctx.tools.definitions({}).length, 3)
    assert.equal(ctx.tools.definitions(Object.create(null)).length, 3)
  })
  check('B′ Agent 视图：隐藏 srv', () => {
    const names = ctx.tools.definitions(agentView).map((d) => d.name)
    assert.ok(!names.includes('mcp__srv__x'))
  })
  dispose()
  check('B′ dispose 还原原型/清自有属性', () => assert.equal(ctx.tools.definitions, before))
}

// ── A ─────────────────────────────────────────────────────────────────
// 与产品代码同款解析：裸 specifier 失败 → createRequire 解析绝对路径再 import。
async function importMaybe(specifier) {
  // 先按**被测 lib** 的解析链取（与产品代码 loadSdkRenderer 同款）：部署目录的
  // @deepseek-ai 是 web profile 的 junction，dsh-tool-executor-ptc 只在 hoisted 层；
  // 且仓里的 dev 副本（0.1.2-rc.1）没有 projectToolSchema —— 裸 import 会拿到旧版。
  try {
    const { createRequire } = await import('node:module')
    return await import(pathToFileURL(createRequire(libAbs).resolve(specifier)).href)
  } catch {
    try { return await import(specifier) } catch { return null }
  }
}
const ptc = await importMaybe('@deepseek-ai/dsh-tool-executor-ptc')
const toolsMod = await importMaybe('@deepseek-ai/dsh-tools')
if (ptc?.renderToolsSdk && toolsMod?.projectToolSchema) {
  const render = (defs) => ptc.renderToolsSdk(defs.map((d) => ({ ...toolsMod.projectToolSchema(d, false), output: d.output?.schema })), 'function-body')

  {
    // canary 不符：宿主原文被人为改过 → 必须原样放行
    const { ctx, handlers } = makeCtx(() => list())
    const dispose = index.installMcpVisibilityFilter(ctx, () => visibility, gateFor, () => 'disabled')
    const tampered = render(list()) + '\n// tampered'
    const assembly = { sections: [{ name: 'tools:sdk', text: tampered }], tools: [] }
    const out = await runHandlers(handlers, 'system-prompt/assemble', assembly, { agent: agentView, scope: agentView })
    check('A canary 不符 → 段文本原样（fail-open）', () => assert.equal(out.sections[0].text, tampered))
    const status = index.sdkSectionMaskStatusForDebug()
    check('A canary 不符 → 状态标 inactive', () => assert.equal(status.active, false))
    dispose()
  }

  {
    // canary 相符且本步无可隐藏项（B′ 已过滤 → 宿主与插件同源）→ 文本不变
    const { ctx, handlers } = makeCtx(() => list())
    const dispose = index.installMcpVisibilityFilter(ctx, () => visibility, gateFor, () => 'disabled')
    const filtered = ctx.tools.definitions(agentView)
    const text = render(filtered)
    const assembly = { sections: [{ name: 'tools:sdk', text }], tools: [] }
    const out = await runHandlers(handlers, 'system-prompt/assemble', assembly, { agent: agentView, scope: agentView })
    check('A canary 相符且无隐藏项 → 文本逐字节不变', () => assert.equal(out.sections[0].text, text))
    check('A 状态 active', () => assert.equal(index.sdkSectionMaskStatusForDebug().active, true))
    dispose()
  }
} else {
  results.push('skip A 用例：渲染器不可解析（该环境无 @deepseek-ai/dsh-tool-executor-ptc）')
}

// ── A-2（mcp-resource-servers 名清单）──────────────────────────────────
{
  const prefix = '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: '
  const sectionText = (names) => prefix + JSON.stringify(names) + '.'
  const makeAssembly = (text) => ({ sections: [{ name: 'mcp-resource-servers', text }] })
  const run = async (handlers, assembly) => runHandlers(handlers, 'system-prompt/assemble', assembly, { agent: agentView, scope: agentView })

  {
    const { ctx, handlers } = makeCtx(() => list())
    const dispose = index.installMcpVisibilityFilter(ctx, () => visibility, (agent) => ({ on: agent !== undefined, hideAll: true }), () => 'all')
    const out = await run(handlers, makeAssembly(sectionText(['mcp__srv__x'.slice(0, 0) + 'obsidian', 'srv'])))
    check('A-2 hideAll → 名清单清空（空串，与宿主空集同形）', () => assert.equal(out.sections[0].text, ''))
    check('A-2 状态 active', () => assert.equal(index.mcpServersMaskStatusForDebug().active, true))
    dispose()
  }

  {
    const { ctx, handlers } = makeCtx(() => list())
    const dispose = index.installMcpVisibilityFilter(ctx, () => visibility, (agent) => ({ on: agent !== undefined, hideAll: false }), () => 'disabled')
    const out = await run(handlers, makeAssembly(sectionText(['open', 'srv'])))
    check('A-2 disabled 档：只留可见 server', () => assert.equal(out.sections[0].text, sectionText(['open'])))
    dispose()
  }

  {
    const { ctx, handlers } = makeCtx(() => list())
    const dispose = index.installMcpVisibilityFilter(ctx, () => visibility, (agent) => ({ on: agent !== undefined, hideAll: true }), () => 'all')
    const drifted = '## MCP resource servers\n\nUse the resource tools with these names: ["srv"].'
    const out = await run(handlers, makeAssembly(drifted))
    check('A-2 模板不符 → 原样放行（fail-open）', () => assert.equal(out.sections[0].text, drifted))
    dispose()
  }
}

// ── T2′ ───────────────────────────────────────────────────────────────
{
  const { ctx, handlers } = makeCtx(() => list())
  const dispose = index.installMcpVisibilityFilter(ctx, () => visibility, gateFor, () => 'disabled')
  const guard = (handlers.get('tools/pre-execute') ?? [])[0]
  assert.ok(guard, 'tools/pre-execute 守卫未注册')
  // 守卫的 next() 语义是「下游决定」，测试里以 {kind:'next'} 代表放行。
  const decide = (exec) => guard(exec, async () => ({ kind: 'next' }))
  const hidden = { name: 'mcp__srv__x', callId: 'call-1:ptc:0', agent: agentView }
  const inner = { name: 'mcp__srv__x', callId: 'mcp-call-1234', agent: agentView, parent: Symbol('p') }
  const other = { name: 'mcp__srv__x', callId: 'host-internal-1', agent: agentView, parent: Symbol('p') }
  const visible = { name: 'mcp__open__y', callId: 'call-1:ptc:1', agent: agentView }
  const nativeDirect = { name: 'mcp__srv__x', callId: 'chatcmpl-tool-77', agent: agentView }
  const dHidden = await decide(hidden)
  const dInner = await decide(inner)
  const dOther = await decide(other)
  const dVisible = await decide(visible)
  const dNative = await decide(nativeDirect)
  check('T2′ 模型 :ptc: 直调隐藏工具 → deny', () => assert.equal(dHidden.kind, 'deny'))
  check('T2′ 面板 mcp-call- 内层派发 → 放行', () => assert.equal(dInner.kind, 'next'))
  check('T2′ 其它内部派发（非 :ptc:）→ 放行', () => assert.equal(dOther.kind, 'next'))
  check('T2′ 可见工具直调 → 放行', () => assert.equal(dVisible.kind, 'next'))
  check('T2′ native 顶层直调隐藏工具 → deny（不因缺 :ptc: 漏拦）', () => assert.equal(dNative.kind, 'deny'))
  dispose()
}

for (const line of results) console.log(line)
if (failed) { console.log('selftest-ptc-mask: FAILED'); process.exit(1) }
console.log('selftest-ptc-mask: all ok')