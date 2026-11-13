/**
 * 部署自检 —— 部署到云服务器之后跑一次。
 *
 * 为什么单独写这个脚本：上云之后最容易踩的坑**都不是代码问题**，而是环境问题，
 * 而且**只有到了那台机器上才看得出来**：
 *
 *   ① 反代没透传 WebSocket → 页面能打开，但「进不了对局 / 走子没反应」；
 *   ② 进程用 root 跑 → `.data` 目录写不进去，重启后对局全丢；
 *   ③ 引擎没装 → 人机对弈棋力弱，还以为是代码写错了；
 *   ④ `.data` 没挂盘 → 容器重建后房间清零。
 *
 * 这四条都能在这里一次性查清，不用去翻日志猜。
 *
 * 用法：
 *   npm run deploy:check                                  # 查本机 3000
 *   npm run deploy:check -- --url http://1.2.3.4:3000      # 查另一台机器
 *
 * 退出码：全部通过 = 0；有任何一项失败 = 1（可以直接串进部署脚本）。
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { discoverEngineSource } from '../src/lib/engine/engine-source';

/** 读 `--name value` 形式的参数 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const target = arg('url', `http://127.0.0.1:${process.env.PORT ?? '3000'}`).replace(/\/+$/, '');
const host = new URL(target).hostname;

/** 只有查本机时才有意义的检查项（引擎在**跑服务的那台机器**上，数据目录也在那儿） */
const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(host);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** 这一项失败时人要做什么 */
  fix?: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string, fix?: string): void {
  checks.push({ name, ok, detail, fix });
  console.log(`  ${ok ? '✓' : '✗'} ${name}：${detail}`);
}

/* ---------------- 1. HTTP 首页 ---------------- */
async function checkHttp(): Promise<void> {
  try {
    const res = await fetch(`${target}/`, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    const titled = body.includes('局域网国际象棋');
    record(
      'HTTP 首页',
      res.status === 200 && titled,
      `状态 ${res.status}${titled ? '，页面标题正确' : '，但没看到页面标题'}`,
      res.status !== 200
        ? '服务没起来：systemctl status lan-chess 看日志'
        : '首页不像本项目，检查反代是不是转错端口了',
    );
  } catch (err) {
    record('HTTP 首页', false, `连不上 ${target}（${err instanceof Error ? err.message : String(err)}）`, '服务没起，或反代没配对');
  }
}

/* ---------------- 2. WebSocket 握手 ---------------- */
async function checkWs(): Promise<void> {
  const wsUrl = `${target.replace(/^http/, 'ws')}/ws`;
  try {
    const token = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('8 秒内没收到 session'));
      }, 8000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'deploy-check' })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { t?: string; token?: string };
        if (msg.t === 'session' && msg.token) {
          clearTimeout(timer);
          ws.close();
          resolve(msg.token);
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    record('WebSocket /ws', true, `握手成功，拿到身份（${wsUrl}）`);
  } catch (err) {
    record(
      'WebSocket /ws',
      false,
      `握手失败：${err instanceof Error ? err.message : String(err)}`,
      '反代必须透传 Upgrade 头 + 放大 proxy_read_timeout（nginx）',
    );
  }
}

/* ---------------- 3. 引擎（只有本机查得到） ---------------- */
async function checkEngine(): Promise<void> {
  const source = discoverEngineSource();
  if (!source) {
    record(
      'Stockfish 引擎',
      true,
      '没找到 —— 会自动降级到自研引擎（能玩，棋力弱一档）',
      '想要强棋力：apt install stockfish，或设 STOCKFISH_PATH 指向引擎',
    );
    return;
  }
  record('Stockfish 引擎', true, `可用：${source.label}`);
}

/* ---------------- 4. 数据目录可写（只有本机查得到） ---------------- */
async function checkDataDir(): Promise<void> {
  const dir = path.join(process.cwd(), '.data');
  const probe = path.join(dir, '.deploy-check');
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.unlink(probe);
    record('数据目录 .data', true, `可写（${dir}）`);
  } catch (err) {
    record(
      '数据目录 .data',
      false,
      `写不进去：${err instanceof Error ? err.message : String(err)}`,
      '进程用户对该目录没写权限 —— 别用 root 跑，或 chown 给服务用户',
    );
  }
}

/* ---------------- 5. 单实例提醒（只有本机查得到） ---------------- */
async function checkPort(): Promise<void> {
  const port = new URL(target).port || '80';
  const busy = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: Number(port) });
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
  record(
    '服务端口',
    busy,
    busy ? `127.0.0.1:${port} 有进程在听` : `127.0.0.1:${port} 没有进程在听`,
    busy ? undefined : '服务没起，或监听在别的端口/地址上',
  );
}

/* ---------------- 跑 ---------------- */
async function main(): Promise<void> {
  console.log(`\n部署自检：${target}${isLocal ? '（本机，含环境检查）' : '（远端，只查连通性）'}\n`);

  await checkHttp();
  await checkWs();
  if (isLocal) {
    await checkEngine();
    await checkDataDir();
    await checkPort();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(`全部 ${checks.length} 项通过。\n`);
    console.log('提醒（不是错误，是这几条在上云后最容易踩）：');
    console.log('  · 房间状态在**进程内存**里 —— 只能单实例，别在后面挂 LB 复制多份；');
    console.log('  · .data 只是落盘，保证「重启不丢」，多进程之间不共享；');
    console.log('  · 当前**没有任何鉴权** —— 拿到地址的人都能建房、开局、给别人发私信；');
    console.log('  · 更新流程：git pull → npm ci → npm run build → systemctl restart lan-chess');
    console.log('');
    process.exit(0);
  }

  console.log(`${failed.length} 项失败：\n`);
  for (const c of failed) {
    console.log(`  ✗ ${c.name}：${c.detail}`);
    if (c.fix) console.log(`    → ${c.fix}`);
  }
  console.log('');
  process.exit(1);
}

void main();
