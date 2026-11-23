/**
 * **只跑 WebSocket 的服务端入口** —— 混合部署时用。
 *
 * 混合部署 = 页面托管在 Vercel（静态托管，零函数成本）+ 实时服务留在自己的服务器。
 * 这时候这台机器只需要提供 `/ws`，页面由 Vercel 托管。
 *
 * 为什么要单独写一个入口，而不是在 `server.ts` 里加个开关：
 *
 *  1. **服务器上不用构建 Next.js**（这是最大的好处）。
 *     `next build` 的内存峰值能把一台总内存 1586MB 的机器打到**整机僵死**
 *     —— 而且一旦僵死连不上 SSH，只能从云控制台重启（见 docs/deploy.md §2）。
 *     只要 WS 就不需要 `.next` 产物，于是这台机器上**整个构建步骤可以跳过**，
 *     改成「在本地构建 → 只把 WS 需要的几个文件传上去」。
 *     这同时避开了「在共享生产机上构建会拖垮上面那些线上服务」这个坑。
 *
 *  2. **常驻内存更小**：不加载 Next 的运行时，1.5G 的机器上更宽裕。
 *
 *  3. **本地开发不受影响**：`server.ts` 保持原样（页面 + WS 同端口），
 *     局域网里还是一条命令起全套。
 *
 * 部署形态：
 *
 *   浏览器 ──wss://<域名>/ws──▶ nginx(443, TLS 终止) ──▶ 本进程(127.0.0.1:3000)
 *   浏览器 ──https://<vercel 域名>──▶ Vercel（页面，静态）
 *
 * 注意：WS 与页面**不同源**。浏览器对 WebSocket 不适用同源策略，
 * 只要服务端不校验 Origin 就能连（本项目不校验，已核对过 ws-hub.ts）。
 */
import { createServer } from 'node:http';
import { parse } from 'node:url';
import { WebSocketServer } from 'ws';
import { WsHub } from './src/server/ws-hub';

/*
 * 默认只监听回环地址 —— 这个进程**只**应该由本机的 nginx 反代进来，
 * 不直接对公网开。公网暴露的是 nginx 的 443（带 TLS）。
 *
 * 真要在没有 nginx 的环境直接对外（比如临时调试），显式设 `HOST=0.0.0.0`。
 */
const hostname = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const hub = new WsHub();

  /*
   * **先恢复存档，再开始监听**。
   *
   * 顺序很重要：如果先监听端口，玩家可能在房间还没恢复时就连进来 ——
   * 那时服务端看到的是「房间不存在」，玩家刚重开就撞上一堵墙。
   * 恢复完再监听，端口一开就是完整的。
   */
  await hub.restoreFromDisk();

  const server = createServer((req, res) => {
    const { pathname } = parse(req.url ?? '/');

    /*
     * 健康检查 —— 给部署自检 / 监控用。
     * 返回的是**进程活着且存档已恢复**，不是「房间服务正常」：
     * 房间状态在内存里，进程活着就意味着它还在。
     */
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, mode: 'ws-only' }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => hub.handleConnection(socket));

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url ?? '/');
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    // 不是 /ws 的升级请求：别让 nginx 那边挂着一个永远连不上的连接。
    socket.destroy();
  });

  server.listen(port, hostname, () => {
    console.log(`\n  ♞  国际象棋 · WebSocket 服务已启动`);
    console.log(`     监听:   ${hostname}:${port}  （路径 /ws）`);
    console.log(`     健康:   http://${hostname}:${port}/healthz`);
    console.log(`     模式:   仅 WS（页面由 Vercel 托管）\n`);
  });

  /*
   * **优雅退出**：先把当前状态落盘，再收服务。
   *
   * 为什么要落盘：存档是**节流**写的（最多每 2 秒一次），
   * Ctrl-C 落在这 2 秒窗口里的话，最后几秒的状态就丢了。
   * 对局还在、但走子记录少了两步 —— 恢复出来局面就跟对不上。
   */
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n正在关闭…');
    try {
      await hub.flushNow();
    } catch {
      /* ignore */
    }
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('服务器启动失败:', err);
  process.exit(1);
});
