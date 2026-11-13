import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastHost } from '@/components/ToastHost';

export const metadata: Metadata = {
  title: '局域网国际象棋',
  description: '局域网多人实时国际象棋：对战、观战、2D/3D 双视角',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // 与 globals.css 的 --paper 保持一致：浏览器地址栏也是纸灰，不跟页面脱节
  themeColor: '#eef1f6',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {/*
          全局 toast 挂在 **根布局** —— 不在房间里也得能看见
          （连接断开、进房失败、和棋被拒……这些以前全被静默丢弃）。
          `useSocket` 是模块级单例，这里挂一次不会多开 WebSocket。
        */}
        <ToastHost />
        {children}
      </body>
    </html>
  );
}
