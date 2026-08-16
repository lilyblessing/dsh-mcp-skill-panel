/**
 * Client 半区入口：注册 settings.section「MCP 与技能管理面板」页（MCP / 技能 双标签）。
 * 参考 ui-settings-plugins 的 settings.section 注册形态（id/order/label/locale 必带）。
 *
 * 平台类型（slots/locale）在本仓库无闭包类型可用，这里声明最小契约（P2-3 可维护性
 * 批次，替换此前的 any），与宿主实际签名对齐即可 —— 注册参数不匹配会在启动时报错。
 */
import { RuntimeInventorySection } from './views'
import { NS, en, zh } from './locales'
import type { ComponentType } from 'react'

export const inject = ['slots', 'locale']

/** locale 服务最小契约（bind/register）。 */
interface LocaleService {
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  register(ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }): () => void
}

/** slots 服务最小契约（inject/register）。 */
interface SlotsService {
  inject(name: string, fn: () => () => void): void
  register(
    options: { name: string; id: string; order?: number; label: () => string; locale?: string },
    component: ComponentType<{ t: (key: string, params?: Record<string, string | number>) => string }>,
  ): () => void
}

/** Client 平台 ctx 最小契约。 */
interface ClientCtx {
  locale: LocaleService
  slots: SlotsService
  effect(fn: () => () => void, name?: string): () => void
}

export function apply(ctx: ClientCtx): void {
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
