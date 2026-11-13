/**
 * 局域网运行时验收脚本 —— 覆盖 §9 的 B4、B6 两条需要「真实对局」的验收项。
 *
 *   B4：走子广播延迟 < 200ms
 *       A 落子 → 服务端校验 → 广播 → B 收到新局面。
 *       脚本记录「发包时刻 → 对端收到含新着法的 room 快照」的时间差。
 *       注意：这是**同机 loopback** 口径，包含服务端校验+广播+回环网络耗时；
 *       真实局域网多一跳（通常 < 1ms），因此是局域网延迟的**上界估计**。
 *       棋钟每秒广播一次快照，那批消息不含新着法，不会污染采样。
 *
 *   B6：人机模式可完整下一盘
 *       与服务端 AI 对弈到终局（将死 / 和棋 / 认输都算「分出结果」）。
 *
 * 用法：
 *   npx tsx scripts/verify-lan.ts [ws://127.0.0.1:3000/ws]
 *
 * 退出码：0 = 全部通过；1 = 有验收项不达标。
 */
import WebSocket from 'ws';
import { Chess } from 'chess.js';
import type { RoomState } from '../src/lib/types';

/**
 * 目标地址：优先 `--url=`（http 形式，和 verify-dm / verify-color-draw 一致），
 * 其次 `VERIFY_URL` 环境变量，最后是位置参数（`ws://` 或 `http://` 都认）。
 *
 * **为什么要统一**：门禁是串行跑的，统一成一种传法才不会「换套脚本就忘了带参数」——
 * 本来只认位置参数时，串跑脚本统一传 `--url=`，结果 `Invalid URL: --url=...` 直接崩。
 */
