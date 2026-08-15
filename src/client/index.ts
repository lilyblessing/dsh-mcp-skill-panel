/**
 * Client 半区入口：注册 settings.section「MCP 与技能管理面板」页（MCP / 技能 双标签）。
 * 参考 ui-settings-plugins 的 settings.section 注册形态（id/order/label/locale 必带）。
 */
import { RuntimeInventorySection } from './views'
import { NS, en, zh } from './locales'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inject = ['slots', 'locale']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () =>
      ctx.locale.register(NS, {
        zh,
        en,
      }),
    'runtime-inventory: dictionaries',
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'runtime-inventory',
        order: 30,
        label: () => t('ri.nav'),
        locale: NS,
      },
      RuntimeInventorySection,
    ),
  )
}
