import { describe, it, expect } from 'vitest';
import { resolveWsUrl } from '@/lib/ws-url';

describe('resolveWsUrl', () => {
  it('没配 NEXT_PUBLIC_WS_URL 时连同源', () => {
    expect(resolveWsUrl(undefined, 'http:', '192.168.1.23:3000')).toBe(
      'ws://192.168.1.23:3000/ws',
    );
  });

  it('页面是 https 时用 wss（不能明文 —— session token 走这条路）', () => {
    expect(resolveWsUrl(undefined, 'https:', 'chess.example.com')).toBe(
      'wss://chess.example.com/ws',
    );
  });

  it('配了就连配的那个（混合部署：页面在 Vercel，WS 在别的机器）', () => {
    expect(resolveWsUrl('wss://chess.example.com/ws', 'https:', 'app.vercel.app')).toBe(
      'wss://chess.example.com/ws',
    );
  });

  it('配的值末尾多个斜杠会被去掉（避免拼出 //ws）', () => {
    expect(resolveWsUrl('wss://chess.example.com/ws//', 'https:', 'app.vercel.app')).toBe(
      'wss://chess.example.com/ws',
    );
  });

  it('配的是空串 / 只有空格 → 退回同源（别连到一个空地址）', () => {
    expect(resolveWsUrl('', 'http:', 'localhost:3000')).toBe('ws://localhost:3000/ws');
    expect(resolveWsUrl('   ', 'http:', 'localhost:3000')).toBe('ws://localhost:3000/ws');
  });

  it('配了 http:// 的地址也照用（反代在前面做 TLS 终止时可能是这种）', () => {
    expect(resolveWsUrl('http://127.0.0.1:3000/ws', 'https:', 'app.vercel.app')).toBe(
      'http://127.0.0.1:3000/ws',
    );
  });
});
