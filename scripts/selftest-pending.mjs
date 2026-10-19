// 临时 Node 自测：P1 会话边界生效链路（构建产物 lib/index.js）。
// 覆盖：applyPendingMcp 的 state.json 残留兜底（desired 应用到 live）、内存队列应用与幂等、
// syncPresetFiles 经 configEditor 的物化闭环（0.1.7：写 profile patch 的预设声明行，
// 幂等闸 + 声明行反查不到时的降级）。
// 用法：node scripts/selftest-pending.mjs （在包根目录运行）
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
 * lib/index.js → @deepseek-ai/dsh-agent-preset-registry 的 **peerDependencies** 里有三个
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

/* ── 夹具：内存 loader（含预设声明行）+ configEditor 假件；state 经模块 writeState 写入 ── */

const stateDir = join(fakeHome, '.dsh', 'dsh-mcp-skill-panel')
mkdirSync(stateDir, { recursive: true })

/** 预设声明行的 Loader 行 id（0.1.7 的 state.mcp 第一级键）。 */
const DECL_ROW_ID = 'preset-standard-mcp'

/** configEditor 假件：记录 edit 次数，并按 change 结果更新行 config（供幂等断言）。
 *  declare=false 时 entries 为空 —— 0.1.7 的声明行反查面是 configEditor.entries()
 *  （src/preset.ts 的 syncPresetFiles），假装 loader 没有声明行时必须同时摘掉这一侧，
 *  否则「找不到声明行」的前提不成立。 */
const makeEditor = (config, declare = true) => {
  const entry = { options: { id: DECL_ROW_ID, name: '@deepseek-ai/dsh-agent-preset', config } }
  const editor = {
    entry,
    edits: 0,
    entries: () => (declare ? [entry] : []),
    async edit(target, change) {
      editor.edits += 1
      target.options.config = change(structuredClone(target.options.config ?? {}), {})
    },
  }
  return editor
}

const makeHarness = async ({ rows, declare = true }) => {
  const updates = []
  const markUser = []
  const entries = rows.map((r) => ({
    id: r.id,
    options: { id: r.id, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: r.id } },
    disabled: r.disabled === true,
    fiber: undefined,
    async update(patch) {
      updates.push({ id: r.id, disabled: patch.disabled })
      this.disabled = patch.disabled
    },
  }))
  // 0.1.7：声明行（config.plugins 声明行 id）—— state.mcp 第一级键的反查依据
  const declRow = {
    id: DECL_ROW_ID,
    options: { id: DECL_ROW_ID, name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard-mcp', plugins: rows.map((r) => ({ id: r.id })) } },
  }
  const loaderEntries = declare ? [...entries, declRow] : [...entries]
  const editor = makeEditor({ id: 'standard-mcp', order: 1, plugins: rows.map((r) => ({ id: r.id, name: '@deepseek-ai/dsh-mcp-client' })) }, declare)
  const ctx = {
    loader: { entries: () => loaderEntries, resolve: (id) => loaderEntries.find((e) => e.id === id) },
    agents: { list: () => [], roots: () => [] },
    get: (name) => (name === 'configEditor' ? editor : undefined),
    logger: { info: () => {}, warn: () => {} },
  }
  const controller = { markUserEnabled: (name) => markUser.push(name) }
  return { entries, updates, markUser, ctx, controller, editor, declRow }
}

const readStateFile = async () => JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'))

/* ── 场景 1：残留兜底 —— desired 应用到 live；一致行与死键无动作 ────────── */

await checkAsync('残留兜底：desired 不一致的行被应用；一致行与旧版死键均无动作', async () => {
  const h = await makeHarness({ rows: [{ id: 'sqlite' }, { id: 'chrome', disabled: true }] })
  await writeState({
    mcp: {
      [DECL_ROW_ID]: {
        sqlite: { desired: true, lastApplied: null }, // 残留：从未物化 → 应被应用到 live
        chrome: { desired: true, lastApplied: null }, // live 已是 disabled=true → 无动作
      },
      // 0.1.5 遗留键（预设组合文件路径）：找不到声明行 → 死键，整块忽略
      'C:\\Users\\x\\.dsh\\.agent-presets\\standard-mcp\\agent.cordis.yml': {
        sqlite: { desired: false, lastApplied: null },
      },
    },
  })
  const applied = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied, 1, '只应应用 sqlite 一行（chrome 已一致；旧文件路径键是死键）')
  assert.deepEqual(h.updates, [{ id: 'sqlite', disabled: true }], 'sqlite 被更新为停用')
  assert.equal(h.entries.find((e) => e.id === 'sqlite').disabled, true)
  assert.equal(h.markUser.length, 0, '停用方向不标记 markUserEnabled')
})

/* ── 场景 2：启用方向的残留兜底触发 markUserEnabled ─────────────────── */

