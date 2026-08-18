// 产物验证：无 TOOL_RUNTIME_SCHEDULER 内联、external import 正确、导出完整、类型产物齐全
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let failed = false
const check = (ok, label) => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
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
}

if (existsSync(clientOut)) {
  const src = readFileSync(clientOut, 'utf8')
  check(src.includes('__ModuleLoader__.load'), 'client wrapped with __ModuleLoader__.load')
  check(src.includes('exports.apply = apply'), 'client exports.apply')
  check(src.includes('exports.inject = inject'), 'client exports.inject')
  check(src.includes('require("react")') || src.includes('require(\'react\')'), 'react kept external')
}

if (failed) process.exit(1)
console.log('verify done: all checks passed')
