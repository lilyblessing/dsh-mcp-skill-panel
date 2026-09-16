/**
 * 模块身份闸门（0.5.7）：证明本插件与宿主组合解析到**同一份** @deepseek-ai/dsh-agent-presets。
 *
 * 为什么必须单独验：dsh-agent-presets 用**模块私有 WeakMap** 记录 standing 挂载
 * （lib/index.js:622 `const mounted = new WeakMap()` / :639 `mounted.set(config, …)`），
 * `livePresetMounts()` / `standingMountFor()` 只能看到**本实例**登记的挂载。若本插件
 * 解析到另一份副本（多版本共存、被 bundle 内联、profile 双层 node_modules 错位），
 * preset 行句柄会静默失联 —— 表现为「可见性又不过滤了」且没有任何报错。
 *
 * 判据（两条都要过，**双侧都用 createRequire**，与 Node 原生解析同算法）：
 *   A. 被验插件基准 —— `PLUGIN_BASIS` 环境变量优先（默认 = 本包目录）。
 *      验装机部署时传装机目录，否则会命中仓库 node_modules 的开发副本（**测量假象**，
 *      2026-09-13 踩过：那样比出来的 FAIL 与运行时无关）。
 *   B. 宿主基准 —— `DSH_MODULE_BASIS` 优先；否则**默认基准** `DSH_HOST_SCOPE`
 *      同口径（scripts/deploy-link.mjs）：`~/.dsh/profiles/web/node_modules/@deepseek-ai`；
 *      再否则本包上层含 `@deepseek-ai` 的 node_modules、NODE_PATH 各段。
 *   两者 realpath 相等 + 导出 livePresetMounts/standingMountFor 才算通过。
 *   任一**声明的基准**不可读即硬 FAIL（非零退出 + 一行明错）—— 不许静默按开发副本下结论。
 *
 * 已知环境事实（2026-09-13 实测，2026-09-15 修订）：
 *   装机 panel（`…\profiles\web\node_modules\dsh-mcp-skill-panel`）**无自带 node_modules**
 *   （纯 tarball 安装）→ 向上回退命中 `…\profiles\web\node_modules\@deepseek-ai\dsh-agent-presets`
 *   （web 侧真实目录，241 项全通）。
 *   ⚠️ 旧口径 `…\profiles\node_modules\@deepseek-ai`（pnpm 扁平层）在 junction 事故后**已断链**
 *   （240 项里 170 项 package.json 不可达，含 dsh-agent-presets/dsh-tools/dsh-scope），
 *   指向它的基准会得出与运行时无关的结论 —— 已废弃，勿再使用。
 *
 * 用法：
 *   node scripts/check-module-identity.mjs
 *   $env:PLUGIN_BASIS='C:\Users\lily\.dsh\profiles\web\node_modules\dsh-mcp-skill-panel'
 *   $env:DSH_MODULE_BASIS='C:\Users\lily\.dsh\profiles\web\node_modules\@deepseek-ai'
 *   node scripts/check-module-identity.mjs
 * exit 1 = 不合格，勿发版。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SPEC = '@deepseek-ai/dsh-agent-presets'
/**
 * 缺省宿主基准（旧的 `…\profiles\node_modules\@deepseek-ai` 扁平层已断链，见文件头）。
 * 与 scripts/deploy-link.mjs 的 `DSH_HOST_SCOPE` 同口径，可用 DSH_MODULE_BASIS 覆盖。
 */
const DEFAULT_HOST_BASIS = (process.env.DSH_HOST_SCOPE ?? 'C:/Users/lily/.dsh/profiles/web/node_modules/@deepseek-ai').replace(/\\/g, '/')

const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

const isReadableDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 基准不可读 = 无结论：硬 FAIL（一行明错 + 非零退出），不许回落到开发副本继续下结论。 */
function requireReadableBasis(label, dir) {
  if (isReadableDir(dir)) return
  console.error(`FAIL baseline unreadable: ${label} = ${dir}`)
  console.error('     基准不可读即无结论（勿按开发副本下结论）；用 PLUGIN_BASIS / DSH_MODULE_BASIS 指向宿主真闭包。')
  process.exit(1)
}

/** 读入口文件所属包的版本（入口恒为 <pkg>/lib/index.js）。 */
function versionAt(entryFile) {
  try {
    return JSON.parse(readFileSync(join(dirname(dirname(entryFile)), 'package.json'), 'utf8')).version ?? '?'
  } catch {
    return '?'
  }
}

