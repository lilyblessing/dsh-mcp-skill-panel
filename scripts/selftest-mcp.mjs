// 临时 Node 自测：验证 MCP 中间层控制的纯逻辑（构建产物 lib/*.js）。
// eslint-disable-next-line no-console
// 用法：node scripts/selftest-mcp.mjs （在包根目录运行）
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const catalog = await import(pathToFileURL(join(root, 'lib', 'catalog.js')).href)
const index = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
const convert = await import(pathToFileURL(join(root, 'lib', 'mcp-convert.js')).href)

let failed = false
const check = (label, fn) => {
  try {
    fn()
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

check('listServer 返回精简名+描述；未知 server undefined；分页 offset/limit（P3）', () => {
  const c = buildCatalog()
  const chrome = catalog.listServer(c, 'chrome')
  assert.ok(chrome)
  assert.equal(chrome.totalCount, 1)
  assert.equal(chrome.tools.length, 1)
  assert.equal(chrome.tools[0].name, 'mcp__chrome__navigate')
  assert.equal(chrome.tools[0].description, '导航到 URL')
  assert.equal(catalog.listServer(c, 'nope'), undefined)
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
    const got = index.computeStatus(disabled, running, liveTools)
    assert.equal(got, expected, `computeStatus(${disabled}, ${running}, ${liveTools}) -> ${got}, expected ${expected}`)
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
  const state = { refCounts: new Map(), lastUsed: new Map() }
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
  // miss：resolvePresetRow → undefined
  {
    const tools = gatewayToolsOk('x')
    const control = { serverTimeoutMs: () => 60_000, resolvePresetRow: async () => undefined }
    const ctx = { tools, logger: {}, timeout: (fn) => { fn(); return () => undefined }, root: { on: () => () => true }, effect: () => () => undefined }
    const state = { refCounts: new Map(), lastUsed: new Map() }
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

check('checkChildVisible：恒为双工具才 PASS', () => {
  assert.ok(index.checkChildVisible(['mcp_search', 'mcp_call']).ok)
  assert.ok(!index.checkChildVisible(['mcp_call']).ok)
  assert.ok(!index.checkChildVisible(['mcp_call', 'mcp_search', 'mcp__exa__web_search_exa']).ok)
})

check('isolateChildScope：deny 转调 restrict 并回 disposer', () => {
  let got = null
  const childTools = { restrict: (filter) => { got = filter; return () => 'lifted' } }
  const lift = index.isolateChildScope(childTools, ['mcp__exa__web_search_exa'])
  assert.deepEqual(got, { deny: ['mcp__exa__web_search_exa'] })
  assert.equal(lift(), 'lifted')
})

if (failed) {
  console.log('\nselftest: FAILED')
  process.exit(1)
}
console.log('\nselftest-mcp: all checks passed')
