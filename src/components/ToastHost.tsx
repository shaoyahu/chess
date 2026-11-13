'use client';

/**
 * 全局 toast —— 右上角固定、宽 380px、悬停暂停、错误类 8 秒。
 *
 * **为什么现在才有这个组件**：
 *   服务端一直会下发 `t:'toast'`（连接断开、进房失败、有人拒绝和棋……），
 *   `useSocket` 也一直把它们收进 `state.toasts` —— 但**全站没有任何地方渲染它们**。
 *   也就是说：大厅里「房间不存在」这类失败，以前是**完全静默**的，
 *   用户按了按钮什么也没发生。对局页后来补了错误卡片，才把「进不去房间」
 *   这一个场景救回来；其它 toast（重连、和棋被拒、悔棋被拒）仍然是黑洞。
 *
 * 规范：
 *   - 位置右上角（不挡棋盘正中）、宽 380px；
 *   - 鼠标悬停**暂停**计时（用户在读的时候不该被收走）；
 *   - `error` 类 8 秒（错因要留够时间读完），其余 4.5 秒；
 *   - **后端错因原样透出**，不做二次演绎（用户口味：卡面承诺要和真实状态逐字对上）。
 *
 * **提示区是「有边界的」（用户拍板）**：
 *   私信轰炸时，这条提示列会从右上角一路铺到屏幕中间，把棋盘盖住。
 *   所以这里只渲染**最新的几条**，而且**新的在上**——
 *   最新那条永远贴着右上角，最旧的沉到底下（超出就裁掉）。
 *   被挤下去的提示**不删**，还排在队列里：上面的消失后它会浮上来。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';

const INFO_MS = 4500;
const ERROR_MS = 8000;

/**
 * **同时最多显示几条提示**。
 *
 * 4 条 × 约 56px ≈ 220px —— 从右上角往下占不到屏幕的四分之一，
 * 不会盖到棋盘正中。再多就往下铺了。
 */
const MAX_VISIBLE = 4;

interface ToastItemProps {
  id: number;
  kind: 'info' | 'error' | 'success';
  message: string;
  /** 内容版本：文案变了就重新计时（合并进来的新消息要重新给阅读时间） */
  version: number;
  onDismiss: (id: number) => void;
}

function ToastItem({
  id,
  kind,
  message,
  version,
  onDismiss,
}: ToastItemProps): React.ReactElement {
  const [paused, setPaused] = useState(false);
  const full = kind === 'error' ? ERROR_MS : INFO_MS;
  const remaining = useRef(full);
  const startedAt = useRef(Date.now());

  /*
   * **文案变了 → 重新给满阅读时间。**
   *
   * 合并提示（「xx 给你发来 3 条消息」）会在原那条上改文案；
   * 不重置的话，这条可能刚合并完就消失 —— 数字只显示了半秒。
   *
   * 依赖里**只有 version**：悬停暂停（paused）不能顺带把计时重置，
   * 那会让「悬停 = 无限续命」。所以这个 effect 必须排在计时 effect **前面**：
   * React 先跑上一轮的 cleanup（扣掉已经走过的时间），再跑新一轮的 effect。
   */
  useEffect(() => {
    remaining.current = full;
  }, [version]);

  /*
   * 计时 effect 的依赖里**必须带 version** ——
   * 带上它，内容一改，setTimeout 才会**重新排一次**。
   * 只在「重置 effect」里把 remaining 改掉是不够的：
   * 那个 setTimeout 是上一次排的，到点照样把这条收走 ——
   * 于是「给你发来 3 条消息」刚合并完就没了。
   */
  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => onDismiss(id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      // 暂停时把已经走过的时间扣掉 —— 恢复后还能看满剩下的时长
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, id, onDismiss, version]);

  return (
    <div
      className={`toast toast-${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">{message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭提示"
        onClick={() => onDismiss(id)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ToastHost(): React.ReactElement {
  const { toasts, dismissToast, clearToasts } = useSocket();
  const onDismiss = useCallback((id: number) => dismissToast(id), [dismissToast]);

  /**
   * **换页面就把上一页的 toast 全收掉。**
   *
   * toast 的状态在模块级单例里，而这个组件挂在**根布局**上（不在房间里也得
   * 看得见失败提示）。于是大厅页的一次输入校验失败会跟着用户飘到对局页：
   * 「房间码为 4 位字符」出现在棋盘右上角 —— 既是上个页面的遗留，又正好
   * 压在棋盘上方最显眼的位置。
   *
   * toast 的语义是「**刚刚**发生的事」，跨页就不该继续存在。
   */
  const pathname = usePathname();
  useEffect(() => {
    clearToasts();
  }, [pathname, clearToasts]);

  /**
   * **只渲染最新的几条**，而且**新的在上**。
   *
   * 为什么新在上：提示区是贴着右上角的一列，最新的那条必须**紧挨着顶栏** ——
   * 往下的位置留给更老的。倒着排还有一个好处：
   * 提示区有高度上限（CSS `max-height` + `overflow: hidden`），
   * 超出时裁掉的是**最下面**（最老）那条，而不是最新那条。
   *
   * 被挤下去的**不删**：它们还在队列里，上面的消失后会依次浮上来。
   */
  const visible = toasts.slice(-MAX_VISIBLE).reverse();

  if (toasts.length === 0) return <div className="toasts" aria-live="polite" />;

  return (
    <div className="toasts" aria-live="polite">
      {visible.map((t) => (
        <ToastItem
          key={t.id}
          id={t.id}
          kind={t.kind}
          message={t.message}
          version={t.version}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}

export default ToastHost;
