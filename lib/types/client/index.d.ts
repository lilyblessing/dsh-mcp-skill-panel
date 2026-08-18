import type { ComponentType } from 'react';
export declare const inject: string[];
/** locale 服务最小契约（bind/register）。 */
interface LocaleService {
    bind(ns: string): (key: string, params?: Record<string, string | number>) => string;
    register(ns: string, dict: {
        zh: Record<string, string>;
        en: Record<string, string>;
    }): () => void;
}
/** slots 服务最小契约（inject/register）。 */
interface SlotsService {
    inject(name: string, fn: () => () => void): void;
    register(options: {
        name: string;
        id: string;
        order?: number;
        label: () => string;
        locale?: string;
    }, component: ComponentType<{
        t: (key: string, params?: Record<string, string | number>) => string;
    }>): () => void;
}
/** Client 平台 ctx 最小契约。 */
interface ClientCtx {
    locale: LocaleService;
    slots: SlotsService;
    effect(fn: () => () => void, name?: string): () => void;
}
export declare function apply(ctx: ClientCtx): void;
export {};
