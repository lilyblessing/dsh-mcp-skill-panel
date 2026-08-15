// 构建：tsc 生成 lib/types + tsdown 打包 node/client，产物验证
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

run([join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.dts.json'])
run([join('node_modules', 'tsdown', 'bin', 'tsdown.js'), '-c', 'tsdown.config.ts'])
console.log('build done')
