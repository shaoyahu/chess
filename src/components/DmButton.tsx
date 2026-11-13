'use client';

/**
 * 顶栏的「私信」入口 —— 大厅与对局页共用同一枚。
 *
 * 图标是**聊天气泡**（微信那一类），不是信封：
 * 信封读起来是「邮件 / 收件箱」，气泡才是「人跟人说话」。
 *
 * 未读角标挂在按钮右上角（跟对局页的聊天角标同一套样式）。
 */
import { MessageCircle } from 'lucide-react';

interface DmButtonProps {
  /** 未读条数（>0 时挂角标） */
  unread: number;
  /** 点开私信面板 */
  onClick: () => void;
}

export function DmButton({ unread, onClick }: DmButtonProps): React.ReactElement {
  return (
    <button
      className="btn small ghost icon-btn dm-btn"
      onClick={onClick}
      title="私信"
      aria-label="私信"
    >
      <MessageCircle size={19} aria-hidden="true" />
      {unread > 0 && (
        <span className="chat-badge" aria-label={`${unread} 条新私信`}>
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

export default DmButton;
