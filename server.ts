/**
 * 自定义服务器：Next.js（HTTP）+ WebSocket 共用同一端口。
 *
 * 为什么不用 Route Handler：Next.js App Router 的 Route Handler 不支持
 * WebSocket 升级（拿不到 upgrade 事件）。这里采用 Next 官方认可的自定义
 * 服务器模式（`next()` 程序化 API），把 `ws` 挂在同一个 HTTP server 上，
 * 升级请求按路径分流：
 *   - /ws  → 交给 ws
 *   - 其他 → 交给 Next 的 upgrade handler（dev 模式的 HMR 用）
 *
 * 结果：局域网里所有设备只需记一个地址 http://<本机IP>:3000
 */
import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { WsHub } from './src/server/ws-hub';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function main(): Promise<void> {
  await app.prepare();

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
    void handle(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => hub.handleConnection(socket));

  const nextUpgradeHandler = app.getUpgradeHandler();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url ?? '/');
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    // 其余（dev 模式 HMR）交回 Next
    nextUpgradeHandler(req, socket, head);
  });

  server.listen(port, hostname, () => {
    console.log(`\n  ♞  局域网国际象棋已启动`);
    console.log(`     本机:   http://localhost:${port}`);
    console.log(`     局域网: http://<本机IP>:${port}  （用 scripts/print-lan.ts 查看 IP）`);
    console.log(`     模式:   ${dev ? '开发' : '生产'}\n`);
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
