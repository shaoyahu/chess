'use client';

/**
 * 顶栏的「在线名单」入口 —— **大厅与对局页共用同一套**。
 *
 * 为什么共用：找人是**全局**的事，不该分页面。
 * 上一版对局页顶栏只有一个「已连接」圆点 —— 人在棋盘上时想看看还有谁在线，
 * 只能退回大厅；这跟「顶栏本来就是全局入口」是矛盾的。
 *
 * 两种发消息的手势（用户拍板）：
 *   - **左键**点某人 → 直接进那个人的私信；
 *   - **右键**点某人 → 弹菜单，菜单里选「发送消息」。
 *
 * 名单里自己那行标「你」，而且**点不动** —— 不能给自己发私信
 * （标着「你」却还能点，就是卡面承诺和真实状态对不上）。
 *
 * 名单**不写任何说明文字**：怎么发消息，靠「行尾那枚气泡按钮」说明，
 * 不靠一句话教用户 —— 教一次就等于承认界面本身没讲清楚。
 *
 * **浮层点别处就收起**（用户拍板）：
 *   名单是顶栏下拉出来的浮层，它的 z-index（520）**高过私信抽屉（80）**——
 *   开着名单再去点顶栏的「私信」，抽屉在名单**底下**冒出来，
 *   名单正好盖在抽屉上，聊天窗看得见却点不着。
 *   所以浮层必须**点别处自动收起**：浮层只该在用户正看它的时候存在。
 */
import { useEffect, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { DmPeer } from './DirectMessagePanel';

export interface OnlineUser {
  userId: string;
  name: string;
}

interface OnlineUsersMenuProps {
  /** 连上了没有 */
  connected: boolean;
  /** 在线人数（**必须等于 users.length** —— 服务端同源计算，不是两处各算一遍） */
  online: number;
  /** 在线的人 */
  users: OnlineUser[];
  /** 自己的 userId（用来标「你」） */
  selfId?: string | null;
  /** 要给某人发消息（打开私信面板并落在那个人身上） */
  onMessage: (peer: DmPeer) => void;
  /** 断线时按钮上写什么（大厅「连接中…」/ 对局页「重连中…」） */
  offlineLabel?: string;
}

export function OnlineUsersMenu({
  connected,
  online,
  users,
  selfId,
  onMessage,
  offlineLabel = '连接中…',
}: OnlineUsersMenuProps): React.ReactElement {
  /** 「在线 N」这个浮层开着没有 */
  const [open, setOpen] = useState(false);
  /** 右键菜单（点谁、在哪） */
  const [ctxMenu, setCtxMenu] = useState<{ peer: DmPeer; x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  /** 入口按钮 —— 点它不算「点别处」（否则会「关了又开」） */
  const btnRef = useRef<HTMLButtonElement>(null);
  /** 名单浮层本体 */
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * **浮层点别处就收起。**
   *
   * 为什么必须收：名单浮层的 z-index 高过私信抽屉 —— 开着名单点顶栏的
   * 「私信」，抽屉在名单底下，名单正好盖在聊天窗上（看得见、点不着）。
   * 浮层只该在用户正看它的时候存在。
   *
   * 用 **pointerdown** 而不是 click：名册行自己的 onClick 要能先跑完
   * （pointerdown 先于 click，早一步把浮层卸掉的话，那一行就点不到了）。
   *
   * 入口按钮要**排除掉**：它是开关，点它本来就该收起 —— 但那是按钮自己
   * 的 toggle 干的事；要是这里先关一次、按钮再 toggle 一次，就变成「关了又开」。
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      setOpen(false);
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        setCtxMenu(null);
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /*
   * 右键菜单：点别处就关掉。
   *
   * 用 **pointerdown** 而不是 click：菜单项自己的 onClick 要能先跑完
   * （pointerdown 先于 click，早一步把菜单卸掉的话，按钮就点不到了）。
   * 所以这里要判断「点的是不是菜单自己」。
   */
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: PointerEvent): void => {
      const el = ctxMenuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setCtxMenu(null);
    };
    const onBlur = (): void => setCtxMenu(null);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [ctxMenu]);

  /** 打开某个人的私信（两条手势走同一个出口） */
  const message = (peer: DmPeer): void => {
    onMessage(peer);
    setCtxMenu(null);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        className={`status-dot ${connected ? 'online' : ''}`}
        onClick={() => {
          setOpen((v) => !v);
          setCtxMenu(null);
        }}
        aria-expanded={open}
        aria-label={connected ? `已连接，在线 ${online} 人` : offlineLabel}
        title="在线的人"
      >
        <i />
        {/*
          连上了就只写「在线 N」—— 那颗绿点**已经**表示「连着」，
          再写一遍「已连接」是重复；而且对局页顶栏窄，一多两个字就顶破。
        */}
        {connected ? `在线 ${online}` : offlineLabel}
      </button>

      {open && (
        <div className="online-panel" ref={panelRef} role="dialog" aria-label="在线的人">
          <div className="online-head">在线 {online} 人</div>
          <div className="online-list">
            {users.length === 0 && <div className="online-hint">还没有别人在线。</div>}
            {users.map((u) => {
              const isSelf = u.userId === selfId;
              const peer: DmPeer = { userId: u.userId, name: u.name };
              return (
                <div
                  className="online-row"
                  key={u.userId}
                  title={isSelf ? '这是你自己' : '点一下就能给他发消息'}
                  /* 左键 = 直接进私信 */
                  onClick={() => {
                    if (isSelf) return;
                    message(peer);
                  }}
                  /* 右键 = 弹菜单 */
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (isSelf) return;
                    /*
                     * 菜单贴着光标，但**不能顶出屏幕** ——
                     * 靠近右下角时往回收，不然菜单有一半在屏幕外点不到。
                     */
                    setCtxMenu({
                      peer,
                      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 150)),
                      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 60)),
                    });
                  }}
                >
                  <span className="online-name">{u.name}</span>
                  {isSelf ? (
                    <span className="online-you">你</span>
                  ) : (
                    /*
                     * 行尾这枚气泡按钮就是「怎么发消息」的说明书 ——
                     * 不用一句提示文字教用户。
                     */
                    <button
                      className="online-dm"
                      aria-label={`给${u.name}发消息`}
                      title="发消息"
                      onClick={(e) => {
                        e.stopPropagation();
                        message(peer);
                      }}
                    >
                      <MessageCircle size={15} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          className="ctx-menu"
          ref={ctxMenuRef}
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
        >
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              message(ctxMenu.peer);
            }}
          >
            发送消息
          </button>
        </div>
      )}
    </>
  );
}

export default OnlineUsersMenu;
