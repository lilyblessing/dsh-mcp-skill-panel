// 产物验证：无 TOOL_RUNTIME_SCHEDULER 内联、external import 正确、导出完整、类型产物齐全
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let failed = false
// 注意：check 必须**返回布尔** —— 多处用法是 `if (check(...)) { …细粒度断言… }`。
// 早先这里没有 return（返回 undefined），使那些内层断言恒不执行：row-display 与 session-scope
// 两组「零依赖独立产物」的内层断言其实一直是死代码（2026-09-16 独立审查 WARN-1，实测输出为证）。
const check = (ok, label) => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  return ok
}

const nodeOut = join(root, 'lib', 'index.js')
const clientOut = join(root, 'lib', 'client.js')
const typesDir = join(root, 'lib', 'types')

check(existsSync(nodeOut), `node bundle exists: ${nodeOut}`)
check(existsSync(clientOut), `client bundle exists: ${clientOut}`)
check(existsSync(typesDir) && readdirSync(typesDir, { recursive: true }).some((f) => String(f).endsWith('.d.ts')), 'lib/types/*.d.ts generated (package.json types must not dangle)')

if (existsSync(nodeOut)) {
  const src = readFileSync(nodeOut, 'utf8')
  const inline = (src.match(/TOOL_RUNTIME_SCHEDULER/g) || []).length
  check(inline === 0, `no inlined TOOL_RUNTIME_SCHEDULER (found ${inline})`)
  check(/import\s*\{[^}]*scopeOf[^}]*\}\s*from\s*"@deepseek-ai\/dsh-scope"/.test(src), 'external dsh-scope import kept')
  check(/import\s+Schema\s+from\s*"@deepseek-ai\/schemastery"/.test(src), 'external schemastery import kept')
  // 0.5.7 回归：agent-presets 必须外置。它内部用**模块私有 WeakMap** 记录 standing
  // 挂载（lib/index.js:622 mounted / :639 mounted.set），内联成第二份实例会让
  // livePresetMounts() 恒返回 []，preset 行句柄再次失联 —— 与 dsh-tools 双实例同类事故。
  check(
    /from\s*"@deepseek-ai\/dsh-agent-presets"/.test(src),
    'external dsh-agent-presets import kept (inlining breaks preset row handles)',
  )
}

if (existsSync(clientOut)) {
  const src = readFileSync(clientOut, 'utf8')
  check(src.includes('__ModuleLoader__.load'), 'client wrapped with __ModuleLoader__.load')
  check(src.includes('exports.apply = apply'), 'client exports.apply')
  check(src.includes('exports.inject = inject'), 'client exports.inject')
  check(src.includes('require("react")') || src.includes('require(\'react\')'), 'react kept external')
}

// 0.6.0：row-display 必须是零依赖独立产物（selftest 靠它绕开宿主包解析）。
{
  const rowDisplayOut = join(root, 'lib', 'row-display.js')
  if (check(existsSync(rowDisplayOut), `row-display standalone bundle exists: ${rowDisplayOut}`)) {
    const src = readFileSync(rowDisplayOut, 'utf8')
    check(!/^\s*import\s/m.test(src), 'row-display has zero imports (host-free, selftest-loadable)')
    check(/export\s*\{[^}]*rowDisplay/.test(src), 'row-display exports rowDisplay')
  }
}

// 0.6.0 会话透传：session-scope 同样必须是零依赖独立产物（selftest 直接 import 它）。
{
  const sessionScopeOut = join(root, 'lib', 'session-scope.js')
  if (check(existsSync(sessionScopeOut), `session-scope standalone bundle exists: ${sessionScopeOut}`)) {
    const src = readFileSync(sessionScopeOut, 'utf8')
    check(!/^\s*import\s/m.test(src), 'session-scope has zero imports (host-free, selftest-loadable)')
    check(
      /export\s*\{[^}]*readCurrentSession/.test(src) &&
        /export\s*\{[^}]*withSessionParam/.test(src) &&
        /export\s*\{[^}]*sessionField/.test(src),
      'session-scope exports readCurrentSession / withSessionParam / sessionField',
    )
  }
}

if (failed) process.exit(1)
console.log('verify done: all checks passed')
