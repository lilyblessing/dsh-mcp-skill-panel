// 把 DSH 闭包类型 junction 进本仓库 node_modules，供 tsc/tsdown 解析。
// 源头：~/.dsh/profiles/web/node_modules/@deepseek-ai（web 侧真实目录，241 项 package.json 全通）
// 平台：Windows 用 junction（mklink /J，无需管理员）；POSIX 用目录符号链接（symlinkSync dir）。
//
// ⚠️ 2026-09-15 修正：原默认源头是 `~/.dsh/profiles/node_modules/@deepseek-ai`（pnpm 扁平层），
// 该扁平层在 2026-09-13 junction 事故后**已断链**（240 项里 170 项 package.json 不可达，含
// dsh-agent-presets/dsh-tools/dsh-scope）—— 用它做源头，junction 出来的依赖树在**冷启动**时
// 全部 MODULE_NOT_FOUND（运行中的进程因模块已入内存而不暴露）。口径与 scripts/deploy-link.mjs
// 的 DSH_HOST_SCOPE 一致。
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const home = os.homedir()
const profileNodeModules = join(home, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai')
const localScoped = join(root, 'node_modules', '@deepseek-ai')
const dryRun = process.argv.includes('--dry-run')
// Windows 专有 mklink /J；其余平台走目录符号链接（POSIX 无 mklink）。
const isWindows = process.platform === 'win32'
const linkKind = isWindows ? 'junction' : 'symlink'

/** 源头健康度计数：总数 / 可用（package.json 可解析）/ 缺失。不可读时全 0 并置 unreadable。 */
const countClosure = (dir) => {
  try {
    if (!statSync(dir).isDirectory()) return { total: 0, available: 0, missing: 0, unreadable: true }
  } catch {
    return { total: 0, available: 0, missing: 0, unreadable: true }
  }
  const names = readdirSync(dir)
  let available = 0
  for (const name of names) {
    try {
      JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8'))
      available += 1
    } catch {
      /* 断链/不可读 → 计入缺失 */
    }
  }
  return { total: names.length, available, missing: names.length - available, unreadable: false }
}

const closure = countClosure(profileNodeModules)
console.log(`closure source ${profileNodeModules}`)
console.log(`  packages: total=${closure.total} available=${closure.available} missing=${closure.missing}`)

if (closure.unreadable) {
  console.warn(`warn closure source unreadable: ${profileNodeModules}`)
  console.warn(`     packages: total=${closure.total} available=${closure.available} missing=${closure.missing}`)
  console.warn('     修法：确认 DSH 装机侧 web profile 存在（…\\.dsh\\profiles\\web\\node_modules\\@deepseek-ai）；')
  console.warn('           旧的 …\\.dsh\\profiles\\node_modules\\@deepseek-ai 扁平层已断链，勿再用。')
  process.exit(1)
}
if (closure.missing > 0) {
  console.warn(`warn closure source partially broken: ${closure.missing}/${closure.total} 项 package.json 不可解析（junction 后会冷启动 MODULE_NOT_FOUND）`)
}

if (dryRun) console.log('[dry-run] 只读校验：不建 junction、不动 node_modules')
else mkdirSync(localScoped, { recursive: true })

let linked = 0
for (const name of readdirSync(profileNodeModules)) {
  const target = join(profileNodeModules, name)
  const link = join(localScoped, name)
  if (existsSync(link)) {
    if (dryRun) console.log(`[dry-run] present  ${name}`)
    continue
  }
  if (dryRun) {
    console.log(`[dry-run] ${linkKind} ${name} -> ${target}`)
    continue
  }
  try {
    if (isWindows) {
      // Windows: mklink /J 需要 cmd；junction 无需管理员
      execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
    } else {
      // POSIX: 目录符号链接（第三个实参 'dir' 在非 Windows 上被忽略）
      symlinkSync(target, link, 'dir')
    }
    linked += 1
    console.log(`${linkKind} ${name}`)
  } catch (error) {
    console.error(`failed to ${linkKind} ${name}:`, String(error))
  }
}
console.log(
  dryRun
    ? `[dry-run] dsh closure ${linkKind}s ready (no changes made)`
    : `dsh closure ${linkKind}s ready (${linked} new)`,
)
