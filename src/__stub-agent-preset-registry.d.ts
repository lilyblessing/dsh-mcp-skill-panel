// 【临时构建桩 — 不得提交】
// 宿主闭包升级到 0.1.7+ 之前，repo 的 node_modules/@deepseek-ai 里没有
// @deepseek-ai/dsh-agent-preset-registry（profile 仍是 0.1.5-rc.2，只有已退役的复数包）。
// 本文件仅让 `import ... from '@deepseek-ai/dsh-agent-preset-registry'` 能解析。
// 升级后 `npm run setup` 会把真包 junction 进来，届时本文件与 __stub-context-agent-presets.d.ts 一起删除。
declare module '@deepseek-ai/dsh-agent-preset-registry'
