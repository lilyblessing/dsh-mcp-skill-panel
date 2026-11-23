// 【临时构建桩 — 不得提交】
// 真包缺失时，ctx.agentPresets 的类型增强不会生效 → 8 处 TS2339。
// 必须以「带 import 的模块」形态写，才能让 declare module 成为增强而非整体遮蔽；
// 若去掉下面的 import，会把 cordis 的 logger/effect/root/get/inject 一并抹掉（实测 70+ 假错误）。
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: any
  }
}
