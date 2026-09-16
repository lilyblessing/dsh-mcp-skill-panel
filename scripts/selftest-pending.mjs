// 临时 Node 自测：P1 会话边界生效链路（构建产物 lib/index.js）。
// 覆盖：applyPendingMcp 的 state.json 残留兜底（desired 应用到 live）、外部修改尊重与
// 残留清除、内存队列应用与幂等、syncPresetFiles 物化闭环（lastApplied 同步，
// 防二次启动误判外部修改而放弃管理）。
// 用法：node scripts/selftest-pending.mjs （在包根目录运行）
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// state.ts 用 homedir() 定位 ~/.dsh/dsh-mcp-skill-panel/state.json：
// 指向临时 HOME，确保自测不触碰真实用户状态（Windows 读 USERPROFILE）。
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-pending-selftest-'))
process.env.USERPROFILE = fakeHome
if (process.platform !== 'win32') process.env.HOME = fakeHome

/* ── 宿主闭包回填（P0-3）─────────────────────────────────────────────────────
 * lib/index.js → @deepseek-ai/dsh-agent-presets 的 **peerDependencies** 里有三个
 * 本仓 devDependencies 未列、npm 安装也不会装的真实包：
 *   @deepseek-ai/dsh-home-paths / @deepseek-ai/cordis-plugin-include / @deepseek-ai/dsh-atomic-write
 * 缺它们时 import lib/index.js 直接 ERR_MODULE_NOT_FOUND → 全部断言零执行（本次修复的故障现场）。
 * 三个里只有 dsh-home-paths 是纯路径解析（可以零依赖等价），另两个是宿主真逻辑包 ——
 * 拿等价实现顶替等于自我欺骗，故改为**回填宿主真闭包**，口径与 scripts/deploy-link.mjs 一致
 * （默认 ~/.dsh/profiles/web/node_modules/@deepseek-ai，可用 DSH_HOST_SCOPE 覆盖）。
 * 只在本地解析失败时回填，故装机/完整安装环境下本段完全不介入。
 */
const HOST_SCOPE = (process.env.DSH_HOST_SCOPE ?? 'C:/Users/lily/.dsh/profiles/web/node_modules/@deepseek-ai').replace(/\\/g, '/')
const hostFilled = []
let hostScopeUsable = false
if (existsSync(HOST_SCOPE)) {
  const { createRequire, registerHooks } = await import('node:module')
  if (typeof registerHooks === 'function') {
    const hostRequire = createRequire(join(dirname(HOST_SCOPE), '__host_basis__.js'))
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context)
        } catch (error) {
          if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error
          const resolved = hostRequire.resolve(specifier)
          hostFilled.push(specifier)
          return { url: pathToFileURL(resolved).href, shortCircuit: true }
        }
      },
    })
    hostScopeUsable = true
  }
}

/** 宿主闭包不完整时硬失败：打印缺什么 + 怎么修，绝不静默跳过断言。 */
const loadHostDependent = async (url, label) => {
  try {
    return await import(url)
  } catch (error) {
    console.error('FATAL: 宿主闭包不完整，无法加载构建产物 —— 拒绝静默跳过（断言不执行即不算通过）。')
    console.error(`       产物：${label}`)
    console.error(`       原因：${error && error.message ? error.message : String(error)}`)
    console.error(`       宿主闭包：DSH_HOST_SCOPE=${HOST_SCOPE}（存在=${existsSync(HOST_SCOPE)}${existsSync(HOST_SCOPE) && !hostScopeUsable ? '，但当前 Node 无 module.registerHooks → 无法回填' : ''}）`)
    console.error('       修法：把缺失的 @deepseek-ai/* 宿主 peer 装进 devDependencies（并同步 package-lock.json），')
    console.error('             或用 DSH_HOST_SCOPE 指向宿主真闭包（装机侧 profiles/web/node_modules/@deepseek-ai）。')
    process.exit(1)
  }
}