function resolveWsUrl(argv: string[]): string {
  const explicit = argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
  const env = process.env.VERIFY_URL;
  // 位置参数里找**真正**像地址的（`--url=xxx` 这种不算，它不以 http/ws 开头）
  const positional = argv.find((a) => /^wss?:\/\//.test(a) || /^https?:\/\//.test(a));
  const raw = explicit ?? env ?? positional ?? 'ws://127.0.0.1:3000/ws';
  // http 地址补成 ws 协议 + /ws 路径
  if (/^https?:\/\//.test(raw)) return raw.replace(/^http/, 'ws') + '/ws';
  return raw;
}
const WS_URL = resolveWsUrl(process.argv.slice(2));
const LATENCY_BUDGET_MS = 200;
/** 人机整盘最多走多少手（防止 AI 弱到无限和棋） */
const MAX_PLIES = 160;

type AnyMsg = Record<string, any>;

interface Waiter {
  pred: (m: AnyMsg) => boolean;
  resolve: (m: AnyMsg) => void;
  timer: NodeJS.Timeout;
}

/** 一个测试用 WS 客户端：自动记录 session / room 快照，可等待满足条件的消息。 */
class TestClient {
  readonly name: string;
  readonly ws: WebSocket;
  session: { token: string; userId: string; name: string } | null = null;
  room: RoomState | null = null;
  role: 'player' | 'spectator' | null = null;
  color: 'w' | 'b' | undefined;
  toasts: string[] = [];
  private waiters: Waiter[] = [];
  /**
   * 收到的**全部**报文。
   *
   * 留着是为了「回溯等待」：服务端往往在同一次广播里把好几条报文一起发出去，
   * 等我们轮到注册等待器的时候，那条报文早就到了 —— 只匹配「注册之后」的报文
   * 就会永远等不到（实测：等「抽签完成」直接 10s 超时）。
   */
  private msgs: AnyMsg[] = [];
  /** 连接就绪后才允许发包 */
  private readonly opened: Promise<void>;

  constructor(name: string) {
    this.name = name;
    this.ws = new WebSocket(WS_URL);
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.ws.on('message', (raw) => this.onMessage(String(raw)));
    this.ws.on('error', (err) => {
      console.error(`[${name}] 连接错误:`, (err as Error).message);
    });
  }

  private onMessage(raw: string): void {
    let msg: AnyMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.msgs.push(msg);
    if (msg.t === 'session') {
      this.session = msg as { token: string; userId: string; name: string };
    } else if (msg.t === 'room') {
      this.room = msg.state as RoomState;
      this.role = msg.role;
      this.color = msg.color;
    } else if (msg.t === 'toast') {
      this.toasts.push(`${msg.kind}: ${msg.message}`);
    }
    for (const w of this.waiters.slice()) {
      if (w.pred(msg)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(msg);
      }
    }
  }

  async send(obj: unknown): Promise<void> {
    await this.opened;
    this.ws.send(JSON.stringify(obj));
  }

  /** 已收到的报文条数（当「动作之前」的起点用）。 */
  get msgCount(): number {
    return this.msgs.length;
  }

  /**
   * 等待一条满足条件的消息（room 消息用 pred 检查快照内容）。
   *
   * **先回溯扫描已收到的报文**（从 `since` 起），扫不到再挂实时等待器。
   *
   * `since` 用来划边界：默认 0 = 全部已收到的报文都算数。
   * 想要「只看某个动作之后产生的」，就把动作**之前**的 `msgCount` 传进来。
   */
  waitFor(
    pred: (m: AnyMsg) => boolean,
    timeoutMs = 15000,
    label = '消息',
    since = 0,
  ): Promise<AnyMsg> {
    for (let i = since; i < this.msgs.length; i += 1) {
      const m = this.msgs[i];
      if (pred(m)) return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.timer !== timer);
        reject(new Error(`[${this.name}] 等待「${label}」超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  /** 等待房间快照满足条件（pred 收到的是 RoomState）。 */
  waitRoom(
    pred: (room: RoomState) => boolean,
    timeoutMs = 15000,
    label = '房间快照',
    since = 0,
  ): Promise<RoomState> {
    return this.waitFor(
      (m) => m.t === 'room' && pred(m.state as RoomState),
      timeoutMs,
      label,
      since,
    ).then((m) => m.state as RoomState);
  }

  async hello(): Promise<void> {
    // 服务端是收到 hello 才回 session，顺序不能反
    await this.send({ t: 'hello', name: this.name });
    await this.waitFor((m) => m.t === 'session', 10000, 'session');
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function ms(n: number): string {
  return `${n.toFixed(1)}ms`;
}

/** 计算分位数（输入需已排序） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/* ------------------------------------------------------------------ */
/* B4：走子广播延迟                                                     */
/* ------------------------------------------------------------------ */
async function verifyLatency(): Promise<{ ok: boolean; detail: string[] }> {
  const detail: string[] = [];
  const a = new TestClient('延迟甲');
  const b = new TestClient('延迟乙');

  try {
    await a.hello();
    await b.hello();

    await a.send({ t: 'room.create', timeControl: '30+0' });
    const roomA = await a.waitRoom((r) => r.status === 'waiting' || r.status === 'playing', 10000, '建房');
    const code = roomA.code;

    /*
     * **抽签 + 准备**（新规则）：
     *   两人到齐 → 服务端抽签定黑白 → 房间进入「准备中」→ 双方都点「准备」→ 开局。
     *
     * `since` 取「加入之前」的报文条数 —— 服务端是在**这次加入**之后才把房间
     * 变成「准备中」的，早于这个时刻的快照（状态还是 waiting）不算数。
     */
    const sinceJoin = b.msgCount;
    await b.send({ t: 'room.join', code, mode: 'play' });
    await a.waitRoom((r) => r.status === 'preparing', 10000, '抽签完成');
    await b.waitRoom((r) => r.status === 'preparing', 10000, '抽签完成', sinceJoin);
    const sinceReadyA = a.msgCount;
    const sinceReadyB = b.msgCount;
    await a.send({ t: 'ready' });
    await b.send({ t: 'ready' });
    await a.waitRoom((r) => r.status === 'playing', 10000, '对局开始', sinceReadyA);
    await b.waitRoom((r) => r.status === 'playing', 10000, '对局开始', sinceReadyB);

    /*
     * **谁先走由抽签决定**，不是「先建房的人」。
     * 两个客户端各自的 `color` 是服务端发的身份视角里带的（见 TestClient.color），
     * 所以这里按执色排先后 —— 写死「a 先走」会在抽到 b 执白时直接卡死。
     */
    const whiteSide = a.color === 'w' ? a : b;
    const blackSide = a.color === 'w' ? b : a;

    const samples: number[] = [];
    /**
     * 已确认走完的手数。
     *
     * 服务端广播走子结果时，**发起方自己的快照也会滞后一帧**（广播是异步的）。
     * 所以每轮开头必须等双方快照都追平到 `ply`，否则会拿着过期 FEN 去选着法，
     * 选出对方的着法、被服务端判为「非法着法 / 还没轮到你走」。
     */
    let ply = 0;
    // 双方交替走子，采样 12 次（白黑各 6 次）
    for (let i = 0; i < 12; i += 1) {
      const fromSide = i % 2 === 0 ? whiteSide : blackSide;
      const toSide = i % 2 === 0 ? blackSide : whiteSide;

      // 发起方快照追平，且必须轮到它走
      await fromSide.waitRoom(
        (r) => r.moves.length === ply && new Chess(r.fen).turn() === fromSide.color,
        10000,
        '发起方快照追平',
      );
      // 对端快照也追平（否则 before 取到的基线不准）
      await toSide.waitRoom((r) => r.moves.length === ply, 10000, '对端快照追平');

      // 从当前 FEN 里挑一个合法着法（不关心棋艺，只关心链路）
      const chess = new Chess(fromSide.room!.fen);
      const moves = chess.moves({ verbose: true });
      if (moves.length === 0) break;
      const pick = moves[Math.floor(moves.length / 2)];

      const before = toSide.room!.moves.length;
      const t0 = Date.now();
      const verbose = process.env.VERBOSE === '1';
      if (verbose) {
        console.log(
          `  [i=${i}] 发起 ${fromSide.name}(${fromSide.color}) 着法 ${pick.from}→${pick.to} | ` +
            `本地FEN回合=${chess.turn()} 本地moves=${fromSide.room!.moves.length} 对端moves=${before}`,
        );
      }
      await fromSide.send({ t: 'move', from: pick.from, to: pick.to, promotion: pick.promotion });
      try {
        await toSide.waitRoom((r) => r.moves.length > ply, 10000, '收到新着法');
      } catch (err) {
        console.error('  诊断：', (err as Error).message);
        console.error('  A toast:', a.toasts.slice(-3));
        console.error('  B toast:', b.toasts.slice(-3));
        console.error('  A room:', {
          moves: a.room?.moves.length,
          fen: a.room?.fen,
          status: a.room?.status,
          color: a.color,
        });
        console.error('  B room:', {
          moves: b.room?.moves.length,
          fen: b.room?.fen,
          status: b.room?.status,
          color: b.color,
        });
        console.error('  本次尝试着法:', pick.from, '→', pick.to, '发起方', fromSide.name);
        throw err;
      }
      samples.push(Date.now() - t0);
      ply += 1;
    }

    if (samples.length === 0) {
      return { ok: false, detail: [...detail, '未采集到任何延迟样本'] };
    }
    const sorted = [...samples].sort((x, y) => x - y);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const max = sorted[sorted.length - 1];
    const avg = samples.reduce((s, x) => s + x, 0) / samples.length;

    detail.push(`样本数 ${samples.length}`);
    detail.push(`最小 ${ms(sorted[0])} · 平均 ${ms(avg)} · p50 ${ms(p50)} · p95 ${ms(p95)} · 最大 ${ms(max)}`);
    const ok = max < LATENCY_BUDGET_MS;
    detail.push(
      ok
        ? `✅ 最坏一次 ${ms(max)} < ${LATENCY_BUDGET_MS}ms 预算`
        : `❌ 最坏一次 ${ms(max)} ≥ ${LATENCY_BUDGET_MS}ms 预算`,
    );
    return { ok, detail };
  } finally {
    a.close();
    b.close();
  }
}

/* ------------------------------------------------------------------ */
/* B6：人机模式完整下一盘                                               */
/* ------------------------------------------------------------------ */
async function verifyAiGame(): Promise<{ ok: boolean; detail: string[] }> {
  const detail: string[] = [];
  const human = new TestClient('人机玩家');

  try {
    await human.hello();
    /*
     * **显式让玩家执黑**（`color: 'b'`）。
     *
     * 人机局默认是「随机抽签」—— 那下面「等轮到玩家（黑方）」的判据
     * 有一半概率不成立（玩家可能是白方，轮到的是 AI）。
     * 这里把颜色定死，测的仍然是真实链路，只是把随机那一维去掉。
     */
    await human.send({ t: 'room.create', timeControl: '30+0', withAI: true, color: 'b' });
    await human.waitRoom((r) => r.status === 'playing', 10000, '人机开局');

    let result: RoomState['result'] | undefined;

    // 人机对局里玩家执**黑**、AI 执**白**先走
    for (let turn = 0; turn < MAX_PLIES; turn += 1) {
      const state = human.room!;
      if (state.status === 'finished') {
        result = state.result;
        break;
      }

      // 等 AI 的第一手走完、轮到玩家（黑方）
      await human.waitRoom(
        (r) => r.status === 'finished' || new Chess(r.fen).turn() === 'b',
        30000,
        '轮到玩家走',
      );
      const cur = human.room!;
      if (cur.status === 'finished') {
        result = cur.result;
        break;
      }

      const chess = new Chess(cur.fen);
      const moves = chess.moves({ verbose: true });
      if (moves.length === 0) break;

      // 人方走「随机但合法」的一手：AI 会抓住失误，几十手内就该分出结果
      const pick = moves[Math.floor(moves.length / 2)];
      const before = cur.moves.length;
      await human.send({ t: 'move', from: pick.from, to: pick.to, promotion: pick.promotion });

      // 等 AI 应招：人类这手 + AI 那手 = +2（AI 思考 600ms + 搜索）
      try {
        await human.waitRoom((r) => r.status === 'finished' || r.moves.length >= before + 2, 40000, 'AI 应招');
      } catch (err) {
        console.error('  诊断：等待 AI 应招超时', (err as Error).message);
        console.error('  当前状态：', {
          moves: human.room?.moves.length,
          fen: human.room?.fen,
          status: human.room?.status,
        });
        console.error('  toast：', human.toasts.slice(-3));
        throw err;
      }
    }

    const final = human.room!;
    if (final.status !== 'finished') {
      detail.push(`❌ 走了 ${final.moves.length} 手仍未分出结果（上限 ${MAX_PLIES}）`);
      return { ok: false, detail };
    }

    detail.push(`✅ 对局结束：${final.moves.length} 手，局面 ${final.fen}`);
    detail.push(`结果：原因 ${final.result?.reason ?? '未知'} · 胜方 ${final.result?.winner ?? '未知'}`);
    const ok = Boolean(final.result);
    return { ok, detail };
  } finally {
    human.close();
  }
}

/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  console.log(`目标服务：${WS_URL}\n`);

  console.log('── B4 走子广播延迟 ──');
  const latency = await verifyLatency();
  latency.detail.forEach((d) => console.log(`   ${d}`));

  console.log('\n── B6 人机模式完整下一盘 ──');
  const ai = await verifyAiGame();
  ai.detail.forEach((d) => console.log(`   ${d}`));

  const ok = latency.ok && ai.ok;
  console.log(`\n结果：${ok ? '✅ 全部通过' : '❌ 存在未通过项'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('验收脚本异常：', err);
  process.exit(1);
});
