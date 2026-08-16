/** 通用小工具（index / collect / routes 共用）。 */

/** 把未知错误投影为可读字符串（日志与 HTTP 错误响应）。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
