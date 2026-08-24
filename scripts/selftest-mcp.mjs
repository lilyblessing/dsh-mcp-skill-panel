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

check('searchCatalog 打分排序：描述命中 > 未命中、工具名命中权重高', () => {
  const c = buildCatalog()
  // "integ" 是 mcp__calcmcp__integrate 工具名 token 的前缀 → 命中且最高分
  const hits = catalog.searchCatalog(c, 'integ')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].server, 'calcmcp')
  assert.equal(hits[0].tool.name, 'mcp__calcmcp__integrate')
  // 工具名命中 "read"（read_memory）
  const readHits = catalog.searchCatalog(c, 'read')
  assert.equal(readHits[0].tool.name, 'mcp__cheatengine__read_memory')
  assert.ok(readHits[0].server === 'cheatengine')
  // 无命中时为空
  assert.equal(catalog.searchCatalog(c, 'zzzznope').length, 0)
})

check('searchCatalog 参数名命中权重', () => {
  const c = buildCatalog()
  // "addr" 是多个工具的参数名；权重 1 但应命中
  const hits = catalog.searchCatalog(c, 'addr', 5)
  assert.ok(hits.length > 0)
  assert.ok(hits.every((h) => ['read_memory', 'write_memory'].includes(h.tool.name.split('__').pop())))
})

check('searchCatalog 空 query 返回空；limit 被尊重', () => {
  const c = buildCatalog()
  assert.equal(catalog.searchCatalog(c, '').length, 0)
  assert.ok(catalog.searchCatalog(c, 'memory', 1).length <= 1)
  // 默认 limit=5
  const all = catalog.searchCatalog(c, 'read write navigate integ matrix addr url', 10)
  assert.ok(all.length >= 4)
})

check('listServer 返回精简名+描述；未知 server undefined', () => {
  const c = buildCatalog()
  const chrome = catalog.listServer(c, 'chrome')
  assert.ok(chrome)
  assert.equal(chrome.length, 1)
  assert.equal(chrome[0].name, 'mcp__chrome__navigate')
  assert.equal(chrome[0].description, '导航到 URL')
  assert.equal(catalog.listServer(c, 'nope'), undefined)
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

if (failed) {
  console.log('\nselftest: FAILED')
  process.exit(1)
}
console.log('\nselftest-mcp: all checks passed')
