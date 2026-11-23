/**
 * 决定 WebSocket 连到哪里。
 *
 * 项目有两种部署形态，同一个地址算法要同时伺候：
 *
 *  1. **同源**（本地 / 局域网 / 整站都部署在一台机器上）：
 *     连 `ws(s)://<当前页面 host>/ws`。
 *  2. **分离**（页面在 Vercel、实时服务在另一台机器 —— 混合部署）：
 *     连 `NEXT_PUBLIC_WS_URL` 指定的那个地址。
 *
 * 为什么用 `NEXT_PUBLIC_` 前缀：这个值必须**在构建期**被内联进浏览器包里，
 * 因为浏览器拿不到构建机的环境变量。Next.js 只对**静态成员访问**
 * （`process.env.NEXT_PUBLIC_WS_URL`）做内联替换 —— 写成
 * `process.env[name]` 或解构后取值就替换不掉，值会变成 undefined。
 * 所以调用方必须写成 `resolveWsUrl(process.env.NEXT_PUBLIC_WS_URL, ...)`。
 */

/** 去掉末尾多余的 `/`，避免拼出 `//ws` 这种双斜杠。 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * 算出 WebSocket 的完整地址。
 *
 * @param configured `NEXT_PUBLIC_WS_URL` 的值；没配就退回同源。
 * @param protocol   `window.location.protocol`（`http:` / `https:`）。
 * @param host       `window.location.host`（含端口）。
 */
export function resolveWsUrl(
  configured: string | undefined,
  protocol: string,
  host: string,
): string {
  const trimmed = configured?.trim();
  if (trimmed) return stripTrailingSlash(trimmed);

  const proto = protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${host}/ws`;
}
