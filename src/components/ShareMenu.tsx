'use client';

/**
 * 顶栏的「分享」—— 按钮 + 一个小菜单（用户拍板）。
 *
 * 菜单里两件事：
 *   - **复制房间链接**：对方点开链接就进这局（没名字会先让他取名）；
 *   - **复制房间码**：4 位码，走大厅的「加入房间」那条路。
 *
 * 为什么用菜单而不是两个按钮：顶栏已经很挤（2D/3D、在线 N、私信、设置、离开），
 * 再摊两个按钮会把棋盘挤扁；收进一枚图标按钮里，菜单只在要分享时才出现。
 *
 * 菜单贴着按钮的**右下角**，并且**不顶出屏幕**（窄屏时往回收）。
 */
import { useEffect, useRef, useState } from 'react';
import { Copy, Hash, Share2 } from 'lucide-react';
import { copyText, roomShareUrl } from '@/lib/clipboard';

interface ShareMenuProps {
  /** 当前房间码 */
  code: string;
  /** 复制结果（成功/失败）→ 调用方负责弹提示 */
  onCopy: (what: 'link' | 'code', ok: boolean) => void;
}

export function ShareMenu({ code, onCopy }: ShareMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 菜单的落点（fixed 坐标） */
  const [pos, setPos] = useState({ left: 0, top: 0 });

  /** 打开时按按钮的位置算落点 */
  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const el = btnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      /*
       * 右对齐按钮的右边缘，菜单宽度 160px —— 靠右时菜单往左挪，
       * 不能顶出屏幕（窄屏上顶栏按钮贴右边，不挪就会有一半在屏幕外）。
       */
      const width = 168;
      setPos({
        left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
        top: Math.min(r.bottom + 6, window.innerHeight - 96),
      });
    }
    setOpen(true);
  };

  /* 点别处 / 失焦就关掉（用 pointerdown：菜单项自己的 onClick 要能先跑完） */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const el = menuRef.current;
      const btn = btnRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      if (btn && e.target instanceof Node && btn.contains(e.target)) return;
      setOpen(false);
    };
    const onBlur = (): void => setOpen(false);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** 复制房间链接 */
  const copyLink = async (): Promise<void> => {
    const ok = await copyText(roomShareUrl(code));
    setOpen(false);
    onCopy('link', ok);
  };

  /** 复制房间码 */
  const copyCode = async (): Promise<void> => {
    const ok = await copyText(code);
    setOpen(false);
    onCopy('code', ok);
  };

  return (
    <>
      <button
        ref={btnRef}
        className="btn small ghost icon-btn share-btn"
        onClick={toggle}
        title="分享"
        aria-label="分享"
        aria-expanded={open}
      >
        <Share2 size={19} aria-hidden="true" />
      </button>

      {open && (
        <div
          className="ctx-menu share-menu"
          ref={menuRef}
          style={{ left: pos.left, top: pos.top }}
          role="menu"
        >
          <button className="ctx-item" role="menuitem" onClick={() => void copyLink()}>
            <Copy size={14} aria-hidden="true" />
            复制房间链接
          </button>
          <button className="ctx-item" role="menuitem" onClick={() => void copyCode()}>
            <Hash size={14} aria-hidden="true" />
            复制房间码
          </button>
        </div>
      )}
    </>
  );
}

export default ShareMenu;
