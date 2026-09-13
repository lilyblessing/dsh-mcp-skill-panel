/**
 * 部署 0.5.7 到「link 形态」的正确结构（2026-09-13 定稿）。
 *
 * 为什么不能直接把 profile 的 junction 指向仓库目录：
 *   Node 解析 `@deepseek-ai/*` 时**先命中插件自己的 node_modules**，而仓库里那份是
 *   开发副本（0.1.2-rc.1）。于是 dsh-agent-presets 变成第二份实例 → 它内部记录
 *   standing 挂载的**模块私有 WeakMap** 看不到宿主挂载 → preset 行句柄静默失联。
 *   A/B 预启动对「挪开开发 node_modules」的判据是**整个 DSH 起不来**：
 *     Cannot find package '@deepseek-ai/schemastery' imported from …\lib\index.js
 *   （宿主并不提供该包给插件树，详见本次会话取证。）
 *
 * 为什么部署目录必须**不在仓库树内**（本文件用 dsh-plugin-develop/.deploy/）：
 *   只要插件目录的祖先里有那个开发 node_modules，它就会抢先被解析到。放到仓库树外，
 *   解析链变成 deploy/node_modules/@deepseek-ai/* → 宿主同一份实例。
 *
 * 产出结构：
 *   .deploy/dsh-mcp-skill-panel/
 *     ├─ lib/            ← 从仓库 lib 复制
 *     ├─ cordis.patch.yml, package.json, README*.md, LICENSE
 *     └─ node_modules/@deepseek-ai/  ← Junction 指向 profiles\node_modules\@deepseek-ai
 *
 * 用法：
 *   node scripts/deploy-link.mjs            # 构建产物 → .deploy（假定已 npm run build）
 *   node scripts/deploy-link.mjs --build    # 先跑 npm run build 再部署
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const deployRoot = process.env.DSH_DEPLOY_ROOT ?? join(root, '..', '.deploy')
const target = join(deployRoot, 'dsh-mcp-skill-panel')
/** 宿主 @deepseek-ai/* 的真实落点（profiles 基准；可用 DSH_HOST_SCOPE 覆盖）。 */
const hostScope =
  process.env.DSH_HOST_SCOPE ?? 'C:/Users/lily/.dsh/profiles/node_modules/@deepseek-ai'

if (process.argv.includes('--build')) {
  console.log('> npm run build')
  execFileSync(process.execPath, [join('scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' })
}

const srcLib = join(root, 'lib')
if (!existsSync(join(srcLib, 'index.js'))) {
  console.error(`未找到构建产物 ${join(srcLib, 'index.js')}，先跑 npm run build`)
  process.exit(1)
}
if (!existsSync(hostScope)) {
  console.error(`宿主 scoped 目录不存在：${hostScope}\n  用 DSH_HOST_SCOPE 指定正确路径。`)
  process.exit(1)
}

// 干净重建（保留 deploy 根，只重建本包目录）
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

cpSync(srcLib, join(target, 'lib'), { recursive: true })
for (const f of ['package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(target, f))
}
// 部署清单（自证：谁、何时、哪个构建）
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
writeFileSync(
  join(target, 'DEPLOY.json'),
  `${JSON.stringify({ package: 'dsh-mcp-skill-panel', version, source: root, hostScope, at: new Date().toISOString() }, null, 2)}\n`,
)

// 关键接线：@deepseek-ai/* 一律指向宿主同一份实例。
// symlinkSync(target, path) —— target 是宿主 scoped 目录，path 是部署目录里的链接位。
const scopeDir = join(target, 'node_modules', '@deepseek-ai')
mkdirSync(dirname(scopeDir), { recursive: true })
rmSync(scopeDir, { recursive: true, force: true })
symlinkSync(hostScope, scopeDir, 'junction')

console.log(`部署完成：${target}`)
console.log(`  version      ${version}`)
console.log(`  @deepseek-ai → ${hostScope}  (junction)`)
console.log('\n接下来把 profile 的插件目录指向它（需管理员/提权）：')
console.log(`  Remove-Item 'C:\\Users\\lily\\.dsh\\profiles\\web\\node_modules\\dsh-mcp-skill-panel' -Recurse -Force`)
console.log(`  New-Item -ItemType Junction -Path 'C:\\Users\\lily\\.dsh\\profiles\\web\\node_modules\\dsh-mcp-skill-panel' -Target '${target}'`)
