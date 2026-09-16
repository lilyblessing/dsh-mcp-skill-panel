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
/**
 * 宿主 @deepseek-ai/* 的真实落点（web profile 基准；可用 DSH_HOST_SCOPE 覆盖）。
 *
 * 2026-09-13 修正：原默认值是 `profiles/node_modules/@deepseek-ai`（pnpm 扁平层），
 * 而**那个扁平层在 junction 事故后已断链**（240 项里 170 项 package.json 不可达，
 * 含 dsh-agent-presets / dsh-tools / dsh-scope）。指向它的部署目录在**冷启动**时
 * 全部 MODULE_NOT_FOUND —— 实测（改动前）：
 *   FAIL [deploy] @deepseek-ai/dsh-agent-presets -> MODULE_NOT_FOUND
 *   （运行中的进程因模块已入内存而不暴露这个问题）
 * 而 web profile 侧的 `node_modules/@deepseek-ai` 是**修好的真实目录**（241 项全通），
 * 与扁平层同源（realpath 均为 .pnpm/@deepseek-ai+<pkg>@0.1.5-rc.2…\node_modules\…），
 * 故以它为基准。改基准后同一基准测试 3/3 解析成功。
 */
const hostScope =
  process.env.DSH_HOST_SCOPE ?? 'C:/Users/lily/.dsh/profiles/web/node_modules/@deepseek-ai'

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
// 安全性说明（2026-09-13 实测）：`rmSync(..., {recursive:true})` **不跟随 junction**
// （沙箱验证：删掉含 junction 的父目录后，两个链接目标 marker 文件均存活），
// 故这里的 clean 重建不会伤到宿主 scope 或 pnpm 商店。
const scopeDir = join(target, 'node_modules', '@deepseek-ai')
mkdirSync(dirname(scopeDir), { recursive: true })
rmSync(scopeDir, { recursive: true, force: true })
symlinkSync(hostScope, scopeDir, 'junction')

console.log(`部署完成：${target}`)
console.log(`  version      ${version}`)
console.log(`  @deepseek-ai → ${hostScope}  (junction)`)
console.log('\n接下来把 profile 的插件目录指向它（需管理员/提权）：')
console.log('  # ⚠️ 移动语义，禁止 Remove-Item -Recurse（junction 事故约束 2026-09-13）')
console.log(`  Move-Item 'C:\\Users\\lily\\.dsh\\profiles\\web\\node_modules\\dsh-mcp-skill-panel' 'C:\\Users\\lily\\.dsh\\.backup-deleted\\plugin-junction-<stamp>'`)
console.log(`  New-Item -ItemType Junction -Path 'C:\\Users\\lily\\.dsh\\profiles\\web\\node_modules\\dsh-mcp-skill-panel' -Target '${target}'`)