const index = await loadHostDependent(pathToFileURL(join(root, 'lib', 'index.js')).href, 'lib/index.js')
const { applyPendingMcp, pendingMcp, syncPresetFiles, writeState } = index
if (hostFilled.length > 0) {
  console.log(`NOTICE 宿主闭包回填 ${new Set(hostFilled).size} 个 devDep 缺口：${[...new Set(hostFilled)].join(', ')}（源自 ${HOST_SCOPE}）`)
}

let failed = false
let passed = 0
const checkAsync = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed = true
    console.log(`FAIL ${label}`)
    console.log(`     ${error && error.message ? error.message : String(error)}`)
  }
}

/* ── 夹具：内存 loader + 临时预设组合文件；state 经模块 writeState 写入 ── */

const stateDir = join(fakeHome, '.dsh', 'dsh-mcp-skill-panel')
mkdirSync(stateDir, { recursive: true })
let caseNo = 0

const presetText = (rows) =>
  rows
    .map((r) => `- id: ${r.id}\n${r.disabled !== undefined ? `  disabled: ${r.disabled}\n` : ''}`)
    .join('\n')

const makeHarness = async ({ rows }) => {
  const dir = join(tmpdir(), 'dsh-pending-case', String(caseNo++))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'agent.cordis.yml')
  await writeFile(file, presetText(rows), 'utf8')
  const updates = []
  const markUser = []
  const entries = rows.map((r) => ({
    id: r.id,
    options: { id: r.id, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: r.id } },
    parent: { tree: { filename: file } },
    disabled: r.disabled === true,
    fiber: undefined,
    async update(patch) {
      updates.push({ id: r.id, disabled: patch.disabled })
      this.disabled = patch.disabled
    },
  }))
  const ctx = {
    loader: {
      entries: () => entries,
      resolve: (id) => entries.find((e) => e.id === id),
    },
    agents: { list: () => [] },
    logger: { info: () => {}, warn: () => {} },
  }
  const controller = { markUserEnabled: (name) => markUser.push(name) }
  return { file, entries, updates, markUser, ctx, controller }
}

const readStateFile = async () => JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'))

/* ── 场景 1：残留兜底 —— desired 应用到 live + 外部修改尊重 ──────────── */

await checkAsync('残留兜底：desired 不一致的行被应用；外部修改行被尊重并清除残留', async () => {
  const h = await makeHarness({ rows: [{ id: 'sqlite' }, { id: 'chrome', disabled: true }] })
  await writeState({
    mcp: {
      [h.file]: {
        sqlite: { desired: true, lastApplied: null }, // 残留：从未物化（文件无键）→ 应被应用为 live
        chrome: { desired: false, lastApplied: null }, // 文件已被外部改成 disabled:true → 尊重并清除残留
      },
    },
  })
  const applied = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied, 1, '只应应用 sqlite 一行')
  assert.deepEqual(h.updates, [{ id: 'sqlite', disabled: true }], 'sqlite 被更新为停用')
  assert.equal(h.entries.find((e) => e.id === 'sqlite').disabled, true)
  assert.equal(h.markUser.length, 0, '停用方向不标记 markUserEnabled')
  const base = await readStateFile()
  // 2026-08-27 语义修复：外部修改不再删除条目 —— desired 保留（用户意图不丢），
  // lastApplied 对齐现实（cur=true），面板可重新 toggle 接管
  assert.deepEqual(base.mcp[h.file].chrome, { desired: false, lastApplied: true }, '外部修改行保留条目且 lastApplied 对齐')
  assert.ok(base.mcp[h.file].sqlite, 'sqlite 行保留')
})

/* ── 场景 2：启用方向的残留兜底触发 markUserEnabled ─────────────────── */