/** 用一个基准目录解析 SPEC 的真实路径（createRequire = Node 原生解析算法）。 */
function resolveFrom(basisDir) {
  const req = createRequire(join(basisDir, '__basis__.js'))
  return real(req.resolve(SPEC))
}

/** 宿主基准候选：显式（硬校验）→ 默认 web 侧基准 → 本包上层含 @deepseek-ai 的 node_modules → NODE_PATH 影子树。 */
function hostBases(pluginBasis) {
  const out = []
  const explicit = (process.env.DSH_MODULE_BASIS ?? '').trim()
  if (explicit.length > 0) {
    requireReadableBasis('DSH_MODULE_BASIS', explicit)
    out.push(explicit)
  }
  requireReadableBasis('default host basis', DEFAULT_HOST_BASIS)
  out.push(DEFAULT_HOST_BASIS)
  let dir = pluginBasis
  for (let i = 0; i < 6; i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    const nm = join(parent, 'node_modules')
    // 插件自己的 node_modules 不算宿主基准（那是开发副本）
    if (nm !== join(pluginBasis, 'node_modules') && existsSync(join(nm, '@deepseek-ai'))) out.push(nm)
    dir = parent
  }
  for (const p of (process.env.NODE_PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (p.trim().length > 0) out.push(p.trim())
  }
  return [...new Set(out)]
}

let failed = false
const check = (ok, label, detail) => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `\n       ${detail}` : ''}`)
}

const pluginBasis = (process.env.PLUGIN_BASIS ?? root).trim()
if ((process.env.PLUGIN_BASIS ?? '').trim().length > 0) requireReadableBasis('PLUGIN_BASIS', pluginBasis)

// ── A. 被验插件基准 ────────────────────────────────────────────────────────
let selfPath = null
try {
  selfPath = resolveFrom(pluginBasis)
} catch (error) {
  check(false, `plugin basis cannot resolve ${SPEC}`, `${pluginBasis}\n       ${String(error?.message ?? error)}`)
}
check(
  selfPath !== null,
  'plugin basis resolves @deepseek-ai/dsh-agent-presets',
  selfPath ? `basis: ${pluginBasis}\n       v${versionAt(selfPath)}  ${selfPath}` : '',
)

// ── B. 宿主基准 ────────────────────────────────────────────────────────────
let hostPath = null
let hostBasis = null
const tried = []
for (const basis of hostBases(pluginBasis)) {
  try {
    hostPath = resolveFrom(basis)
    hostBasis = basis
    break
  } catch {
    tried.push(basis)
  }
}
check(
  hostPath !== null,
  'host basis resolves @deepseek-ai/dsh-agent-presets',
  hostPath ? `basis: ${hostBasis}\n       v${versionAt(hostPath)}  ${hostPath}` : `tried: ${tried.join(' | ') || '(no candidate)'}`,
)

// ── 判据：同一物理文件 ─────────────────────────────────────────────────────
if (selfPath && hostPath) {
  check(
    selfPath === hostPath,
    'SAME module instance (preset row handles reachable)',
    selfPath === hostPath ? selfPath : `plugin: ${selfPath}\n       host:   ${hostPath}`,
  )
}

// ── 附带：宿主版本是否提供 standing 读取口 ─────────────────────────────────
if (selfPath) {
  try {
    const mod = await import(new URL(`file://${selfPath.replace(/\\/g, '/')}`).href)
    const hasLive = typeof mod.livePresetMounts === 'function'
    const hasStanding = typeof mod.standingMountFor === 'function'
    check(hasLive && hasStanding, 'exports livePresetMounts + standingMountFor', `livePresetMounts=${hasLive} standingMountFor=${hasStanding}`)
  } catch (error) {
    check(false, 'dynamic import of agent-presets failed', String(error?.message ?? error))
  }
}

if (failed) {
  console.error('\nmodule-identity check FAILED — preset row handles would be silently unreachable.')
  console.error('提示：在仓库里直跑会用**开发副本**基准（本仓 node_modules 的旧版），与装机运行时无关。')
  console.error('      验装机请带两个基准环境变量（web 侧真闭包，勿再用已断链的 profiles\\node_modules 扁平层）：')
  console.error("        $env:PLUGIN_BASIS='…\\profiles\\web\\node_modules\\dsh-mcp-skill-panel'")
  console.error("        $env:DSH_MODULE_BASIS='…\\profiles\\web\\node_modules\\@deepseek-ai'")
  process.exit(1)
}
console.log('\nmodule identity ok: preset row handles reachable from this plugin.')
