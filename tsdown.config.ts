import { defineConfig } from 'tsdown'

/**
 * Node 半区铁律：external 全部 @deepseek-ai/*（含 schemastery/dsh-scope），
 * 否则 tsdown 会把 dsh-tools 之类内联进 bundle → 第二个 TOOL_RUNTIME_SCHEDULER
 * Symbol → 工具调度崩溃。运行时经 profile 闭包 junction 解析到宿主同一份模块。
 *
 * 输出命名：tsdown 默认 entryFileNames '[name].js'，两个入口 basename 都是
 * index 会竞争写同一文件 → 必须用 outputOptions 显式命名。
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'lib',
    target: 'node22',
    platform: 'node',
    external: [/^@deepseek-ai\//, /^node:/],
    clean: true,
    sourcemap: false,
    outputOptions: {
      entryFileNames: 'index.js',
    },
  },
  {
    // mcpServers JSON → dsh-mcp-client 行 的纯转换（独立产物，供 selftest 覆盖）。
    entry: ['src/mcp-convert.ts'],
    format: ['esm'],
    outDir: 'lib',
    target: 'node22',
    platform: 'node',
    external: [/^@deepseek-ai\//, /^node:/],
    clean: false,
    sourcemap: false,
    outputOptions: {
      entryFileNames: 'mcp-convert.js',
    },
  },
  {
    // 私有 catalog（纯逻辑）单独产物，供 scripts/selftest-mcp.mjs 用临时目录自测；
    // external 与外置铁律一致，不内联任何 @deepseek-ai 运行时。
    entry: ['src/catalog.ts'],
    format: ['esm'],
    outDir: 'lib',
    target: 'node22',
    platform: 'node',
    external: [/^@deepseek-ai\//, /^node:/],
    clean: false,
    sourcemap: false,
    outputOptions: {
      entryFileNames: 'catalog.js',
    },
  },
  {
    entry: ['src/client/index.ts'],
    // cjs：ModuleLoader factory 提供 require/module/exports，import 必须转成 require 调用
    format: ['cjs'],
    outDir: 'lib',
    target: 'es2022',
    platform: 'browser',
    external: [/^@deepseek-ai\//, /^react(\/.*)?$/],
    clean: false,
    sourcemap: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({
\tid: "dsh-mcp-skill-panel",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
      footer: `\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});`,
    },
  },
])
