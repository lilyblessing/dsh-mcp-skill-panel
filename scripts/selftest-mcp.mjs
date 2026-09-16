// 临时 Node 自测：验证 MCP 中间层控制的纯逻辑（构建产物 lib/*.js）。
// eslint-disable-next-line no-console
// 用法：node scripts/selftest-mcp.mjs （在包根目录运行）
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ── 宿主闭包回填（P0-3）─────────────────────────────────────────────────────
 * lib/index.js → @deepseek-ai/dsh-agent-presets 的 **peerDependencies** 里有三个
 * 本仓 devDependencies 未列、npm 安装也不会装的真实包：
 *   @deepseek-ai/dsh-home-paths / @deepseek-ai/cordis-plugin-include / @deepseek-ai/dsh-atomic-write
 * 缺它们时 import lib/index.js 直接 ERR_MODULE_NOT_FOUND → 全部断言零执行（本次修复的故障现场）。
 * 三个里只有 dsh-home-paths 是纯路径解析（可以零依赖等价），另两个是宿主真逻辑包 ——
 * 拿等价实现顶替等于自我欺骗，故改为**回填宿主真闭包**，口径与 scripts/deploy-link.mjs 一致
 * （默认 ~/.dsh/profiles/web/node_modules/@deepseek-ai，可用 DSH_HOST_SCOPE 覆盖）。
 * 只在本地解析失败时回填，故装机/完整安装环境下本段完全不介入。
 */
const HOST_SCOPE = (process.env.DSH_HOST_SCOPE ?? 'C:/Users/lily/.dsh/profiles/web/node_modules/@deepseek-ai').replace(/\\/g, '/')
const hostFilled = []
let hostScopeUsable = false
if (existsSync(HOST_SCOPE)) {
  const { createRequire, registerHooks } = await import('node:module')
  if (typeof registerHooks === 'function') {
    const hostRequire = createRequire(join(dirname(HOST_SCOPE), '__host_basis__.js'))
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context)
        } catch (error) {
          if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error
          const resolved = hostRequire.resolve(specifier)
          hostFilled.push(specifier)
          return { url: pathToFileURL(resolved).href, shortCircuit: true }
        }
      },
    })
    hostScopeUsable = true
  }
}

/** 宿主闭包不完整时硬失败：打印缺什么 + 怎么修，绝不静默跳过断言。 */
const loadHostDependent = async (url, label) => {
  try {
    return await import(url)
  } catch (error) {
    console.error('FATAL: 宿主闭包不完整，无法加载构建产物 —— 拒绝静默跳过（断言不执行即不算通过）。')
    console.error(`       产物：${label}`)
    console.error(`       原因：${error && error.message ? error.message : String(error)}`)
    console.error(`       宿主闭包：DSH_HOST_SCOPE=${HOST_SCOPE}（存在=${existsSync(HOST_SCOPE)}${existsSync(HOST_SCOPE) && !hostScopeUsable ? '，但当前 Node 无 module.registerHooks → 无法回填' : ''}）`)
    console.error('       修法：把缺失的 @deepseek-ai/* 宿主 peer 装进 devDependencies（并同步 package-lock.json），')
    console.error('             或用 DSH_HOST_SCOPE 指向宿主真闭包（装机侧 profiles/web/node_modules/@deepseek-ai）。')
    process.exit(1)
  }
}

const catalog = await import(pathToFileURL(join(root, 'lib', 'catalog.js')).href)
const index = await loadHostDependent(pathToFileURL(join(root, 'lib', 'index.js')).href, 'lib/index.js')
if (hostFilled.length > 0) {
  console.log(`NOTICE 宿主闭包回填 ${new Set(hostFilled).size} 个 devDep 缺口：${[...new Set(hostFilled)].join(', ')}（源自 ${HOST_SCOPE}）`)
}
const convert = await import(pathToFileURL(join(root, 'lib', 'mcp-convert.js')).href)
// 0.6.0：行级读数判定拆成零宿主依赖模块，纯逻辑护栏不再受宿主包解析环境影响。
const rowDisplayMod = await import(pathToFileURL(join(root, 'lib', 'row-display.js')).href)
// 0.6.0 会话透传：面板把「当前会话」拼进请求的纯逻辑（同样零宿主依赖，可直接 import）。
const sessionScope = await import(pathToFileURL(join(root, 'lib', 'session-scope.js')).href)

let failed = false
let passed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed = true
    console.log(`FAIL ${label}`)
    console.log(`     ${error && error.message ? error.message : String(error)}`)
  }
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed = true
    console.log(`FAIL ${label}`)
    console.log(`     ${error && error.message ? error.message : String(error)}`)
  }
}

// mcp_call 前缀归一化（2026-08-22 修补：双重前缀缺陷回归测试）
check('normalizeToolName：裸名原样透传', () => {
  assert.equal(index.normalizeToolName('exa', 'web_search_exa'), 'web_search_exa')
})
check('normalizeToolName：注册全名剥一次前缀', () => {
  assert.equal(index.normalizeToolName('exa', 'mcp__exa__web_search_exa'), 'web_search_exa')
})
check('normalizeToolName：双重前缀循环剥净（2026-08-22 缺陷）', () => {
  assert.equal(index.normalizeToolName('mimo-image', 'mcp__mimo-image__mcp__mimo-image__understand_image'), 'understand_image')
})
check('normalizeToolName：其他 server 注册全名快速失败', () => {
  assert.throws(() => index.normalizeToolName('exa', 'mcp__mimo-image__understand_image'), /裸名/)
})

// mcp_call arguments 归一化 + 错误呈现（2026-08-24 修补：参数双编码与 [object Object] 缺陷回归）
check('normalizeArguments：对象原样透传（同引用）', () => {
  const input = { path: 'a.md', n: 1 }
  assert.equal(index.normalizeArguments(input), input)
})
check('normalizeArguments：单层 JSON 字符串解析为对象', () => {
  assert.deepEqual(index.normalizeArguments('{"path": "README.md"}'), { path: 'README.md' })
})
check('normalizeArguments：双编码字符串循环剥净（2026-08-24 实测缺陷形态）', () => {
  const once = JSON.stringify({ path: 'README.md' })
  assert.deepEqual(index.normalizeArguments(JSON.stringify(once)), { path: 'README.md' })
})
check('normalizeArguments：数组形态 JSON 也接受', () => {
  assert.deepEqual(index.normalizeArguments('[1,2]'), [1, 2])
})
check('normalizeArguments：非法/普通字符串保留原值交由远端报错', () => {
  assert.equal(index.normalizeArguments('{bad json'), '{bad json')
  assert.equal(index.normalizeArguments('plain text'), 'plain text')
})
check('normalizeArguments：null/undefined/空白串归一为空对象', () => {
  assert.deepEqual(index.normalizeArguments(undefined), {})
  assert.deepEqual(index.normalizeArguments(null), {})
  assert.deepEqual(index.normalizeArguments('   '), {})
})
check('normalizeArguments：超过 3 层编码不再继续剥离（防失控）', () => {
  let v = { deep: 1 }
  for (let i = 0; i < 5; i++) v = JSON.stringify(v)
  assert.equal(typeof index.normalizeArguments(v), 'string')
})

check('msgOf：Error 取 message；普通对象输出 JSON 文本而非 [object Object]（2026-08-24 缺陷）', () => {
  assert.equal(index.msgOf(new Error('boom')), 'boom')
  const rendered = index.msgOf({ code: -32602, message: 'missing required path' })
  assert.ok(rendered.includes('missing required path'))
  assert.ok(!rendered.includes('[object Object]'))
  assert.equal(index.msgOf('plain'), 'plain')
})

const schemas = [
  { name: 'mcp__cheatengine__read_memory', description: '读取游戏进程内存', parameters: { type: 'object', properties: { addr: { type: 'string' } }, required: ['addr'] } },
  { name: 'mcp__cheatengine__write_memory', description: '写入游戏进程内存', parameters: { type: 'object', properties: { addr: { type: 'string' }, value: { type: 'integer' } } } },
  { name: 'mcp__calcmcp__integrate', description: '数值积分', parameters: { type: 'object', properties: { expression: { type: 'string' } } } },
  { name: 'mcp__calcmcp__eigenvalues', description: '矩阵特征值', parameters: { type: 'object', properties: { matrix_a: { type: 'string' } } } },
  { name: 'ssh_exec', description: '远程执行命令（非 MCP）' },
  { name: 'mcp__chrome__navigate', description: '导航到 URL', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
]

check('snapshotFromSchemas 只取该 server 前缀', () => {
  const ce = catalog.snapshotFromSchemas(schemas, 'cheatengine')
  assert.equal(ce.length, 2)
  assert.deepEqual(ce.map((t) => t.name), ['mcp__cheatengine__read_memory', 'mcp__cheatengine__write_memory'])
  assert.equal(ce[0].description, '读取游戏进程内存')
  assert.ok(ce[0].parameters && typeof ce[0].parameters === 'object')
  // 空 server
  assert.equal(catalog.snapshotFromSchemas(schemas, 'ghost').length, 0)
})

const buildCatalog = () => {
  const known = ['cheatengine', 'calcmcp', 'chrome']
  const c = {}
  for (const server of known) {
    c[server] = { tools: catalog.snapshotFromSchemas(schemas, server), fetchedAt: 1, source: 'live' }
  }
  return c
}

check('searchCatalog 打分排序（P3 加权 B：裸名 substring 15/描述 6/参数 3/server 3/兜底 1）', () => {
  const c = buildCatalog()
  // "integ" 命中 mcp__calcmcp__integrate 裸名 substring（15 + 兜底 1）
  const hits = catalog.searchCatalog(c, 'integ')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].server, 'calcmcp')
  assert.equal(hits[0].tool.name, 'mcp__calcmcp__integrate')
  // 中文连写 substring 命中（P3：描述原文 substring，不切分）
  const cnHits = catalog.searchCatalog(c, '读取游戏')
  assert.ok(cnHits.length >= 1)
  assert.equal(cnHits[0].tool.name, 'mcp__cheatengine__read_memory')
  // 无命中时为空
  assert.equal(catalog.searchCatalog(c, 'zzzznope').length, 0)
})

check('searchCatalog 参数名命中权重（P3：参数名 substring 3 分）', () => {
  const c = buildCatalog()
  // "addr" 是多个工具的参数名；权重 1 但应命中
  const hits = catalog.searchCatalog(c, 'addr', 5)
  assert.ok(hits.length > 0)
  assert.ok(hits.every((h) => ['read_memory', 'write_memory'].includes(h.tool.name.split('__').pop())))
})

check('searchCatalog 空 query 返回空；limit 被尊重（P3 缺省 8）', () => {
  const c = buildCatalog()
  assert.equal(catalog.searchCatalog(c, '').length, 0)
  assert.ok(catalog.searchCatalog(c, 'memory', 1).length <= 1)
  // topK 显式优先语义（W4）：searchCatalog limit 直传即 topK
  assert.ok(catalog.searchCatalog(c, 'read write navigate integ matrix addr url', 2).length <= 2)
})

check('listServer 分页上限钳制 200（W4）', () => {
  const c = buildCatalog()
  const page = catalog.listServer(c, 'chrome', 0, 9999)
  assert.ok(page.tools.length <= 200)
  assert.equal(page.totalCount, 1)
})

check('listServer 返回精简名+描述；未知 server found:false 信封；分页 offset/limit（P3）', () => {
  const c = buildCatalog()
  const chrome = catalog.listServer(c, 'chrome')
  assert.ok(chrome)
  assert.equal(chrome.totalCount, 1)
  assert.equal(chrome.tools.length, 1)
  assert.equal(chrome.tools[0].name, 'mcp__chrome__navigate')
  assert.equal(chrome.tools[0].description, '导航到 URL')
  // 未知 server：现契约是 found:false 信封（不再返回 undefined）
  const miss = catalog.listServer(c, 'nope')
  assert.equal(miss.found, false)
  assert.equal(miss.hasSnapshot, false)
  assert.deepEqual(miss.tools, [])
  assert.equal(miss.totalCount, 0)
  // P3 分页：超界 offset 返回空页但 totalCount 保留
  const page = catalog.listServer(c, 'chrome', 10, 20)
  assert.equal(page.totalCount, 1)
  assert.equal(page.tools.length, 0)
})

