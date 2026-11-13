/**
 * 复制文本到剪贴板 —— **局域网场景下必须带兜底**。
 *
 * 为什么不能只用 `navigator.clipboard`：
 *   那套 API 只在**安全上下文**里可用（https，或 localhost）。
 *   本项目在局域网里跑的是 `http://192.168.x.x:3000` ——
 *   **不是安全上下文**，`navigator.clipboard` 在那儿是 `undefined`，
 *   直接调会抛异常（或者干脆什么都不做）。
 *
 *   所以这里：先用现代 API（浏览器给了就用），失败/不可用时
 *   落到「临时 textarea + `execCommand('copy')」这条老路上。
 *   老 API 在所有浏览器里都还能用（包括 http 页面）。
 */

/**
 * 复制一段文本。
 *
 * @returns 复制成功返回 true；失败返回 false（调用方负责提示）
 */
export async function copyText(text: string): Promise<boolean> {
  const value = text.trim();
  if (!value) return false;

  // —— 1) 现代 API（需要安全上下文）——
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 落到兜底 */
  }

  // —— 2) 兜底：临时 textarea + execCommand ——
  if (typeof document === 'undefined') return false;
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    /*
     * 必须**在视口内但看不见**：
     * 放在屏幕外（left: -9999px）在某些浏览器里会导致「没有选中任何东西」，
     * 复制静默失败。
     */
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    ta = null;
    return ok;
  } catch {
    return false;
  } finally {
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
  }
}

/**
 * 房间的**分享链接**。
 *
 * 用 `location.origin` —— 别人能打开的地址就是浏览器地址栏里那个
 * （部署在反代后面时也是对的：浏览器看到的就是对外的地址）。
 */
export function roomShareUrl(code: string, origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/room/${code.trim().toUpperCase()}`;
}
