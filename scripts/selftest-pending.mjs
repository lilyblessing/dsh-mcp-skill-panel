// 临时 Node 自测：P1 会话边界生效链路（构建产物 lib/index.js）。
// 覆盖：applyPendingMcp 的 state.json 残留兜底（desired 应用到 live）、外部修改尊重与
// 残留清除、内存队列应用与幂等、syncPresetFiles 物化闭环（lastApplied 同步，
// 防二次启动误判外部修改而放弃管理）。
// 用法：node scripts/selftest-pending.mjs （在包根目录运行）
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
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

const index = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
const { applyPendingMcp, pendingMcp, syncPresetFiles, writeState } = index

let failed = false
const checkAsync = async (label, fn) => {
  try {
    await fn()
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
  assert.equal(base.mcp[h.file].chrome, undefined, '外部修改行的残留应从 state 清除（徽标不再悬挂）')
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

await checkAsync('外部修改行在物化链路中被放弃，文件保持用户原样', async () => {
  const h = await makeHarness({ rows: [{ id: 'chrome', disabled: true }] })
  await writeState({
    mcp: { [h.file]: { chrome: { desired: false, lastApplied: null } } },
  })
  // 物化：cur(true) !== lastApplied(null) → 放弃该行 → 残留清除
  await syncPresetFiles(h.ctx)
  const base = await readStateFile()
  assert.equal(base.mcp[h.file].chrome, undefined, '放弃行的残留应从 state 清除')
  const text = await readFile(h.file, 'utf8')
  assert.match(text, /disabled: true/, '外部修改不被物化覆盖')
})

console.log(failed ? '\nselftest-pending: FAILED' : '\nselftest-pending: all checks passed')
rmSync(fakeHome, { recursive: true, force: true })
rmSync(join(tmpdir(), 'dsh-pending-case'), { recursive: true, force: true })
process.exit(failed ? 1 : 0)