check('serverOfMcp 解析 server 名', () => {
  assert.equal(catalog.serverOfMcp('mcp__cheatengine__read_memory'), 'cheatengine')
  assert.equal(catalog.serverOfMcp('ssh_exec'), null)
  assert.equal(catalog.serverOfMcp('mcp__chrome__navigate'), 'chrome')
})

// 持久化往返：临时目录
await checkAsync('catalog 持久化往返（临时目录）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-selftest-'))
  try {
    const c = buildCatalog()
    await catalog.saveCatalog(dir, c)
    const loaded = await catalog.loadCatalog(dir)
    assert.deepEqual(Object.keys(loaded).sort(), Object.keys(c).sort())
    assert.deepEqual(loaded.cheatengine.tools.map((t) => t.name), c.cheatengine.tools.map((t) => t.name))
    assert.equal(loaded.chrome.tools[0].description, '导航到 URL')
    assert.equal(loaded.calcmcp.fetchedAt, undefined || 1 || loaded.calcmcp.fetchedAt) // 字段存在即可
    // 原子写：不应留下 tmp 文件
    assert.throws(() => readFileSync(join(dir, 'catalog.json.tmp'), 'utf8'))
    // 文件确实存在
    readFileSync(join(dir, 'catalog.json'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('loadCatalog 缺失目录返回空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-selftest-'))
  try {
    const loaded = await catalog.loadCatalog(dir)
    assert.deepEqual(loaded, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// setRowFlag 不动（回归护栏）
check('setRowFlag 行为不变', () => {
  const text = '- id: a\n  name: x\n- id: b\n  name: y\n'
  const withFlag = index.setRowFlag(text, 'a', 'disabled', true)
  assert.ok(withFlag.includes('  disabled: true'))
  assert.ok(withFlag.includes('- id: a'))
  const back = index.setRowFlag(withFlag, 'a', 'disabled', false)
  assert.equal(back, text)
  // 未知行抛错
  assert.throws(() => index.setRowFlag(text, 'zzz', 'disabled', true))
})

check('setRowFlag：已有 disabled: false 时置 true 必须反转（2026-08-27 obsidian 设置丢失事故回归）', () => {
  // preset 原文 obsidian 行自带 disabled: false，用户面板关闭（desired=true）
  const text = '- id: mcp-obsidian\n  disabled: false\n'
  const out = index.setRowFlag(text, 'mcp-obsidian', 'disabled', true)
  assert.notEqual(out, text, 'must not be a no-op')
  assert.ok(out.includes('  disabled: true'), out)
  assert.ok(!out.includes('disabled: false'), out)
  assert.equal(index.rowDisabledState(out, 'mcp-obsidian'), true)
  // 幂等：已是 true 再置 true 不变
  assert.equal(index.setRowFlag(out, 'mcp-obsidian', 'disabled', true), out)
  // 反转后再移除 → 回到无标记
  const removed = index.setRowFlag(out, 'mcp-obsidian', 'disabled', false)
  assert.ok(!removed.includes('disabled: true'))
  assert.equal(index.rowDisabledState(removed, 'mcp-obsidian'), null)
})

check('mergeSchemas：agent scope ∪ 全局视图，按 name 去重不重复计数（filesystem 无工具事故回归）', () => {
  const scoped = [
    { name: 'mcp__calcmcp__add', description: 'a' },
    { name: 'mcp__calcmcp__sub', description: 'b' },
  ]
  const globalView = [
    { name: 'mcp__filesystem__read_text_file', description: 'fs' },
    { name: 'mcp__calcmcp__add', description: 'dup-scoped' }, // 与 scoped 重名 → 丢弃
  ]
  const merged = index.mergeSchemas(scoped, globalView)
  assert.equal(merged.length, 3, 'scoped 2 + global 新增 1（重名去重）')
  assert.ok(merged.some((s) => s.name === 'mcp__filesystem__read_text_file'), '全局视图工具应并入')
  assert.equal(merged.filter((s) => s.name === 'mcp__calcmcp__add').length, 1, '重名只保留 scoped 一份')
  // 无全局视图 → 原样返回
  assert.equal(index.mergeSchemas(scoped, []), scoped)
})

check('computeStatus：表驱动四态（active 以 liveTools 真实注册为准，catalog 快照不参与）', () => {
  const cases = [
    // [disabled, running, liveTools, expected]
    [false, true, 14, 'active'],   // 启用 + 注册工具 → active
    [false, true, 0, 'idle'],      // 启用 + 无注册（catalog 有旧快照也判 idle，防掩盖故障现场）
    [true, true, 14, 'disabled'],  // 停用优先
    [true, false, 14, 'disabled'],
    [false, false, 0, 'failed'],   // 未运行
    [false, false, 14, 'failed'],
  ]
  for (const [disabled, running, liveTools, expected] of cases) {
    const got = rowDisplayMod.computeStatus(disabled, running, liveTools)
    assert.equal(got, expected, `computeStatus(${disabled}, ${running}, ${liveTools}) -> ${got}, expected ${expected}`)
  }
})

check('rowDisplay：诚实上报（0.6.0）—— 启用+在跑却零注册时不再回落目录快照', () => {
  const cases = [
    // [disabled, running, liveTools, catalogTools, expectedTools, expectedUnregistered]
    [false, true, 4, 4, 4, false],    // 真注册 → 用真值
    [false, true, 0, 4, 0, true],     // 启用+在跑+零注册 → 0 且标未注册（本次修复的故障现场）
    [false, false, 0, 4, 4, false],   // 未运行（刚要开/已崩成无 fiber）→ 快照仍可展示
    [true, false, 0, 27, 27, false],  // 停用 → 回落快照（mcp_search 仍可检索）
    [true, true, 0, 27, 27, false],   // 停用但有残留 fiber → 仍是停用语义
    [false, true, 0, 0, 0, true],     // 无快照 + 零注册 → 0
  ]
  for (const [disabled, running, liveTools, catalogTools, tools, unregistered] of cases) {
    const got = rowDisplayMod.rowDisplay(disabled, running, liveTools, catalogTools)
    assert.equal(got.displayTools, tools, `rowDisplay(${disabled}, ${running}, ${liveTools}, ${catalogTools}).displayTools -> ${got.displayTools}, expected ${tools}`)
    assert.equal(got.unregistered, unregistered, `rowDisplay(${disabled}, ${running}, ${liveTools}, ${catalogTools}).unregistered -> ${got.unregistered}, expected ${unregistered}`)
  }
})

// 0.6.0 收口（发布前独立审查 cbc-W1）：行徽标的「模型可见」必须与装配结果一致 ——
// hideAll 生效时工具被整条剔除（filter.ts 的 `gate.on && gate.hideAll`），此时只能说
// 「经中间层取用」，不能说「模型可见」。纯函数表驱动，防回归。
check('modelVisibleScope：hideAll 生效时不得再宣称「模型可见」（cbc-W1）', () => {
  const cases = [
    // [disabled, aiOwned, hideAllActive, expectedScope, expectedModelVisible]
    [false, false, false, 'direct', true],              // 常规直连
    [false, false, true, 'via-middle-layer', false],    // 本次修复的假声明现场
    [true, false, false, 'hidden', false],              // 停用行
    [true, false, true, 'hidden', false],               // 停用 + hideAll
    [false, true, false, 'hidden', false],              // AI 临时启用保活（对模型不可见）
    [false, true, true, 'hidden', false],               // AI 临时启用 + hideAll
  ]
  for (const [disabled, aiOwned, hideAllActive, scope, modelVisible] of cases) {
    const got = rowDisplayMod.modelVisibleScope(disabled, aiOwned, hideAllActive)
    assert.equal(
      got,
      scope,
      `modelVisibleScope(${disabled}, ${aiOwned}, ${hideAllActive}) -> ${got}, expected ${scope}`,
    )
    // modelVisible 必须恒等于 scope === 'direct'（面板与 API 的单一判据）
    assert.equal(got === 'direct', modelVisible, `scope=${got} 时 modelVisible 应为 ${modelVisible}`)
  }
})

// setSkillFlag / rowDisabledState（可维护性批次 P1-1 拆出 preset.ts 后的回归护栏）
check('setSkillFlag 注入/移除 + rowDisabledState 读取', () => {
  const text = '---\ntags:\n  - a\n---\n# title\n'
  const withFlag = index.setSkillFlag(text, true)
  assert.ok(withFlag.includes('disable-model-invocation: true'))
  const back = index.setSkillFlag(withFlag, false)
  assert.ok(!back.includes('disable-model-invocation'))
  assert.equal(back, text)

  const comp = '- id: mcp-a\n  name: "@deepseek-ai/dsh-mcp-client"\n  disabled: true\n  config:\n    serverName: aaa\n- id: b\n'
  assert.equal(index.rowDisabledState(comp, 'mcp-a'), true)
  assert.equal(index.rowDisabledState(comp, 'b'), null)
  assert.equal(index.rowDisabledState('- id: c\n  name: x\n', 'c'), null)
})

// Config schema 含 autoManage 相关字段（构建产物可被实例化）
check('index.Config schema 存在（schemastery Schema）且 inject 含 systemPrompt/timer', () => {
  assert.ok(index.Config) // schemastery Schema 是函数形式
  assert.ok(index.inject.includes('systemPrompt'))
  assert.ok(index.inject.includes('timer'))
})

// ── mcp-convert：mcpServers JSON → dsh-mcp-client 行（快速迁移转换器） ──────────
check('parseMcpServersJson：stdio（command+args）', () => {
  const { servers, errors } = convert.parseMcpServersJson(JSON.stringify({
    mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } },
  }))
  assert.equal(errors.length, 0)
  const s = servers.codegraph
  assert.equal(s.transport, 'stdio')
  assert.equal(s.command, 'codegraph')
  assert.deepEqual(s.args, ['serve', '--mcp'])
})

check('parseMcpServersJson：http（url+headers 含 ${VAR}）', () => {
  const { servers, errors } = convert.parseMcpServersJson(JSON.stringify({
    mcpServers: { anysearch: { url: 'https://api.anysearch.com/mcp', headers: { Authorization: 'Bearer ${ANYSEARCH_API_KEY}' } } },
  }))
  assert.equal(errors.length, 0)
  const s = servers.anysearch
  assert.equal(s.transport, 'streamable-http')
  assert.equal(s.url, 'https://api.anysearch.com/mcp')
  assert.equal(s.headers.Authorization, 'Bearer ${ANYSEARCH_API_KEY}')
})

check('parseMcpServersJson：兼容 type/transport 显式声明', () => {
  const a = convert.parseMcpServersJson(JSON.stringify({ mcpServers: { x: { type: 'stdio', command: 'a' } } })).servers.x
  assert.equal(a.transport, 'stdio')
  const b = convert.parseMcpServersJson(JSON.stringify({ mcpServers: { y: { transport: 'http', url: 'u' } } })).servers.y
  assert.equal(b.transport, 'streamable-http')
})

check('parseMcpServersJson：接受裸 mcpServers 映射（无外层包裹）', () => {
  const { servers, errors } = convert.parseMcpServersJson(JSON.stringify({ github: { command: 'gh' } }))
  assert.equal(errors.length, 0)
  assert.equal(servers.github.transport, 'stdio')
})

check('parseMcpServersJson：坏 JSON / 非法 serverName / 无法推断传输 → 报错不崩溃', () => {
  assert.ok(convert.parseMcpServersJson('{bad').errors.length > 0)
  const badName = convert.parseMcpServersJson(JSON.stringify({ 'my server!': { command: 'x' } }))
  assert.ok(badName.errors.length > 0)
  assert.equal(badName.servers['my server!'], undefined)
  const noTransport = convert.parseMcpServersJson(JSON.stringify({ z: { port: 123 } }))
  assert.ok(noTransport.errors.length > 0)
})

check('hasEnvRef / toJsTemplate / resolveEnvRefs', () => {
  assert.ok(convert.hasEnvRef('Bearer ${ANYSEARCH_API_KEY}'))
  assert.ok(!convert.hasEnvRef('plain text'))
  assert.equal(convert.toJsTemplate('Bearer ${ANYSEARCH_API_KEY}'), '`Bearer ${process.env.ANYSEARCH_API_KEY}`')
  process.env.__DSH_TEST_TOKEN = 'tok-123'
  assert.equal(convert.resolveEnvRefs('Bearer ${__DSH_TEST_TOKEN}'), 'Bearer tok-123')
  delete process.env.__DSH_TEST_TOKEN
  // 缺失的保留占位符原样
  assert.equal(convert.resolveEnvRefs('Bearer ${NOPE_NOPE}'), 'Bearer ${NOPE_NOPE}')
})

check('serversToRows：id 前缀 + dsh-mcp-client 名称 + config 形状', () => {
  const rows = convert.serversToRows({
    codegraph: { serverName: 'codegraph', transport: 'stdio', command: 'codegraph', args: ['a'], env: { K: 'v' } },
    anysearch: { serverName: 'anysearch', transport: 'streamable-http', url: 'u', headers: { Authorization: 'Bearer ${X}' } },
  })
  assert.equal(rows.length, 2)
  const cg = rows.find((r) => r.id === 'mcp-codegraph')
  assert.equal(cg.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(cg.config.transport, 'stdio')
  assert.equal(cg.config.command, 'codegraph')
  assert.deepEqual(cg.config.args, ['a'])
  const as = rows.find((r) => r.id === 'mcp-anysearch')
  assert.equal(as.config.transport, 'streamable-http')
  assert.equal(as.config.url, 'u')
  // 自定义前缀
  assert.equal(convert.serversToRows({ c: { serverName: 'c', transport: 'stdio', command: 'x' } }, 'projmcp-abc')[0].id, 'projmcp-abc-c')
})

check('serversToPatchYaml：生成 - insert: 块且 ${VAR} → !!js 表达式', () => {
  const yaml = convert.serversToPatchYaml({
    anysearch: { serverName: 'anysearch', transport: 'streamable-http', url: 'https://api.anysearch.com/mcp', headers: { Authorization: 'Bearer ${ANYSEARCH_API_KEY}' } },
    plain: { serverName: 'plain', transport: 'stdio', command: 'echo', args: ['hi'] },
  })
  assert.ok(yaml.includes('- insert:'))
  assert.ok(yaml.includes("id: mcp-anysearch"))
  assert.ok(yaml.includes("name: '@deepseek-ai/dsh-mcp-client'"))
  // 环境变量插值 → !!js 模板表达式（loader 加载时求值）
  assert.ok(yaml.includes("!!js '`Bearer ${process.env.ANYSEARCH_API_KEY}`'"))
  // 无插值的普通字符串保持 JSON 引号形式
  assert.ok(yaml.includes('command: "echo"'))
  assert.ok(yaml.includes('  - "hi"'))
  // 每段 - insert: 块结构完整（两个 server 两段）
  assert.equal(yaml.split('- insert:').length - 1, 2)
})

check('parseMcpServersJson：非字符串 env/headers 值 → 字符串转换 + warnings（不再静默丢弃）', () => {
  const { servers, errors, warnings } = convert.parseMcpServersJson(
    JSON.stringify({
      mcpServers: {
        demo: { command: 'demo', args: [1, 'ok'], env: { PORT: 3000, TOKEN: { bad: 1 }, OK: 'yes' } },
      },
    }),
  )
  assert.equal(errors.length, 0)
  assert.equal(servers.demo.env.PORT, '3000')
  assert.equal(servers.demo.env.OK, 'yes')
  assert.deepEqual(servers.demo.args, ['1', 'ok'])
  assert.ok(warnings.length >= 2, `expected >=2 warnings, got ${warnings.length}`)
  assert.ok(warnings.some((w) => w.includes('PORT')))
  assert.ok(warnings.some((w) => w.includes('TOKEN')))
})

check('toJsTemplate：单引号转义 \\\'，经 YAML 单引号标量翻倍后往返还原（不丢/多引号）', () => {
  // toJsTemplate 输出 JS 转义 \'  → YAML !!js '...' 包装时 '' 翻倍 → YAML 解析回 \' → JS 求值还原 '
  const template = convert.toJsTemplate("a'b ${VAR}")
  assert.ok(template.includes("a\\'b ${process.env.VAR}"), template)
  const yaml = convert.serversToPatchYaml({
    q: { serverName: 'q', transport: 'stdio', command: 'echo', env: { K: "a'b ${VAR}" } },
  })
  // YAML 单引号标量中 '' 是字面 ' 的转义；\ 保持原样 → 最终 JS 表达式含 \'（合法转义）
  assert.ok(yaml.includes("!!js '`a\\''b ${process.env.VAR}`'"), 'yaml scalar keeps escaped quote')
})

// ── project-mcp：工作空间 .dsh/mcps 扫描（根目录先读、子目录覆盖去重） ──────────
await checkAsync('scanWorkspaceMcp：根目录 + 子目录都读，子目录覆盖根目录同名 server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-scan-'))
  try {
    const mk = await import('node:fs/promises')
    // 根目录 mcp.json：codegraph（根）+ anysearch
    await mk.mkdir(join(dir, '.dsh', 'mcps'), { recursive: true })
    await mk.writeFile(
      join(dir, '.dsh', 'mcps', 'mcp.json'),
      JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph-root' }, anysearch: { url: 'http://root' } } }),
    )
    // 子目录 a：覆盖 codegraph（command 变 codegraph-sub）+ 新增 github
    await mk.mkdir(join(dir, '.dsh', 'mcps', 'a'), { recursive: true })
    await mk.writeFile(
      join(dir, '.dsh', 'mcps', 'a', 'mcp.json'),
      JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph-sub' }, github: { command: 'gh' } } }),
    )
    // 子目录 b：新增 exa
    await mk.mkdir(join(dir, '.dsh', 'mcps', 'b'), { recursive: true })
    await mk.writeFile(join(dir, '.dsh', 'mcps', 'b', 'mcp.json'), JSON.stringify({ mcpServers: { exa: { url: 'http://exa' } } }))

    const warnings = []
    const servers = await index.scanWorkspaceMcp(dir, (msg) => warnings.push(msg))
    // 三个来源的 server 都在（根 2 + 子 a 2 + 子 b 1 = 4 个去重后）
    assert.deepEqual(Object.keys(servers).sort(), ['anysearch', 'codegraph', 'exa', 'github'])
    // 子目录覆盖根目录：codegraph 用子目录 a 的 command
    assert.equal(servers.codegraph.command, 'codegraph-sub')
    assert.equal(servers.codegraph.transport, 'stdio')
    // 根目录保留未被覆盖的
    assert.equal(servers.anysearch.url, 'http://root')
    assert.equal(warnings.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('scanWorkspaceMcp：无 .dsh/mcps 目录 → 空；坏 JSON 跳过并告警', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-scan-'))
  try {
    // 无目录 → 空
    assert.deepEqual(await index.scanWorkspaceMcp(dir), {})
    // 坏 JSON → 跳过 + warn
    const mk = await import('node:fs/promises')
    await mk.mkdir(join(dir, '.dsh', 'mcps'), { recursive: true })
    await mk.writeFile(join(dir, '.dsh', 'mcps', 'mcp.json'), '{bad json')
    const warnings = []
    const servers = await index.scanWorkspaceMcp(dir, (msg) => warnings.push(msg))
    assert.deepEqual(servers, {})
    assert.ok(warnings.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── add-skill：buildSkillMd / isValidSkillName（创建技能的纯逻辑） ───────────────
check('isValidSkillName：kebab-case 合法/非法', () => {
  assert.ok(index.isValidSkillName('codemap'))
  assert.ok(index.isValidSkillName('my-skill-2'))
  assert.ok(!index.isValidSkillName('MySkill'))
  assert.ok(!index.isValidSkillName('my skill'))
  assert.ok(!index.isValidSkillName('-lead'))
  assert.ok(!index.isValidSkillName('trail-'))
  assert.ok(!index.isValidSkillName(''))
})

check('buildSkillMd：frontmatter + 正文；description 含冒号/引号安全；setSkillFlag 可再注入', () => {
  const md = index.buildSkillMd('codemap', '当用户询问 "项目结构" 或 file: 关系时', '# codemap\n## Commands\n正文')
  assert.ok(md.startsWith('---\nname: codemap\n'))
  assert.ok(md.includes('description: "当用户询问 \\"项目结构\\" 或 file: 关系时"'))
  assert.ok(md.includes('## Commands'))
  assert.ok(md.endsWith('正文\n'))
  // 与既有 setSkillFlag 组合：停用标记可注入/移除且往返一致
  const disabled = index.setSkillFlag(md, true)
  assert.ok(disabled.includes('disable-model-invocation: true'))
  assert.equal(index.setSkillFlag(disabled, false), md)
})

// ── 工具级禁用作用域：全局（跨工作区） vs 项目（仅所属工作区，需 owner 注册） ─────────
await checkAsync('setToolDisabled / isToolDisabled：全局禁用无条件生效（persist=false 只动内存）', async () => {
  await index.loadDisabledTools()
  await index.setToolDisabled('globalsrv', 'mcp__globalsrv__ping', true, false)
  assert.ok(index.isToolDisabled('mcp__globalsrv__ping', 'C:\\ws-a'))
  assert.ok(index.isToolDisabled('mcp__globalsrv__ping', 'C:\\ws-b'))
  assert.ok(index.isToolDisabled('mcp__globalsrv__ping'))
  assert.ok(index.disabledToolsOf('globalsrv').has('mcp__globalsrv__ping'))
  // 恢复：不影响后续用例
  await index.setToolDisabled('globalsrv', 'mcp__globalsrv__ping', false, false)
  assert.ok(!index.isToolDisabled('mcp__globalsrv__ping'))
})

await checkAsync('setToolDisabled：未注册 owner 的 server 视为全局（查询走全局表）', async () => {
  await index.loadDisabledTools()
  await index.setToolDisabled('projsrv', 'mcp__projsrv__x', true, false)
  assert.ok(index.isToolDisabled('mcp__projsrv__x', 'C:\\ws-a'))
  await index.setToolDisabled('projsrv', 'mcp__projsrv__x', false, false)
  assert.ok(!index.isToolDisabled('mcp__projsrv__x'))
})

// ── 工具级批量禁用（setToolsDisabledBulk：一次读-改-写，与单点同表同源） ─────────
// persist=false 只动内存：用例不碰 ~/.dsh/dsh-mcp-skill-panel/state.json
await checkAsync('setToolsDisabledBulk：一次禁用整组，再整组启用（persist=false 只动内存）', async () => {
  const names = ['mcp__bulk__a', 'mcp__bulk__b', 'mcp__bulk__c']
  const changed = await index.setToolsDisabledBulk('bulk', names, true, false)
  assert.equal(changed, 3)
  for (const name of names) assert.equal(index.isToolDisabled(name), true)
  const back = await index.setToolsDisabledBulk('bulk', names, false, false)
  assert.equal(back, 3)
  for (const name of names) assert.equal(index.isToolDisabled(name), false)
})

await checkAsync('setToolsDisabledBulk：忽略其他 server 的全名，不污染禁用表', async () => {
  const changed = await index.setToolsDisabledBulk('bulk2', ['mcp__other__x', 'mcp__bulk2__y'], true, false)
  assert.equal(changed, 1)
  assert.equal(index.isToolDisabled('mcp__other__x'), false)
  assert.equal(index.isToolDisabled('mcp__bulk2__y'), true)
  await index.setToolsDisabledBulk('bulk2', ['mcp__bulk2__y'], false, false)
})

await checkAsync('setToolsDisabledBulk：重复名去重，批量与单点开关可交替', async () => {
  await index.setToolDisabled('bulk3', 'mcp__bulk3__a', true, false)
  // a 已禁用：整组禁用只新增 b，changed 反映集合实际增量
  const changed = await index.setToolsDisabledBulk('bulk3', ['mcp__bulk3__a', 'mcp__bulk3__a', 'mcp__bulk3__b'], true, false)
  assert.equal(changed, 1)
  assert.equal(index.disabledToolsOf('bulk3').size, 2)
  await index.setToolsDisabledBulk('bulk3', ['mcp__bulk3__a', 'mcp__bulk3__b'], false, false)
  assert.equal(index.disabledToolsOf('bulk3').size, 0)
})

// E1：changed 是「本次实际翻转条数」，面板据此报「已改动 N 条」——no-op 必须记 0
await checkAsync('setToolsDisabledBulk：changed = 实际翻转条数（重复禁用为 no-op 记 0）', async () => {
  const names = ['mcp__bulka__a', 'mcp__bulka__b']
  assert.equal(await index.setToolsDisabledBulk('bulka', names, true, false), 2)
  assert.equal(await index.setToolsDisabledBulk('bulka', names, true, false), 0)
  assert.equal(await index.setToolsDisabledBulk('bulka', [...names, 'mcp__bulka__c'], true, false), 1)
  assert.equal(index.disabledToolsOf('bulka').size, 3)
  assert.equal(await index.setToolsDisabledBulk('bulka', [...names, 'mcp__bulka__c'], false, false), 3)
  assert.equal(index.disabledToolsOf('bulka').size, 0)
})

// E2：scope 分派必须与 setToolDisabled 同源（同一张表、同一 projectServerOwner 判据），
// 否则「批量禁用 → 单点启用」会各自看不见对方，留下永不生效的幽灵条目。
await checkAsync('setToolsDisabledBulk：与单点开关同表同源（未注册 owner → 全局表，可任意交替）', async () => {
  assert.equal(index.projectServerOwner('bulk-src'), undefined)
  await index.setToolsDisabledBulk('bulk-src', ['mcp__bulk-src__a', 'mcp__bulk-src__b'], true, false)
  assert.ok(index.disabledToolsOf('bulk-src').has('mcp__bulk-src__a'))
  assert.ok(index.isToolDisabled('mcp__bulk-src__a', 'C:\\ws-a'))
  // 单点启用其中一条：批量入口看到的同一张表必须同步少一条
  await index.setToolDisabled('bulk-src', 'mcp__bulk-src__a', false, false)
  assert.equal(index.disabledToolsOf('bulk-src').size, 1)
  assert.ok(!index.isToolDisabled('mcp__bulk-src__a'))
  await index.setToolsDisabledBulk('bulk-src', ['mcp__bulk-src__b'], false, false)
  assert.equal(index.disabledToolsOf('bulk-src').size, 0)
})

// ── G1 三态解析（审查 BLOCK-1 回归护栏）：/mcp/toolBulk 的 toolNames 语义 ─────────
// 只有 undefined 表示「全部」；显式数组一律精确执行（[] = 合法空操作）；
// 非数组 / 非空却 0 命中 → 拒绝。此前「非空数组 ? 交集 : 全部」会把 [] 变成全量禁用。
const BULK_KNOWN = ['mcp__s__a', 'mcp__s__b', 'mcp__s__c']

check('resolveToolBulkTargets：字段缺失 = 全部工具（唯一表示「全部」的形态）', () => {
  assert.deepEqual(index.resolveToolBulkTargets(BULK_KNOWN, undefined), {
    targets: ['mcp__s__a', 'mcp__s__b', 'mcp__s__c'],
    ignored: [],
  })
})

check('resolveToolBulkTargets：显式 [] = 合法空操作（绝不落进「全部」分支）', () => {
  const r = index.resolveToolBulkTargets(BULK_KNOWN, [])
  assert.deepEqual(r, { targets: [], ignored: [] })
  // BLOCK-1 原缺陷形态：结果长度等于 known 全长即「全部」——空操作必须不是它
  assert.notEqual(r.targets.length, BULK_KNOWN.length)
})

check('resolveToolBulkTargets：非空数组与 known 求交（known 序 + 去重），未识别项入 ignored', () => {
  assert.deepEqual(
    index.resolveToolBulkTargets(BULK_KNOWN, ['mcp__s__c', 'mcp__s__a', 'mcp__s__a']),
    { targets: ['mcp__s__a', 'mcp__s__c'], ignored: [] },
  )
  // WARN-1：给了 3 个只认识 1 个 → 另 2 个必须可见，不能静默丢弃
  assert.deepEqual(
    index.resolveToolBulkTargets(BULK_KNOWN, ['mcp__s__b', 'mcp__other__x', 'bare_name']),
    { targets: ['mcp__s__b'], ignored: ['mcp__other__x', 'bare_name'] },
  )
})

check('resolveToolBulkTargets：非空数组但 0 命中 → 报错（不静默 no-op）', () => {
  for (const names of [['mcp__other__x'], ['bare_name', 'mcp__zzz__t']]) {
    const r = index.resolveToolBulkTargets(BULK_KNOWN, names)
    assert.ok(r.error, `expected error for ${JSON.stringify(names)}`)
    assert.equal(r.targets, undefined)
  }
})

check('resolveToolBulkTargets：非数组（字符串/数字/对象/null/boolean）→ 报错，不降级为「全部」', () => {
  for (const value of ['mcp__s__a', 42, { names: ['mcp__s__a'] }, null, true]) {
    assert.equal(
      index.resolveToolBulkTargets(BULK_KNOWN, value).error,
      'toolNames must be an array of tool full names',
      `expected rejection for ${JSON.stringify(value)}`,
    )
  }
})

check('resolveToolBulkTargets：数组含非字符串项 → 报错（点名的必须是全名数组）', () => {
  const r = index.resolveToolBulkTargets(BULK_KNOWN, ['mcp__s__a', 7])
  assert.ok(r.error, 'expected error')
  assert.ok(String(r.error).includes('not a string'), `unexpected message: ${r.error}`)
})

// F1 写端点鉴权：/mcp/toolBulk 走 handleAny([...], true)（漏传 → routes.ts 的
// fail-fast 断言在 makeRoutes 期抛错，整块面板不可用，故此处以源码守卫兜底）
check('路由守卫：/mcp/toolBulk 必须带 guardPosts（handleAny([...], true)）', () => {
  const src = readFileSync(join(root, 'src', 'routes.ts'), 'utf8')
  const at = src.indexOf('`${API_PREFIX}/mcp/toolBulk`')
  assert.ok(at > 0, 'toolBulk 路由缺失')
  const block = src.slice(at, src.indexOf('/mcp/preview', at))
  assert.ok(/handleAny\(\s*\[/.test(block), 'toolBulk 必须走 handleAny([...])')
  assert.ok(/\],\s*true\)/.test(block), 'toolBulk 的 guardPosts 必须为 true（写端点不得裸奔）')
})

// 0.6.0：/models 是**读端点**（provider/模型目录）—— 必须 handle('GET') 且不加 guarded
// （加了会让只读端点要求 token，面板拉不到目录 → 覆盖卡静默退回旧行为）；同时它必须带
// TTL 缓存，否则每个无鉴权请求都会扇出到 adapter（见 routes.ts 的 modelsCatalog 注释）。
check("路由守卫：/models 以 handle('GET') 注册（开放读端点）且带 MODELS_TTL_MS 目录缓存", () => {
  const src = readFileSync(join(root, 'src', 'routes.ts'), 'utf8')
  const at = src.indexOf('`${API_PREFIX}/models`')
  assert.ok(at > 0, '/models 路由缺失')
  const block = src.slice(at, src.indexOf('`${API_PREFIX}/token`', at))
  assert.ok(/handle\(\s*'GET'/.test(block), "/models 必须走 handle('GET', ...)")
  assert.ok(!/handle\(\s*'GET'[\s\S]*?,\s*true\s*\)/.test(block), '/models 不得带 guarded（读端点保持开放）')
  assert.ok(/const MODELS_TTL_MS = 60_000/.test(src), 'MODELS_TTL_MS = 60_000 常量缺失')
  assert.ok(/const MODELS_FETCH_TIMEOUT_MS = 8_000/.test(src), 'MODELS_FETCH_TIMEOUT_MS = 8_000 常量缺失')
  assert.ok(/Promise\.race\(/.test(src), '抓取必须套 Promise.race 上界（卡住的 adapter 不得黏住端点）')
  assert.ok(/\.unref\?\.\(\)/.test(src), '超时定时器必须 unref（长驻进程不能被它吊住）')
  assert.ok(/modelsCacheFresh\(/.test(src), 'TTL 判定必须复用 model-route 的共享纯函数')
  assert.ok(/\binflight\b/.test(src), '单飞字段（inflight）缺失：并发请求会重复扇出')
  const modelRoute = readFileSync(join(root, 'src', 'model-route.ts'), 'utf8')
  assert.ok(/export function modelsCacheFresh/.test(modelRoute), 'modelsCacheFresh 必须导出（自测入口）')
  assert.ok(/export async function fetchProviderCatalog/.test(modelRoute), 'fetchProviderCatalog 必须导出')
})

// ── projectServerName：项目 MCP 的 serverName 加路径哈希前缀（同名不同路径拆成独立服务） ──
check('projectServerName：不同工作区同名 server 得到不同 serverName（哈希后缀隔离）', () => {
  const a = index.projectServerName('C:\\ws-a', 'codegraph')
  const b = index.projectServerName('C:\\ws-b', 'codegraph')
  // 后缀不同 → 不再是同一 server → 各自独立实例，路径参数互不干扰
  assert.notEqual(a, b)
  // 合法 serverName：原名 + '-' + 8 位 hex 后缀，长度 ≤32、字符集合法
  for (const name of [a, b]) {
    assert.ok(/^[A-Za-z0-9_-]{1,23}-[0-9a-f]{8}$/.test(name), `invalid: ${name}`)
    assert.ok(name.length <= 32)
  }
  // 原名前置更可读
  assert.ok(a.startsWith('codegraph-'), `expected name-first form: ${a}`)
  // 确定性：同一工作区恒等
  assert.equal(index.projectServerName('C:\\ws-a', 'codegraph'), a)
  // 长度约束：超长原名的 serverName 截断到 ≤32
  const long = index.projectServerName('C:\\ws-a', 'this-is-a-very-very-very-long-server-name-abcdef')
  assert.ok(long.length <= 32)
})

// ── rc.1 standing 组合 preset 行解析（空面板修复A 回归护栏） ──
check('parsePresetMcpText：抽取 mcp-* 行 serverName/transport/超时 + mcp-anki 例外', () => {
  const text = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '- id: mcp-filesystem',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: filesystem',
    '    transport: stdio',
    '    command: npx',
    '- id: mcp-anki',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  disabled: true',
    '  config:',
    '    serverName: anki-mcp',
    '    transport: stdio',
    '- id: mcp-mimo-image',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  disabled: true',
    '  config:',
    '    serverName: mimo-image',
    '    transport: stdio',
    '    toolCallTimeoutMs: 300000',
  ].join('\n')
  const parsed = index.parsePresetMcpText(text)
  assert.equal(parsed.size, 3)
  assert.equal(parsed.get('mcp-filesystem').serverName, 'filesystem')
  assert.equal(parsed.get('mcp-filesystem').transport, 'stdio')
  assert.equal(parsed.get('mcp-anki').serverName, 'anki-mcp')
  assert.equal(parsed.get('mcp-mimo-image').toolCallTimeoutMs, 300000)
  // 非 mcp-* 行不收录
  assert.equal(parsed.get('persona'), undefined)
})

check('parsePresetMcpText：缺 serverName 键时回落（mcp-anki→anki-mcp，其余去前缀）', () => {
  const text = '- id: mcp-anki\n  name: x\n- id: mcp-foo\n  name: x\n  config:\n    transport: stdio\n'
  const parsed = index.parsePresetMcpText(text)
  assert.equal(parsed.get('mcp-anki').serverName, 'anki-mcp')
  assert.equal(parsed.get('mcp-foo').serverName, 'foo')
})

check('parsePresetMcpText：引号值去引号 + transport 缺席为 null', () => {
  const text = '- id: mcp-q\n  name: x\n  config:\n    serverName: "quoted-srv"\n    transport: "stdio"\n- id: mcp-notransport\n  name: x\n  config:\n    serverName: plain-srv\n'
  const parsed = index.parsePresetMcpText(text)
  assert.equal(parsed.get('mcp-q').serverName, 'quoted-srv')
  assert.equal(parsed.get('mcp-q').transport, 'stdio')
  assert.equal(parsed.get('mcp-notransport').transport, null)
})

// ── 0.5.6 预设直通：findPresetRowByServerName 薄封装（compositionInventory+resolve+read） ──
await checkAsync('findPresetRowByServerName：按 serverName 定位 standing 行（含 mcp-anki 例外回落）', async () => {
  const rows = [
    { entryId: 'include:agent-presets:mcp-filesystem', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberState: 2 },
    { entryId: 'include:agent-presets:mcp-exa', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: false },
    { entryId: 'include:agent-presets:mcp-anki', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: false },
    { entryId: 'include:agent-presets:persona', moduleName: '@deepseek-ai/dsh-persona', enabled: true },
  ]
  const text = [
    '- id: mcp-filesystem',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: filesystem',
    '    transport: stdio',
    '    toolCallTimeoutMs: 60000',
    '- id: mcp-exa',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  disabled: true',
    '  config:',
    '    serverName: exa',
    '    transport: streamable-http',
    '- id: mcp-anki',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  disabled: true',
    // 缺 serverName 键 → 回落 anki-mcp
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
  ].join('\n')
  const ctx = {
    agentPresets: {
      compositionInventory: async () => [{ id: 'standard-mcp', rows }],
      resolve: async () => ({ path: '/preset/agent.cordis.yml' }),
      read: async () => text,
    },
  }
  const fs = await index.findPresetRowByServerName(ctx, 'standard-mcp', 'filesystem')
  assert.ok(fs)
  assert.equal(fs.rowId, 'mcp-filesystem')
  assert.equal(fs.serverName, 'filesystem')
  assert.equal(fs.disabled, false)
  assert.equal(fs.running, true)
  assert.equal(fs.toolCallTimeoutMs, 60000)
  assert.equal(fs.file, '/preset/agent.cordis.yml')
  const exa = await index.findPresetRowByServerName(ctx, 'standard-mcp', 'exa')
  assert.ok(exa)
  assert.equal(exa.disabled, true)
  assert.equal(exa.running, false)
  const anki = await index.findPresetRowByServerName(ctx, 'standard-mcp', 'anki-mcp')
  assert.ok(anki)
  assert.equal(anki.rowId, 'mcp-anki')
  // 超时缺席不断言遗漏补齐（WARN-5）：exa/anki 无 toolCallTimeoutMs 键
  assert.equal(exa.toolCallTimeoutMs, undefined)
  assert.equal(anki.toolCallTimeoutMs, undefined)
  // 未知 server → undefined（调用方回退「不在 loader 中」）
  assert.equal(await index.findPresetRowByServerName(ctx, 'standard-mcp', 'ghost'), undefined)
  // 未知 preset → 抛错（调用方 .catch 包住回退 undefined，与 cachedPresetRow 同语义）
  await assert.rejects(() => index.findPresetRowByServerName(ctx, 'nope', 'filesystem'))
})

check('findPresetRowByServerName 经构建产物导出（index 转出）', () => {
  assert.equal(typeof index.findPresetRowByServerName, 'function')
})

// ── P1 直读：parsePresetMcpText 全键抓取（command/args/env/cwd/url/headers/failOnStartupError） ──
// BLOCK-1 回归：flow 单行 args（实块 6 行 stdio 形态）必须解析，弃测即漏保真断裂
check('parsePresetMcpText：P1 直读 flow 单行 args（calcmcp 实块形态）', () => {
  const text = [
    '- id: mcp-calcmcp',
    '  disabled: true',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: calcmcp',
    '    transport: stdio',
    '    command: python',
    "    args: ['-u', 'D:\\software\\HarnessWorkspace\\CalcMCP\\mcp_server.py']",
  ].join('\n')
  const parsed = index.parsePresetMcpText(text)
  const row = parsed.get('mcp-calcmcp')
  assert.ok(row)
  assert.equal(row.serverName, 'calcmcp')
  assert.equal(row.transport, 'stdio')
  assert.equal(row.command, 'python')
  assert.deepEqual(row.args, ['-u', 'D:\\software\\HarnessWorkspace\\CalcMCP\\mcp_server.py'])
  const cfg = index.presetConfigOf(row)
  assert.ok(cfg)
  assert.equal(cfg.transport, 'stdio')
  assert.equal(cfg.command, 'python')
  assert.deepEqual(cfg.args, ['-u', 'D:\\software\\HarnessWorkspace\\CalcMCP\\mcp_server.py'])
})

check('parsePresetMcpText：P1 直读 flow 单行 args（filesystem 4 路径含空格/CJK）', () => {
  const text = [
    '- id: mcp-filesystem',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: filesystem',
    '    transport: stdio',
    '    command: npx',
    "    args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\sync\\VSC项目管理', 'D:\\SteamLibrary\\steamapps\\common\\ZED ZONE', 'D:\\Obsidian\\笔记', 'D:\\software\\HarnessWorkspace']",
  ].join('\n')
  const row = index.parsePresetMcpText(text).get('mcp-filesystem')
  assert.ok(row)
  assert.deepEqual(row.args, ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\sync\\VSC项目管理', 'D:\\SteamLibrary\\steamapps\\common\\ZED ZONE', 'D:\\Obsidian\\笔记', 'D:\\software\\HarnessWorkspace'])
})

check('parsePresetMcpText：P1 直读 flow 单行 args（codegraph serve --mcp）', () => {
  const text = [
    '- id: mcp-codegraph',
    '  disabled: true',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: codegraph',
    '    transport: stdio',
    '    command: codegraph',
    "    args: ['serve', '--mcp']",
  ].join('\n')
  const row = index.parsePresetMcpText(text).get('mcp-codegraph')
  assert.ok(row)
  assert.deepEqual(row.args, ['serve', '--mcp'])
  assert.ok(index.presetConfigOf(row))
})

check('parsePresetMcpText：P1 直读 block 多行 args（mimo-image 形态，节内注释不截断）', () => {
  const text = [
    '- id: mcp-mimo-image',
    '  disabled: true',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: mimo-image',
    '    transport: stdio',
    '    command: python',
    '    args:',
    '      # 紧贴节的注释行（WARN-2 回归：不得截断其后条目）',
    "      - '-u'",
    "      - 'server.py'",
  ].join('\n')
  const row = index.parsePresetMcpText(text).get('mcp-mimo-image')
  assert.ok(row)
  assert.deepEqual(row.args, ['-u', 'server.py'])
})

check('parsePresetMcpText：P1 直读 http 全键 + !!js 求值（exa 形态）', () => {
  process.env.__DSH_P1_TEST_EXA = 'exa-key-123'
  try {
    const text = [
      '- id: mcp-exa',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: exa',
      '    transport: streamable-http',
      '    url: https://mcp.exa.ai/mcp',
      '    headers:',
      '      Authorization: !!js "process.env.__DSH_P1_TEST_EXA ? `Bearer ${process.env.__DSH_P1_TEST_EXA}` : \'\'"',
      '    failOnStartupError: false',
    ].join('\n')
    const parsed = index.parsePresetMcpText(text)
    const row = parsed.get('mcp-exa')
    assert.ok(row)
    assert.equal(row.url, 'https://mcp.exa.ai/mcp')
    assert.equal(row.headers.Authorization, 'Bearer exa-key-123')
    assert.equal(row.failOnStartupError, false)
    const cfg = index.presetConfigOf(row)
    assert.ok(cfg)
    assert.equal(cfg.transport, 'streamable-http')
    assert.equal(cfg.url, 'https://mcp.exa.ai/mcp')
  } finally {
    delete process.env.__DSH_P1_TEST_EXA
  }
})

check('parsePresetMcpText：P1 直读 env 多键 + transport 缺省推断', () => {
  const text = [
    '- id: mcp-mimo-image',
    '  disabled: true',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: mimo-image',
    '    command: python',
    '    args:',
    "      - '-u'",
    "      - 'server.py'",
    '    env:',
    '      MIMO_MODEL: mimo-v2.5',
    '      MIMO_TIMEOUT: \'300\'',
    '    toolCallTimeoutMs: 300000',
    '    failOnStartupError: false',
  ].join('\n')
  const parsed = index.parsePresetMcpText(text)
  const row = parsed.get('mcp-mimo-image')
  assert.ok(row)
  // transport 缺省 → 有 command 推断 stdio（mcp-convert.ts:108-119 同规则）
  assert.equal(row.transport, 'stdio')
  assert.equal(row.env.MIMO_MODEL, 'mimo-v2.5')
  assert.equal(row.env.MIMO_TIMEOUT, '300')
  assert.equal(row.toolCallTimeoutMs, 300000)
})

check('presetConfigOf：transport 不可挂载时回 undefined（旧快照行兼容）', () => {
  assert.equal(index.presetConfigOf({ serverName: 'x', transport: null }), undefined)
  assert.equal(index.presetConfigOf({ serverName: 'x', transport: 'stdio' }), undefined)
  assert.equal(index.presetConfigOf({ serverName: 'x', transport: 'streamable-http' }), undefined)
})

check('parseMcpServersJson：P1 failOnStartupError 透传（缺省 undefined 不变）', () => {
  const withFlag = convert.parseMcpServersJson(JSON.stringify({
    mcpServers: { exa: { url: 'https://mcp.exa.ai/mcp', failOnStartupError: false } },
  }))
  assert.equal(withFlag.errors.length, 0)
  assert.equal(withFlag.servers.exa.failOnStartupError, false)
  const rows = convert.serversToRows(withFlag.servers)
  assert.equal(rows[0].config.failOnStartupError, false)
  const noFlag = convert.parseMcpServersJson(JSON.stringify({ c: { command: 'x' } }))
  assert.equal(noFlag.servers.c.failOnStartupError, undefined)
  // serversToRows 缺省不落键（现网行为不变）
  assert.ok(!('failOnStartupError' in convert.serversToRows(noFlag.servers)[0].config))
})

// ── P2 gatewayCall：与 call() 并存，三抛透传（fake control/ctx 覆盖分支） ──
// fake 说明：control 仅实现 gatewayCall 所需三键（resolvePresetRow/serverTimeoutMs），
// ctx 仅实现 collectToolViews 消费的 tools + waitRegistered 消费的 logger/timeout/on/effect。
const makeGatewayHarness = (presetRow, toolsImpl) => {
  const control = {
    serverTimeoutMs: () => 60_000,
    resolveEntry: () => undefined,
    resolvePresetRow: async () => presetRow,
  }
  const ctx = {
    tools: toolsImpl,
    logger: {},
    timeout: (fn) => {
      fn()
      return () => undefined
    },
    root: { on: () => () => true },
    effect: () => () => undefined,
  }
  const state = { refCounts: new Map(), lastUsed: new Map(), aiEnabled: new Set() }
  return { ctx, control, state }
}
const gatewayToolsOk = (text) => ({
  get: () => ({}),
  execute: async () => ({ content: [{ type: 'text', text }] }),
})

await checkAsync('gatewayCall：成功返文本 + refCount 对称清零', async () => {
  const { ctx, control, state } = makeGatewayHarness(
    { rowId: 'mcp-filesystem', serverName: 'filesystem', transport: 'stdio', disabled: false, running: true },
    gatewayToolsOk('hello'),
  )
  const out = await index.gatewayCall(ctx, control, state, 'filesystem', 'read_text_file', {}, { signal: AbortSignal.timeout(5000), agent: undefined })
  assert.equal(out, 'hello')
  assert.equal(state.refCounts.size, 0)
})

await checkAsync('gatewayCall：前置 normalize 跨 server 全名 throw 透传', async () => {
  const { ctx, control, state } = makeGatewayHarness(
    { rowId: 'mcp-exa', serverName: 'exa', transport: 'streamable-http', disabled: false, running: true },
    gatewayToolsOk('x'),
  )
  await assert.rejects(
    () => index.gatewayCall(ctx, control, state, 'exa', 'mcp__mimo-image__understand_image', {}, { signal: AbortSignal.timeout(5000), agent: undefined }),
    /裸名/,
  )
  assert.equal(state.refCounts.size, 0)
})

await checkAsync('gatewayCall：禁用行/停用行/miss 均 throw（非文本）', async () => {
  // miss：resolvePresetRow → undefined（+ resolveEntry → undefined）
  {
    const tools = gatewayToolsOk('x')
    const control = { serverTimeoutMs: () => 60_000, resolveEntry: () => undefined, resolvePresetRow: async () => undefined }
    const ctx = { tools, logger: {}, timeout: (fn) => { fn(); return () => undefined }, root: { on: () => () => true }, effect: () => () => undefined }
    const state = { refCounts: new Map(), lastUsed: new Map(), aiEnabled: new Set() }
    await assert.rejects(
      () => index.gatewayCall(ctx, control, state, 'ghost', 'x', {}, { signal: AbortSignal.timeout(5000), agent: undefined }),
      /未知 MCP server/,
    )
  }
  // 停用行
  {
    const { ctx, control, state } = makeGatewayHarness(
      { rowId: 'mcp-exa', serverName: 'exa', transport: 'streamable-http', disabled: true, running: false },
      gatewayToolsOk('x'),
    )
    await assert.rejects(
      () => index.gatewayCall(ctx, control, state, 'exa', 'web_search_exa', {}, { signal: AbortSignal.timeout(5000), agent: undefined }),
      /当前已停用/,
    )
  }
})

await checkAsync('gatewayCall：isError→throw 且 cause 保原始 result；空内容 throw', async () => {
  const raw = { isError: true, error: { code: -32602 }, content: [{ type: 'text', text: 'bad' }] }
  const { ctx, control, state } = makeGatewayHarness(
    { rowId: 'mcp-exa', serverName: 'exa', transport: 'streamable-http', disabled: false, running: true },
    { get: () => ({}), execute: async () => raw },
  )
  const err = await index.gatewayCall(ctx, control, state, 'exa', 'web_search_exa', {}, { signal: AbortSignal.timeout(5000), agent: undefined }).then(
    () => { throw new Error('should throw') },
    (e) => e,
  )
  assert.ok(String(err.message).includes('调用失败'))
  assert.equal(err.cause, raw)
  // 空内容
  const { ctx: ctx2, control: control2, state: state2 } = makeGatewayHarness(
    { rowId: 'mcp-exa', serverName: 'exa', transport: 'streamable-http', disabled: false, running: true },
    { get: () => ({}), execute: async () => ({ content: [] }) },
  )
  await assert.rejects(
    () => index.gatewayCall(ctx2, control2, state2, 'exa', 'web_search_exa', {}, { signal: AbortSignal.timeout(5000), agent: undefined }),
    /无返回内容/,
  )
})

await checkAsync('gatewayCall：JSON 字符串 arguments 归一化下沉（WARN-2）', async () => {
  let seen = null
  const { ctx, control, state } = makeGatewayHarness(
    { rowId: 'mcp-filesystem', serverName: 'filesystem', transport: 'stdio', disabled: false, running: true },
    { get: () => ({}), execute: async (exec) => { seen = exec.arguments; return { content: [{ type: 'text', text: 'ok' }] } } },
  )
  const out = await index.gatewayCall(ctx, control, state, 'filesystem', 'read_text_file', '{"path": "README.md"}', { signal: AbortSignal.timeout(5000), agent: undefined })
  assert.equal(out, 'ok')
  assert.deepEqual(seen, { path: 'README.md' })
})

// ── P4 网关纯逻辑：挂载决策/视野隔离/自检断言 ──
check('decideMount：不可挂载/停用/已挂载/新挂载四态', () => {
  assert.equal(index.decideMount('x', undefined, false, new Map()), 'skip')
  assert.equal(index.decideMount('exa', { serverName: 'exa' }, true, new Map()), 'skip')
  assert.equal(index.decideMount('exa', { serverName: 'exa' }, false, new Map([['exa', 1]])), 'reuse')
  assert.equal(index.decideMount('exa', { serverName: 'exa' }, false, new Map()), 'mount')
})

// ── P5 网关挂载：B3 让路分支 + B4 id 映射 + ensureOpenMounts 四态 ──
check('decideMount：loader已有同名行时skip-official让路（B3）', () => {
  assert.equal(index.decideMount('exa', { serverName: 'exa' }, false, new Map(), true), 'skip-official')
  // 让路优先于 reuse（不建第二实例）
  assert.equal(index.decideMount('exa', { serverName: 'exa' }, false, new Map([['exa', 1]]), true), 'skip-official')
  // 缺省第五参=false，保持旧四态
  assert.equal(index.decideMount('exa', { serverName: 'exa' }, false, new Map()), 'mount')
})

check('gatewayEntryId：连字符前缀双向映射（B4，冒号不可用）', () => {
  assert.equal(index.gatewayEntryId('exa'), 'gw-mcp-exa')
  assert.equal(index.gatewayServerOfEntryId('gw-mcp-exa'), 'exa')
  assert.equal(index.gatewayServerOfEntryId('mcp-exa'), null)
  assert.equal(index.GATEWAY_ENTRY_PREFIX, 'gw-mcp-')
  assert.ok(!index.gatewayEntryId('exa').includes(':'))
})

check('collect补行去重：loader已有同名跳过、缺席补行（2026-09-10 面板全行）', () => {
  // 纯集合逻辑回归（无需 harness）：去重键=serverName，loader 行优先。
  const loaderRows = [{ serverName: 'exa' }, { serverName: 'filesystem' }]
  const liveServers = new Set(loaderRows.map((row) => row.serverName))
  const presetRows = [{ serverName: 'exa' }, { serverName: 'calcmcp' }, { serverName: 'chrome' }]
  const filtered = presetRows.filter((pr) => !liveServers.has(pr.serverName)).map((pr) => pr.serverName)
  assert.deepEqual(filtered, ['calcmcp', 'chrome'])
  const merged = [...loaderRows.map((r) => r.serverName), ...filtered].sort()
  assert.deepEqual(merged, ['calcmcp', 'chrome', 'exa', 'filesystem'])
})

await checkAsync('ensureOpenMounts：单飞guard+空态（真值表循环由decideMount覆盖）', async () => {
  const calls = []
  const fakeLoader = {
    entries: () => [],
    create: async (row) => {
      calls.push(row)
      if (row.config.serverName === 'bad') throw new Error('spawn fail')
      return { id: row.id }
    },
    remove: async () => undefined,
  }
  const fakeCtx = { loader: fakeLoader, logger: {}, agents: { roots: () => [], list: () => [] }, agentPresets: { composedPreset: () => 'p' } }
  // fake control：resolvePresetConfig 不用（ensureOpenMounts 经 listPresetMcpRows 直读，此处 fake roles 由 loader 侧 rows 注入）
  const { ensureOpenMounts, createGatewayState } = index
  // 用可注入 rows 的变体：直接测 decideMount 真值表 + create 记账（listPresetMcpRows 需 ctx harness，此处覆盖纯逻辑面）
  const state = createGatewayState()
  assert.equal(state.mounts.size, 0)
  assert.equal(state.entryIds.size, 0)
  assert.equal(state.syncing, false)
  // 单飞 guard：syncing=true 时直接回空结果
  state.syncing = true
  const skipped = await ensureOpenMounts({ ctx: fakeCtx, control: {}, state }, 'p')
  assert.deepEqual(skipped, { mounted: [], reused: [], skipped: [], skippedOfficial: [], unmounted: [], errors: [] })
  state.syncing = false
})

await checkAsync('ensureOpenMounts：关意图即拆+同轮不重建（WARN-3/BLOCK-1，可注入行源/意图源）', async () => {
  // WARN-3 收紧（复审，2026-09-10）：经 deps.listRows/readIntents 注入，
  // 断言 remove 被调、账清空、unmounted 内容、同轮不重建、开行照常 mount。
  const removed = []
  const created = []
  const fakeLoader = {
    entries: () => [],
    create: async (row) => { created.push(row.id); return { id: row.id } },
    remove: async (entryId) => { removed.push(entryId); return undefined },
  }
  const rows = [
    { serverName: 'exa', rowId: 'mcp-exa', file: '/p/agent.cordis.yml', disabled: false, config: { serverName: 'exa', transport: 'stdio', command: 'x' } },
    { serverName: 'chrome', rowId: 'mcp-chrome', file: '/p/agent.cordis.yml', disabled: false, config: { serverName: 'chrome', transport: 'stdio', command: 'x' } },
  ]
  const fakeCtx = { loader: fakeLoader, logger: {}, agents: { roots: () => [], list: () => [] }, agentPresets: { composedPreset: () => 'p' } }
  const { ensureOpenMounts: ensure, createGatewayState: mkState } = index
  const state = mkState()
  state.mounts.set('exa', 1)
  state.entryIds.set('exa', 'gw-mcp-exa')
  const out = await ensure(
    {
      ctx: fakeCtx,
      control: {},
      state,
      listRows: async () => ({ rows, presetPath: '/p/agent.cordis.yml' }),
      readIntents: async () => ({ 'mcp-exa': { desired: true, lastApplied: false } }),
    },
    'p',
  )
  // 关意图行：remove 被调 + 清账 + unmounted + 同轮不重建
  assert.deepEqual(removed, ['gw-mcp-exa'])
  assert.equal(state.mounts.has('exa'), false)
  assert.equal(state.entryIds.has('exa'), false)
  assert.deepEqual(out.unmounted, ['exa'])
  assert.ok(!created.includes('gw-mcp-exa'), '关意图行同轮不得重建（BLOCK-1）')
  assert.ok(out.skipped.includes('exa'), '关意图行计 skipped（意图闸）')
  // 开行照常 mount
  assert.deepEqual(created, ['gw-mcp-chrome'])
  assert.deepEqual(out.mounted, ['chrome'])
  assert.equal(state.syncing, false)
})

await checkAsync('gatewayCall：loader行走callViaLoaderEntry分支（B1，不再miss）', async () => {
  // loader 有行 + preset 无行：旧 gatewayCall 会 throw 未知 server；B1 后走 loader 分支成功
  const tools = gatewayToolsOk('via-loader')
  const entry = { id: 'gw-mcp-proj', disabled: false }
  const control = {
    serverTimeoutMs: () => 60_000,
    resolveEntry: () => entry,
    resolvePresetRow: async () => undefined,
    setAiOwner: async () => undefined,
    clearAiOwner: async () => undefined,
  }
  const ctx = { tools, logger: {}, timeout: (fn) => { fn(); return () => undefined }, root: { on: () => () => true }, effect: () => () => undefined }
  const state = { refCounts: new Map(), lastUsed: new Map(), aiEnabled: new Set() }
  const out = await index.gatewayCall(ctx, control, state, 'proj', 'do_thing', {}, { signal: AbortSignal.timeout(5000), agent: undefined })
  assert.equal(out, 'via-loader')
  assert.equal(state.refCounts.size, 0)
})

await checkAsync('gatewayCall：loader行禁用时ensureEnabled开启后执行（B1）', async () => {
  let updated = null
  const tools = gatewayToolsOk('opened')
  const entry = { id: 'gw-mcp-proj2', disabled: true, update: async (patch) => { updated = patch; entry.disabled = patch.disabled } }
  const control = {
    serverTimeoutMs: () => 60_000,
    resolveEntry: () => entry,
    resolvePresetRow: async () => undefined,
    setAiOwner: async () => undefined,
    clearAiOwner: async () => undefined,
  }
  const ctx = { tools, logger: {}, timeout: (fn) => { fn(); return () => undefined }, root: { on: () => () => true }, effect: () => () => undefined }
  const state = { refCounts: new Map(), lastUsed: new Map(), aiEnabled: new Set() }
  const out = await index.gatewayCall(ctx, control, state, 'proj2', 'do_thing', {}, { signal: AbortSignal.timeout(5000), agent: undefined })
  assert.equal(out, 'opened')
  assert.deepEqual(updated, { disabled: false })
})

check('checkChildVisible：恒为双工具才 PASS', () => {
  assert.ok(index.checkChildVisible([index.MCP_SEARCH_TOOL, index.MCP_CALL_TOOL]).ok)
  assert.ok(!index.checkChildVisible([index.MCP_CALL_TOOL]).ok)
  assert.ok(!index.checkChildVisible([index.MCP_CALL_TOOL, index.MCP_SEARCH_TOOL, 'mcp__exa__web_search_exa']).ok)
})

check('isolateChildScope：deny 转调 restrict 并回 disposer', () => {
  let got = null
  const childTools = { restrict: (filter) => { got = filter; return () => 'lifted' } }
  const lift = index.isolateChildScope(childTools, ['mcp__exa__web_search_exa'])
  assert.deepEqual(got, { deny: ['mcp__exa__web_search_exa'] })
  assert.equal(lift(), 'lifted')
})

// 控制工具命名前缀铁律（2026-09-15 claude 400 取证）
check('控制工具名不得以 mcp_ 开头（claude.ai 网关保留前缀 → HTTP 400）', () => {
  for (const name of index.CONTROL_TOOL_NAMES) {
    assert.ok(!/^mcp_(?!_)/.test(name), `控制工具名 ${name} 命中保留前缀 mcp_`)
  }
  assert.equal(index.MCP_SEARCH_TOOL, 'dsh_mcp_search')
  assert.equal(index.MCP_CALL_TOOL, 'dsh_mcp_call')
})

// ── 按模型分流的查表优先级（C1：接线批，本批 decisionFor 恒走总开关）────────
const grok = { provider: 'grok', model: 'grok-4.6' }
const claude = { provider: 'claude', model: 'claude-sonnet-5' }

check('routeDecision：空覆盖表 = 旧行为（只看总开关）', () => {
  assert.deepEqual(index.routeDecision(grok, true, {}), { on: true, source: 'master', route: grok })
  assert.deepEqual(index.routeDecision(grok, false, undefined), { on: false, source: 'master', route: grok })
})

check('routeDecision：provider 项覆盖总开关', () => {
  const table = { claude: false }
  assert.equal(index.routeDecision(claude, true, table).on, false)
  assert.equal(index.routeDecision(claude, true, table).source, 'provider')
  // 未列出的 provider 不受影响
  assert.equal(index.routeDecision(grok, true, table).on, true)
  assert.equal(index.routeDecision(grok, true, table).source, 'master')
})

check('routeDecision：provider/model 精确项优先于 provider 项', () => {
  const table = { claude: false, 'claude/claude-haiku-4-5-20251001': true }
  assert.equal(index.routeDecision(claude, true, table).on, false)
  const haiku = { provider: 'claude', model: 'claude-haiku-4-5-20251001' }
  assert.equal(index.routeDecision(haiku, true, table).on, true)
  assert.equal(index.routeDecision(haiku, true, table).source, 'model')
})

check('routeDecision：总开关关 + 覆盖项开 → 该模型仍启用（挂载条件的依据）', () => {
  assert.equal(index.routeDecision(grok, false, { grok: true }).on, true)
})

check('routeDecision：未解析出路由 → 保守回退总开关，不静默改变工具集', () => {
  const decision = index.routeDecision(undefined, true, { claude: false })
  assert.deepEqual(decision, { on: true, source: 'no-route', route: undefined })
})

check('routeKey：provider/model 拼接', () => {
  assert.equal(index.routeKey(grok), 'grok/grok-4.6')
})

// ── /models 数据源（0.6.0：面板按模型覆盖的 provider/模型目录）────────────────
check('activeRouteView：/state 与 /models 共用的判定投影（route 缺失 → null 而非 undefined）', () => {
  assert.deepEqual(index.activeRouteView({ on: true, source: 'model', route: grok }), {
    on: true,
    source: 'model',
    provider: 'grok',
    model: 'grok-4.6',
  })
  const none = index.activeRouteView({ on: false, source: 'no-route', route: undefined })
  assert.deepEqual(none, { on: false, source: 'no-route', provider: null, model: null })
  // 面板视图要过 JSON：undefined 字段会整个消失，前端拿到的形状就变了
  assert.equal(JSON.parse(JSON.stringify(none)).provider, null)
})

check('modelsCacheFresh：TTL 判定（命中 / 边界过期 / 从未抓取）', () => {
  const now = 1_000_000
  assert.equal(index.modelsCacheFresh(now, now, 60_000), true)
  assert.equal(index.modelsCacheFresh(now - 59_999, now, 60_000), true)
  // 恰好到 TTL = 过期（不是「>= 才算过期」的差一错）
  assert.equal(index.modelsCacheFresh(now - 60_000, now, 60_000), false)
  assert.equal(index.modelsCacheFresh(null, now, 60_000), false)
})

await checkAsync('fetchProviderCatalog：llm 缺失 → 空目录（精简组合不抛错）', async () => {
  assert.deepEqual(await index.fetchProviderCatalog(undefined), [])
})

await checkAsync('fetchProviderCatalog：listProviders 抛错 → 空目录（端点仍 200）', async () => {
  const llm = {
    listProviders: () => {
      throw new Error('adapter down')
    },
    listModels: async () => [],
  }
  assert.deepEqual(await index.fetchProviderCatalog(llm), [])
})

await checkAsync('fetchProviderCatalog：单个 provider 的 listModels 抛错 → 该 provider 空表，其余保留 + 字典序排序', async () => {
  const llm = {
    // 故意乱序声明：输出必须按 provider 字典序（UI 折叠顺序 + 断言都不受扇出顺序影响）
    listProviders: () => [
      { id: 'zzz-bad', name: 'Bad' },
      { id: 'aaa-ok', name: 'Ok' },
    ],
    listModels: async (provider) => {
      if (provider === 'zzz-bad') throw new Error('network')
      return [{ id: 'm1', name: 'M1' }]
    },
  }
  assert.deepEqual(await index.fetchProviderCatalog(llm), [
    { provider: 'aaa-ok', name: 'Ok', models: [{ id: 'm1', name: 'M1' }] },
    { provider: 'zzz-bad', name: 'Bad', models: [] },
  ])
})

await checkAsync('modelsCatalog：并发单飞共享一次抓取 + TTL 内命中缓存 + __resetModelsCache 失效出口', async () => {
  index.__resetModelsCache()
  const calls = { providers: 0, models: 0 }
  const llm = {
    listProviders: () => {
      calls.providers += 1
      return [{ id: 'p1', name: 'P1' }]
    },
    listModels: async () => {
      calls.models += 1
      // 抓取故意异步：两个并发请求必须共享同一个 in-flight promise
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [{ id: 'm1', name: 'M1' }]
    },
  }
  const [a, b] = await Promise.all([index.modelsCatalog(llm), index.modelsCatalog(llm)])
  assert.equal(calls.providers, 1, `listProviders 应只调 1 次，实际 ${calls.providers}`)
  assert.equal(calls.models, 1, `listModels 应只调 1 次，实际 ${calls.models}`)
  // 共享 in-flight 的两个请求都不是「从缓存拿到的」→ cached=false（与实现的语义一致）
  assert.equal(a.cached, false)
  assert.equal(b.cached, false)
  assert.deepEqual(a.providers, [{ provider: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }])
  // TTL 内再请求：直接吃缓存，不再打扰 adapter
  const c = await index.modelsCatalog(llm)
  assert.equal(c.cached, true)
  assert.equal(calls.providers, 1)
  assert.equal(typeof c.fetchedAt, 'number')
  // 失效出口：清空后必须重新抓取
  index.__resetModelsCache()
  const d = await index.modelsCatalog(llm)
  assert.equal(d.cached, false)
  assert.equal(calls.providers, 2)
  index.__resetModelsCache()
})

/** unref 过的定时器不计入「事件循环还有活干」：超时路径的断言里，唯一待触发的句柄就是那个
 * 定时器本身，不挂保活的话 Node 会在它触发前判定空转并退出（exit 13：未 settle 的顶层 await）。
 * 保活上限 5s：断言若真挂住，5s 后照常以 13 收场，不会把闸门永久拖死。 */
const withKeepAlive = async (run) => {
  const keepAlive = setTimeout(() => {}, 5_000)
  try {
    return await run()
  } finally {
    clearTimeout(keepAlive)
  }
}

await checkAsync('modelsCatalog：抓取超时 → 本次空目录 + 不写缓存 + 清 inflight（下一个请求真的重新抓取）', () =>
  withKeepAlive(async () => {
    index.__resetModelsCache()
    // 永不 settle 的 listModels：模拟「adapter 卡住」。超时上界由第二个参数注入（20ms），
    // 不为一条自测干等 8s（生产默认值见 MODELS_FETCH_TIMEOUT_MS，另有源码守卫断言）。
    let stuckCalls = 0
    const stuck = {
      listProviders: () => [{ id: 'stuck', name: 'Stuck' }],
      listModels: () => {
        stuckCalls += 1
        return new Promise(() => {})
      },
    }
    const out = await index.modelsCatalog(stuck, 20)
    assert.deepEqual(out.providers, [], '超时必须按空目录返回（前端已有空态/降级文案）')
    assert.equal(out.cached, false)
    assert.equal(out.fetchedAt, null, '超时不得写 fetchedAt（没抓到东西就不许动缓存时间戳）')
    assert.equal(stuckCalls, 1)

    // 换一个正常 llm：必须触发**真实抓取**。若超时写了空表缓存、或没清 inflight，
    // 这里会命中缓存（cached=true）或挂在同一个 pending promise 上（本断言永不返回）。
    let okCalls = 0
    const ok = {
      listProviders: () => {
        okCalls += 1
        return [{ id: 'p1', name: 'P1' }]
      },
      listModels: async () => [{ id: 'm1', name: 'M1' }],
    }
    const next = await index.modelsCatalog(ok, 200)
    assert.equal(okCalls, 1, `超时后必须重新抓取，实际 listProviders 调用 ${okCalls} 次`)
    assert.equal(next.cached, false)
    assert.deepEqual(next.providers, [{ provider: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }])
    index.__resetModelsCache()
  }),
)

await checkAsync('modelsCatalog：超时后迟到的真实抓取结果仍写缓存（后续请求命中，cached=true）', () =>
  withKeepAlive(async () => {
    index.__resetModelsCache()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const slow = {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => {
        await gate
        return [{ id: 'm1', name: 'M1' }]
      },
    }
    const timedOut = await index.modelsCatalog(slow, 20)
    assert.deepEqual(timedOut.providers, [], '超时那次仍按空目录返回')
    release()
    // 等迟到结果落盘：gate 之后的续体全是微任务，一个宏任务边界足够。
    await new Promise((resolve) => setTimeout(resolve, 5))
    let calls = 0
    const probe = {
      listProviders: () => {
        calls += 1
        return []
      },
      listModels: async () => [],
    }
    const hit = await index.modelsCatalog(probe, 200)
    assert.equal(calls, 0, '迟到结果应已写缓存（这次不该再扇出到 adapter）')
    assert.equal(hit.cached, true)
    assert.deepEqual(hit.providers, [{ provider: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }])
    index.__resetModelsCache()
  }),
)

// ── 中间层隐藏范围与覆盖表（P3b：state.ts 两个 getter）─────────────────
check('stateMiddleLayerHides：缺省 disabled，只有显式 all 才切换', () => {
  assert.equal(index.stateMiddleLayerHides({}), 'disabled')
  assert.equal(index.stateMiddleLayerHides({ config: {} }), 'disabled')
  assert.equal(index.stateMiddleLayerHides({ config: { middleLayerHides: 'all' } }), 'all')
  // 非法值不得静默变成 all（会让所有模型突然失去全部 MCP 直连工具）
  assert.equal(index.stateMiddleLayerHides({ config: { middleLayerHides: 'nonsense' } }), 'disabled')
})

check('stateAutoManageByRoute：非布尔值与空键一律丢弃，缺省空表', () => {
  assert.deepEqual(index.stateAutoManageByRoute({}), {})
  assert.deepEqual(index.stateAutoManageByRoute({ config: {} }), {})
  assert.deepEqual(
    index.stateAutoManageByRoute({ config: { autoManageByRoute: { grok: true, claude: false } } }),
    { grok: true, claude: false },
  )
  // 损坏的 state.json 不得把某个模型静默切到中间层
  assert.deepEqual(
    index.stateAutoManageByRoute({ config: { autoManageByRoute: { grok: 'yes', '': true, ok: true } } }),
    { ok: true },
  )
})

// ── G2：挂载条件（needed）与「按模型判定」的一致性 ─────────────────────
check('autoManageNeeded：总开关或任一 true 覆盖项 ⇒ 需要挂载', () => {
  assert.equal(index.autoManageNeeded(true, {}), true)
  assert.equal(index.autoManageNeeded(false, {}), false)
  // 总开关关 + 覆盖项开：仍必须挂（否则覆盖项永远无法生效）
  assert.equal(index.autoManageNeeded(false, { grok: true }), true)
  assert.equal(index.autoManageNeeded(true, { grok: false }), true)
  // 全是 false 项 = 没有任何模型会用到 → 不挂（与旧行为一致）
  assert.equal(index.autoManageNeeded(false, { grok: false, claude: false }), false)
})

check('G2：任一会话判定 on ⇒ needed 必为 true（穷举 master × 覆盖表 × 模型）', () => {
  const agents = [
    grok,
    claude,
    { provider: 'claude', model: 'claude-haiku-4-5-20251001' },
    { provider: 'gemini', model: 'gemini-3-pro' },
    undefined, // 诊断装配 / agent 缺席
    { provider: '', model: 'x' }, // 半条路由
    { provider: 'grok', model: '' },
  ]
  const tables = [
    {},
    { grok: false },
    { grok: true },
    { claude: false },
    { claude: false, 'claude/claude-haiku-4-5-20251001': true },
    { 'grok/grok-4.6': true },
    { claude: true, gemini: false },
    { 'unknown/provider': true },
  ]
  for (const master of [true, false]) {
    for (const table of tables) {
      const needed = index.autoManageNeeded(master, table)
      for (const agent of agents) {
        const decision = index.routeDecision(agent, master, table)
        if (decision.on) {
          assert.ok(
            needed,
            `判定 on 但 needed=false：master=${master} table=${JSON.stringify(table)} agent=${JSON.stringify(agent)}`,
          )
        }
      }
    }
  }
})

// ── G1：装配过滤按模型 gate 投放控制工具 ───────────────────────────────
/** 假 assembly 上下文：抓 system-prompt/assemble 监听器，直接喂一次装配。 */
const assembleHarness = (visibility, gateFor) => {
  let listener = null
  const ctx = {
    root: {
      on: (event, fn) => {
        if (event === 'system-prompt/assemble') listener = fn
        return () => {
          listener = null
        }
      },
    },
    effect: (fn) => fn(),
  }
  const dispose = index.installMcpVisibilityFilter(ctx, () => visibility, gateFor)
  return {
    dispose,
    run: async (names, agent) => {
      assert.ok(listener, 'system-prompt/assemble 监听未注册')
      const assembly = { tools: names.map((name) => ({ name })) }
      const out = await listener(assembly, { agent }, async () => assembly)
      return out.tools.map((tool) => tool.name)
    },
  }
}

await checkAsync('G1：控制工具只投放给 gate 打开的模型（gate 命中的必须是新名常量）', async () => {
  const visibility = new Map([
    ['exa', true],
    ['closed', false],
  ])
  const h = assembleHarness(visibility, (agent) => ({ on: agent?.id === 'gated-on', hideAll: false }))
  const tools = ['mcp__exa__web_search', 'mcp__closed__x', 'dsh_mcp_search', 'dsh_mcp_call', 'read']
  // gate 开：控制工具投放；可见 server 留、停用 server 去
  assert.deepEqual(await h.run(tools, { id: 'gated-on' }), ['mcp__exa__web_search', 'dsh_mcp_search', 'dsh_mcp_call', 'read'])
  // gate 关：控制工具一个不投放
  assert.deepEqual(await h.run(tools, { id: 'gated-off' }), ['mcp__exa__web_search', 'read'])
  // 无 agent（诊断装配）：gateFor 收 undefined → 与 gate 关同侧
  assert.deepEqual(await h.run(tools, undefined), ['mcp__exa__web_search', 'read'])
  // 反面证据：旧名字面量不在 CONTROL_TOOL_NAMES 里 → 不受 gate 约束，会漏给 gate 关的模型。
  // 这正是「控制工具改名必须与 gate 同批原子落地」的原因（G1）。
  assert.deepEqual(await h.run(['mcp_search', 'mcp_call'], { id: 'gated-off' }), ['mcp_search', 'mcp_call'])
  h.dispose()
})

await checkAsync('G1/hideAll：hideAll 只对 gate 打开的模型生效（gate 关的模型照常直连）', async () => {
  const visibility = new Map([
    ['exa', true],
    ['closed', false],
  ])
  const h = assembleHarness(visibility, (agent) => ({ on: agent?.id === 'gated-on', hideAll: true }))
  const tools = ['mcp__exa__web_search', 'mcp__closed__x', 'dsh_mcp_search', 'dsh_mcp_call', 'read']
  // gate 开 + hideAll：一个 mcp__ 都不直连，但控制工具必须在（否则模型无路取用）
  assert.deepEqual(await h.run(tools, { id: 'gated-on' }), ['dsh_mcp_search', 'dsh_mcp_call', 'read'])
  // gate 关：hideAll 不生效（B 会话不被 A 会话的中间层配置波及）
  assert.deepEqual(await h.run(tools, { id: 'gated-off' }), ['mcp__exa__web_search', 'read'])
  h.dispose()
})

// ── G3：能力摘要表口径必须与 hideAll 一致（评审风险 7）──────────────────
check('G3：hideAll 下空查摘要不再宣称 server「对模型可见」', () => {
  const normal = index.buildSummaryHeader(10, 4, false)
  const hidesAll = index.buildSummaryHeader(10, 4, true)
  assert.ok(normal.includes('已打开并对模型可见'), '默认口径（hides=disabled）应保留旧的可见措辞')
  assert.ok(!hidesAll.includes('对模型可见'), `hideAll 文案不得宣称对模型可见：${hidesAll}`)
  assert.ok(
    hidesAll.includes(index.MCP_SEARCH_TOOL) && hidesAll.includes(index.MCP_CALL_TOOL),
    'hideAll 文案必须给出按需取用路径（两个控制工具名）',
  )
  assert.ok(hidesAll.includes('10'), '数量仍需如实给出')
  assert.ok(hidesAll.includes('挂载'), 'hideAll 下 [开] 的语义应被说明为挂载态，而非模型可见')
})

// ── 会话透传（0.6.0：面板把「当前会话」带给 host；取不到会话时必须与不透传逐字节相同）─────
check('readCurrentSession：非字符串 / 空串 / 全空白 → undefined', () => {
  for (const value of [undefined, null, '', '   ', 123, true, {}, [], () => {}]) {
    assert.equal(sessionScope.readCurrentSession(value), undefined, `应视为无会话：${String(value)}`)
  }
})
check('readCurrentSession：字符串 trim 后返回', () => {
  assert.equal(sessionScope.readCurrentSession('abc'), 'abc')
  assert.equal(sessionScope.readCurrentSession(' ab '), 'ab')
})
check('withSessionParam：无会话时逐字节不变（向后兼容的硬要求）', () => {
  assert.equal(sessionScope.withSessionParam('/x', undefined), '/x')
  assert.equal(sessionScope.withSessionParam('/x?part=mcp', undefined), '/x?part=mcp')
  assert.equal(sessionScope.withSessionParam('/x', ''), '/x')
})
check('withSessionParam：有会话时按既有 ? 选分隔符', () => {
  assert.equal(sessionScope.withSessionParam('/x', 's1'), '/x?session=s1')
  assert.equal(sessionScope.withSessionParam('/x?part=mcp', 's1'), '/x?part=mcp&session=s1')
})
check('withSessionParam：会话 id 被 urlencode', () => {
  assert.equal(sessionScope.withSessionParam('/x', 'a b&c=d'), '/x?session=a%20b%26c%3Dd')
})
check('sessionField：无会话 → 空对象（展开后不新增 body 键）', () => {
  assert.equal(Object.keys(sessionScope.sessionField(undefined)).length, 0)
  assert.equal(Object.keys(sessionScope.sessionField('')).length, 0)
})
check('sessionField：有会话 → { session }', () => {
  assert.deepEqual(sessionScope.sessionField('s1'), { session: 's1' })
})
check('接线护栏：四个吃 session 的请求都真的带上了会话（防「写了纯函数忘了接线」）', () => {
  const clientSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  // 打包器保留函数名（与 verify 对 ensureToolToken 的可见性同源），故断言「端点字面量附近
  // 是否出现拼接调用」—— 漏接任一处都会失败，而不是只看纯函数存在。
  // ⚠️ 这是**实现形态**断言（独立审查 NIT-1）：把 `...sessionField(x)` 等价重写成
  // `...{ session: x }` 会误报 —— 请同步更新本断言，而不是绕过护栏。
  const nearAny = (endpoint, probe, span = 260) => {
    let from = 0
    for (;;) {
      const at = clientSrc.indexOf(endpoint, from)
      if (at < 0) return false
      if (clientSrc.slice(Math.max(0, at - span), at + span).includes(probe)) return true
      from = at + endpoint.length
    }
  }
  assert.ok(nearAny('/api/mcp-skill-panel/state', 'withSessionParam('), '/state 未接会话（应为 query 透传）')
  assert.ok(nearAny('/api/mcp-skill-panel/models', 'withSessionParam('), '/models 未接会话（应为 query 透传）')
  // /skill/toggle 走**共享 post 通道**：会话是在通道内部注入的，端点字面量旁边看不到
  // sessionField —— 故这里断言「通道注入了当前会话」+「该端点确实走这条通道」。
  assert.ok(
    clientSrc.includes('sessionField(currentSession)'),
    '共享 post 通道未注入当前会话（/skill/toggle 依赖它）',
  )
  assert.ok(nearAny('/api/mcp-skill-panel/skill/toggle', 'post(', 80), '/skill/toggle 必须走共享 post 通道')
  assert.ok(nearAny('/api/mcp-skill-panel/mcp/toolBulk', 'sessionField('), '/mcp/toolBulk 未接会话（应为 body 透传）')
  assert.ok((clientSrc.match(/withSessionParam\(/g) ?? []).length >= 2, 'query 透传应有两处调用')
  assert.ok((clientSrc.match(/sessionField\(/g) ?? []).length >= 2, 'body 透传应有两处调用')
})

if (failed) {
  console.log(`\nselftest: FAILED (${passed} passed)`)
  process.exit(1)
}
console.log(`\nselftest-mcp: all checks passed (${passed} checks)`)
