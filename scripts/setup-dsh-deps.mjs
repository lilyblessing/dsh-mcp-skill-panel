// 把 DSH 闭包类型链接进本仓库 node_modules，供 tsc/tsdown 解析。
// 来源：~/.dsh/profiles/node_modules/@deepseek-ai（主闭包）
// Windows 用 junction（mklink /J，无需管理员），POSIX 用符号链接。
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const home = os.homedir()
const profileNodeModules = join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
const localScoped = join(root, 'node_modules', '@deepseek-ai')

if (!existsSync(profileNodeModules)) {
  console.error(`closure not found: ${profileNodeModules}`)
  process.exit(1)
}

mkdirSync(localScoped, { recursive: true })

let linked = 0
for (const name of readdirSync(profileNodeModules)) {
  const target = join(profileNodeModules, name)
  const link = join(localScoped, name)
  if (existsSync(link)) continue
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
    } else {
      symlinkSync(target, link, 'dir')
    }
    linked += 1
  } catch (error) {
    console.error(`failed to link ${name}:`, String(error))
  }
}
console.log(`dsh closure links ready (${linked} new)`)
