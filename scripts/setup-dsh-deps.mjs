// 把 DSH 闭包类型 junction 进本仓库 node_modules，供 tsc/tsdown 解析。
// 目标：~/.dsh/profiles/node_modules/@deepseek-ai（全部为 junction → 主闭包）
import { existsSync, mkdirSync } from 'node:fs'
import { readdirSync } from 'node:fs'
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

for (const name of readdirSync(profileNodeModules)) {
  const target = join(profileNodeModules, name)
  const link = join(localScoped, name)
  if (existsSync(link)) continue
  try {
    // Windows: mklink /J 需要 cmd；junction 无需管理员
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
    console.log(`junction ${name}`)
  } catch (error) {
    console.error(`failed to junction ${name}:`, String(error))
  }
}
console.log('dsh closure junctions ready')