await checkAsync('启用方向的残留应用触发 markUserEnabled', async () => {
  const h = await makeHarness({ rows: [{ id: 'sqlite', disabled: true }] })
  await writeState({
    mcp: {
      [h.file]: { sqlite: { desired: false, lastApplied: true } }, // 文件已物化停用，用户意图为启用
    },
  })
  const applied = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied, 1)
  assert.deepEqual(h.updates, [{ id: 'sqlite', disabled: false }])
  assert.deepEqual(h.markUser, ['sqlite'], '启用方向应 markUserEnabled')
})

/* ── 场景 3：内存队列应用 + 幂等 ────────────────────────────────────── */

await checkAsync('内存队列应用与成功后清空；二次调用幂等无动作', async () => {
  const h = await makeHarness({ rows: [{ id: 'sqlite' }] })
  pendingMcp.set('sqlite', { entryId: 'sqlite', file: h.file, rowId: 'sqlite', disabled: true })
  const applied1 = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied1, 1)
  assert.deepEqual(h.updates, [{ id: 'sqlite', disabled: true }])
  assert.equal(pendingMcp.size, 0, '成功后队列清空')
  const applied2 = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied2, 0, '状态一致后二次调用无动作')
})

/* ── 场景 4：物化闭环（lastApplied 修复点） ──────────────────────────── */

await checkAsync('syncPresetFiles 物化后 lastApplied 同步，二次启动不误判放弃', async () => {
  const h = await makeHarness({ rows: [{ id: 'sqlite' }] })
  await writeState({
    mcp: { [h.file]: { sqlite: { desired: true, lastApplied: null } } },
  })
  // 第一次「启动」：物化 desired → 文件写入 disabled: true，lastApplied 同步为 true
  const n1 = await syncPresetFiles(h.ctx)
  assert.equal(n1, 1, '首次物化 1 行')
  const text1 = await readFile(h.file, 'utf8')
  assert.match(text1, /disabled: true/, '预设文件已写入 disabled: true')
  const base = await readStateFile()
  assert.equal(base.mcp[h.file].sqlite.lastApplied, true, '物化后 lastApplied 应同步为 desired（修复点）')
  // 第二次「启动」：cur(文件) === lastApplied → 不误判外部修改，也不重复物化
  const n2 = await syncPresetFiles(h.ctx)
  assert.equal(n2, 0, '二次物化应为 0（状态一致）')
  const after = await readStateFile()
  assert.ok(after.mcp[h.file].sqlite, '行未被误判放弃（旧逻辑此处会删除该行）')
  assert.equal(after.mcp[h.file].sqlite.lastApplied, true)
  // 模拟重启后 loader 从已物化文件加载（live 与文件同步）→ applyPending 无动作
  h.entries.find((e) => e.id === 'sqlite').disabled = true
  const applied = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied, 0)
})

/* ── 场景 5：外部修改在物化链路中被放弃且不残留 ─────────────────────── */

await checkAsync('外部修改行在物化链路中不被覆盖，条目保留且 lastApplied 对齐', async () => {
  const h = await makeHarness({ rows: [{ id: 'chrome', disabled: true }] })
  await writeState({
    mcp: { [h.file]: { chrome: { desired: false, lastApplied: null } } },
  })
  // 物化：cur(true) !== lastApplied(null) → 外部修改判定 → 不写文件、条目保留、lastApplied 对齐
  await syncPresetFiles(h.ctx)
  const base = await readStateFile()
  assert.deepEqual(base.mcp[h.file].chrome, { desired: false, lastApplied: true }, '条目保留（不丢用户意图）且 lastApplied 对齐 cur')
  const text = await readFile(h.file, 'utf8')
  assert.match(text, /disabled: true/, '外部修改不被物化覆盖')
})

console.log(failed ? `\nselftest-pending: FAILED (${passed} passed)` : `\nselftest-pending: all checks passed (${passed} checks)`)
rmSync(fakeHome, { recursive: true, force: true })
rmSync(join(tmpdir(), 'dsh-pending-case'), { recursive: true, force: true })
process.exit(failed ? 1 : 0)