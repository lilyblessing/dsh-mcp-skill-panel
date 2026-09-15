/**
 * setRowConfigKeys / configValueToYaml 的节点自测（node scripts/selftest-rowconfig.mjs）。
 *
 * 覆盖真实的预设行形态（缩进 2/4）、已有 config 块、以及"键不存在需新建 config 块"。
 * 这是「更多配置」写盘路径的核心：写坏预设 = 打崩用户的组合树，所以必须先过这里。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'lib', '.selftest')
mkdirSync(outDir, { recursive: true })

// 用独立产物 lib/preset-text.js（纯文本函数、零宿主依赖；index.js 会连带加载
// @deepseek-ai/* 宿主包，仓库里的 devDependencies 不完整会直接 ERR_MODULE_NOT_FOUND）
const entry = join(root, 'lib', 'preset-text.js')
const mod = await import(`file://${entry.replace(/\\/g, '/')}`)
const { setRowConfigKeys, configValueToYaml, configKeysToYamlText } = mod

let failed = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    console.log('  --- expected ---')
    console.log(expected)
    console.log('  --- actual ---')
    console.log(actual)
  }
}

// ① 已有 config 块：新增 key（插到块末尾）
const fixture1 = [
  '- id: mcp-codegraph',
  '  disabled: true',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  config:',
  '    serverName: codegraph',
  '    transport: stdio',
  '    command: codegraph',
  "    args: ['serve', '--mcp']",
  '',
  '- id: mcp-exa',
  '  config:',
  '    serverName: exa',
  '',
].join('\n')
check(
  '① 已有 config 块 → 追加 cwd',
  setRowConfigKeys(fixture1, 'mcp-codegraph', { cwd: 'D:\\a\\b' }),
  [
    '- id: mcp-codegraph',
    '  disabled: true',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: codegraph',
    '    transport: stdio',
    '    command: codegraph',
    "    args: ['serve', '--mcp']",
    '    cwd: D:\\a\\b',
    '',
    '- id: mcp-exa',
    '  config:',
    '    serverName: exa',
    '',
  ].join('\n'),
)

// ② 已有同名 key → 覆盖，且幂等
const once = setRowConfigKeys(fixture1, 'mcp-codegraph', { cwd: 'D:\\a\\b' })
const twice = setRowConfigKeys(once, 'mcp-codegraph', { cwd: 'D:\\a\\b' })
check('② 同键覆盖幂等', twice, once)

// ③ 覆盖既有值（serverName → 改值）
check(
  '③ 覆盖既有键的值',
  setRowConfigKeys(fixture1, 'mcp-codegraph', { command: 'codegraph2' }).includes('    command: codegraph2'),
  true,
)

// ④ 删除键
check(
  '④ 删除 args 键',
  setRowConfigKeys(fixture1, 'mcp-codegraph', {}, ['args']).includes('args:'),
  false,
)

// ⑤ 无 config 块 → 新建（行尾插入）
const fixture2 = ['- id: mcp-x', '  disabled: true', '', '- id: mcp-y', '  disabled: false', ''].join('\n')
check(
  '⑤ 无 config 块 → 新建',
  setRowConfigKeys(fixture2, 'mcp-x', { command: 'foo' }),
  ['- id: mcp-x', '  disabled: true', '  config:', '    command: foo', '', '- id: mcp-y', '  disabled: false', ''].join('\n'),
)

// ⑥ 不误伤相邻行
check(
  '⑥ 不误伤相邻行',
  setRowConfigKeys(fixture1, 'mcp-codegraph', { cwd: 'X' }).includes('  config:\n    serverName: exa'),
  true,
)

// ⑦ 值序列化（引号/特殊字符/数组/对象/布尔/数字）
check('⑦a 普通路径裸写', configValueToYaml('D:\\a\\b'), 'D:\\a\\b')
check('⑦b 含空格 → 单引号', configValueToYaml('C:\\Program Files\\x'), "'C:\\Program Files\\x'")
check('⑦c 单引号转义', configValueToYaml("it's"), "'it''s'")
check('⑦d 数组 flow（`--` 开头的项单独加引号，其余裸写）', configValueToYaml(['serve', '--mcp']), "[serve, '--mcp']")
check('⑦d2 无特殊字符的数组项裸写', configValueToYaml(['serve', 'mcp']), '[serve, mcp]')
check('⑦e 布尔', configValueToYaml(true), 'true')
check('⑦f 数字', configValueToYaml(30000), '30000')
// ⑦g 对象 flow。注意 A 是**字符串** '1' → 必须加引号保住类型：
// 裸写 `1` 会被 JSON_SCHEMA 解析成 number，正是本次修的「静默改类型」缺陷。
check('⑦g 对象 flow（字符串数字加引号保类型）', configValueToYaml({ A: '1', B: 2 }), "{ A: '1', B: 2 }")
check('⑦h 稳定性（键排序）', configKeysToYamlText({ b: 1, a: 2 }), 'a: 2\nb: 1')

// ⑧ 覆盖「块映射值」的键：旧子行必须一起替换，不能留孤儿。
//    2026-09-15 实测事故：早先只替换标题行，`env:` 的块映射子行被遗留 →
//    组合文件变成非法 YAML（bad indentation of a mapping entry (389:7)）→
//    预设挂载失败 → 所有旧会话 resume 报错、新会话也建不出来。
const fixture3 = [
  '- id: mcp-mimo-image',
  '  disabled: true',
  '  config:',
  '    serverName: mimo-image',
  '    transport: stdio',
  '    command: python.exe',
  "    args: ['-u', server.py]",
  '    env:',
  "      MIMO_API_KEY: !!js \"process.env.MIMO_API_KEY || ''\"",
  '      MIMO_MODEL: mimo-v2.5',
  '    toolCallTimeoutMs: 300000',
  '',
  '- id: mcp-next',
  '  config:',
  '    serverName: next',
  '',
].join('\n')

const replaced = setRowConfigKeys(fixture3, 'mcp-mimo-image', { env: '{ A: 1 }' })
check(
  '⑧ 覆盖块映射值 → 子行一并替换（无孤儿）',
  replaced,
  [
    '- id: mcp-mimo-image',
    '  disabled: true',
    '  config:',
    '    serverName: mimo-image',
    '    transport: stdio',
    '    command: python.exe',
    "    args: ['-u', server.py]",
    '    env: { A: 1 }',
    '    toolCallTimeoutMs: 300000',
    '',
    '- id: mcp-next',
    '  config:',
    '    serverName: next',
    '',
  ].join('\n'),
)
check('⑧b 无遗留子行', /MIMO_API_KEY/.test(replaced), false)
check('⑧c 相邻行未被误伤', replaced.includes('  config:\n    serverName: next'), true)
check('⑨ 覆盖块映射后幂等', setRowConfigKeys(replaced, 'mcp-mimo-image', { env: '{ A: 1 }' }), replaced)

// ⑩ 删除带块映射值的键 → 子行一起删（原实现只删标题行，同类事故）
const removed = setRowConfigKeys(fixture3, 'mcp-mimo-image', {}, ['env'])
check(
  '⑩ 删除块映射值键 → 子行一并删除',
  removed,
  [
    '- id: mcp-mimo-image',
    '  disabled: true',
    '  config:',
    '    serverName: mimo-image',
    '    transport: stdio',
    '    command: python.exe',
    "    args: ['-u', server.py]",
    '    toolCallTimeoutMs: 300000',
    '',
    '- id: mcp-next',
    '  config:',
    '    serverName: next',
    '',
  ].join('\n'),
)
check('⑩b 删除后无残留', /!!js|MIMO_MODEL/.test(removed), false)

// ⑪ `!!js` 表达式写回标签形态（与 dsh 自己的 represent 一致），不降级成 { __jsExpr: ... }
check('⑪a !!js 标签保留', configValueToYaml({ __jsExpr: "process.env.K || ''" }), '!!js "process.env.K || \'\'"')
check('⑪b 嵌套 !!js 不降级', configValueToYaml({ env: { K: { __jsExpr: 'x' } } }), '{ env: { K: !!js "x" } }')
check(
  '⑪c 真实 env 往返（!!js + 数字串保字符串）',
  configValueToYaml({
    MIMO_API_KEY: { __jsExpr: "process.env.MIMO_API_KEY || process.env.XIAOMI_API_KEY || ''" },
    MIMO_MODEL: 'mimo-v2.5',
    MIMO_TIMEOUT: '300',
  }),
  '{ MIMO_API_KEY: !!js "process.env.MIMO_API_KEY || process.env.XIAOMI_API_KEY || \'\'", MIMO_MODEL: mimo-v2.5, MIMO_TIMEOUT: \'300\' }',
)

// ⑫ 歧义标量必须加引号：组合按 JSON_SCHEMA 解析，裸写会静默改类型
check('⑫a 数字串加引号', configValueToYaml('300'), "'300'")
check('⑫b 布尔串加引号', configValueToYaml('true'), "'true'")
check('⑫c null 串加引号', configValueToYaml('null'), "'null'")
check('⑫d 真布尔仍裸写', configValueToYaml(true), 'true')
check('⑫e 真数字仍裸写', configValueToYaml(300), '300')
check('⑫f 路径仍裸写', configValueToYaml('D:\\a\\b'), 'D:\\a\\b')
check('⑫g 普通字符串仍裸写', configValueToYaml('mimo-v2.5'), 'mimo-v2.5')

if (failed > 0) {
  console.error(`\nrowconfig selftest FAILED: ${failed} check(s)`)
  process.exit(1)
}
console.log('\nrowconfig selftest: all checks passed')
void readFileSync
void writeFileSync
void execFileSync