await checkAsync('启用方向的残留应用触发 markUserEnabled', async () => {
  const h = await makeHarness({ rows: [{ id: 'sqlite', disabled: true }] })
  await writeState({
    mcp: {
      [DECL_ROW_ID]: { sqlite: { desired: false, lastApplied: true } }, // live 已停用，用户意图为启用
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
  // 场景隔离（0.1.7）：state.mcp 第一级键是**常量**声明行 id，上一场景的残留会泄漏进来
  //（旧版键是预设文件路径，每个场景各一份，天然隔离）。这里显式声明本场景前提：
  // 残留里的 desired 与队列意图**相反**（残留 false / 队列 disabled=true）——
  // 这正是 FAIL-1 护栏的回归点：队列把 live 应用成 disabled=true 后，残留分支不得在
  // 同一边界内再拿陈旧的 desired 覆盖同一行（否则 applied1=2 且该行被先应用后回滚）。
  await writeState({ mcp: { [DECL_ROW_ID]: { sqlite: { desired: false, lastApplied: true } } } })
  pendingMcp.set('sqlite', { entryId: 'sqlite', file: DECL_ROW_ID, rowId: 'sqlite', disabled: true })
  const applied1 = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied1, 1)
  assert.deepEqual(h.updates, [{ id: 'sqlite', disabled: true }])
  assert.equal(pendingMcp.size, 0, '成功后队列清空')
  // 真实 toggle 会把 state.desired 同步写成与队列一致（routes.ts:299），上面那份相反值
  // 只是为了触发护栏而刻意构造的。补上这一步，第二次调用才落在断言原文的前提「状态一致」上。
  await writeState({ mcp: { [DECL_ROW_ID]: { sqlite: { desired: true, lastApplied: true } } } })
  const applied2 = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied2, 0, '状态一致后二次调用无动作')
})

/* ── 场景 4：物化闭环（configEditor 路径） + 幂等闸 ──────────────────── */

await checkAsync('syncPresetFiles 经 configEditor 物化 desired；二次启动不重复 edit（幂等）', async () => {
  const h = await makeHarness({ rows: [{ id: 'sqlite' }] })
  await writeState({
    mcp: { [DECL_ROW_ID]: { sqlite: { desired: true, lastApplied: null } } },
  })
  // 第一次「启动」：物化 desired → 声明行 plugins[0].disabled = true
  const n1 = await syncPresetFiles(h.ctx)
  assert.equal(n1, 1, '首次物化 1 行')
  assert.equal(h.editor.edits, 1, 'configEditor.edit 被调用一次')
  assert.equal(h.editor.entry.options.config.plugins[0].disabled, true, '声明行 config 已写入 disabled: true')
  const base = await readStateFile()
  assert.equal(base.mcp[DECL_ROW_ID].sqlite.lastApplied, true, '物化后 lastApplied 应同步为 desired')
  // 第二次「启动」：状态一致 → 幂等闸拦住，不再触发 edit（每次 edit 都会 reconcile/重挂）
  const n2 = await syncPresetFiles(h.ctx)
  assert.equal(n2, 0, '二次物化应为 0（状态一致）')
  assert.equal(h.editor.edits, 1, '幂等：第二次不再调用 configEditor.edit')
  // 模拟重启后 loader 从已物化的声明行加载（live 与声明同步）→ applyPending 无动作
  h.entries.find((e) => e.id === 'sqlite').disabled = true
  const applied = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied, 0)
})

/* ── 场景 5：声明行反查不到时降级（不持久化、不抛） ──────────────────── */

await checkAsync('声明行反查不到：syncPresetFiles 跳过且不抛；残留兜底同样不动 live', async () => {
  // declare=false：loader 里没有预设声明行 → state 的键都成死键
  const h = await makeHarness({ rows: [{ id: 'chrome' }], declare: false })
  await writeState({
    mcp: { [DECL_ROW_ID]: { chrome: { desired: true, lastApplied: null } } },
  })
  const n = await syncPresetFiles(h.ctx)
  assert.equal(n, 0, '找不到声明行 → 不物化')
  assert.equal(h.editor.edits, 0, '不得发起 edit')
  const applied = await applyPendingMcp({ ctx: h.ctx, controller: h.controller })
  assert.equal(applied, 0, '死键不应用到 live（不猜）')
  assert.deepEqual(h.updates, [])
})

/* ── 场景 6：非 profile 场合（无 configEditor 服务）不写盘 ───────────── */

await checkAsync('无 configEditor 服务：syncPresetFiles 返回 0 且不抛', async () => {
  const h = await makeHarness({ rows: [{ id: 'sqlite' }] })
  await writeState({
    mcp: { [DECL_ROW_ID]: { sqlite: { desired: true, lastApplied: null } } },
  })
  const ctx = { ...h.ctx, get: () => undefined }
  assert.equal(await syncPresetFiles(ctx), 0)
})

console.log(failed ? `\nselftest-pending: FAILED (${passed} passed)` : `\nselftest-pending: all checks passed (${passed} checks)`)
rmSync(fakeHome, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
