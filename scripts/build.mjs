// 构建：tsdown 打包 node/client → 最后 tsc 生成 lib/types（顺序不可换！
// tsdown 的 clean 会清掉 lib/，先 tsc 后 tsdown 会把生成的 d.ts 一起删掉，
// 导致 package.json 的 types/types 字段悬空 —— 见 verify 的 lib/types 检查）
// 注意：不用 npx/cmd 垫片（沙箱 spawn 限制），直接 node 调 bin 入口
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const node = process.execPath
const run = (args) => {
  console.log(`> node ${args.join(' ')}`)
  execFileSync(node, args, { cwd: root, stdio: 'inherit' })
}

run([join('node_modules', 'tsdown', 'dist', 'run.mjs'), '-c', 'tsdown.config.ts'])
run([join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.dts.json'])
console.log('build done')
