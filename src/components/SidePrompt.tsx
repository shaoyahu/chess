'use client';

/**
 * 右侧浮层提示 —— 求和 / 悔棋的「同意 / 反对」，以及认输的二次确认。
 *
 * 为什么做成**浮层**而不是往页面里插一条文字：
 *   - 插进文档流的提示条会**把页面内容往下顶**，消息一多就顶出整页滚动条
 *     （用户明确反馈过这个毛病：「突兀增加文本让页面有可能出现滚动条」）；
 *   - `position: fixed` 的浮层**不占布局**，页面高度不受影响。
 *
 * 浮层固定贴在**右侧**（用户要求），倒计时直接写在标题旁边。
 */
import type { ReactNode } from 'react';

/** 一个按钮 */
export interface SidePromptAction {
  label: string;
  onClick: () => void;
  /** primary = 主操作（同意/确认）；danger = 危险操作；默认 ghost */
  tone?: 'primary' | 'ghost' | 'danger';
}

export interface SidePromptProps {
  /** 唯一 id（React key） */
  id: string;
  title: string;
  body: ReactNode;
  /** 倒计时截止时间戳（毫秒）—— 给了才显示倒计时 */
  deadline?: number;
  /** 当前时间戳（毫秒），由页面定时推进 */
  now: number;
  actions?: SidePromptAction[];
  /** info = 普通提示；danger = 危险操作（认输） */
  tone?: 'info' | 'danger';
}

export function SidePrompt({
  id,
  title,
  body,
  deadline,
  now,
  actions,
  tone = 'info',
}: SidePromptProps): React.ReactElement {
  const remain = deadline === undefined ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  const expired = remain !== null && remain <= 0;
  return (
    <div className={`side-prompt side-prompt-${tone}`} data-prompt={id} role="status">
      <div className="side-prompt-head">
        <span className="side-prompt-title">{title}</span>
        {remain !== null && (
          <span className={`side-prompt-countdown${expired ? ' expired' : ''}`}>
            {expired ? '已超时' : `${remain} 秒`}
          </span>
        )}
      </div>
      <div className="side-prompt-body">{body}</div>
      {actions && actions.length > 0 && (
        <div className="side-prompt-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              className={`btn small ${a.tone === 'primary' ? 'primary' : a.tone === 'danger' ? 'danger' : 'ghost'}`}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default SidePrompt;
