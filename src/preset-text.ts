/**
 * 预设文本工具的**独立入口**（供 selftest 导入）。
 *
 * 为什么不直接从 index.ts 导入：index 会连带加载 `@deepseek-ai/*` 宿主包
 * （dsh-agent-presets 等），而仓库 devDependencies 里那份不完整 → 自测直接
 * ERR_MODULE_NOT_FOUND。本入口只 re-export 纯文本函数，零宿主依赖。
 */
export {
  setRowFlag,
  setRowConfigKeys,
  rowDisabledState,
  configValueToYaml,
  configSetToYaml,
  configKeysToYamlText,
  EDITABLE_CONFIG_KEYS,
} from './preset'
