import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { RoomManager, type RoomInternal } from '@/server/room-manager';
import { Matchmaker } from '@/server/matchmaking';
import { DISCONNECT_GRACE_MS, START_FEN } from '@/lib/constants';

const alice = { userId: 'u-alice', name: '球球' };
const bob = { userId: 'u-bob', name: '小明' };
const carol = { userId: 'u-carol', name: '小红' };

/** 等一小会儿（用来让棋钟真的走掉一段） */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 直接摆一个局面。
 *
 * 房间的**权威局面是活实例** `room.game`（走子历史都在里面，
 * 三次重复局面检测靠的就是它），`room.fen` 只是它的镜像。
 * 所以摆局面必须**两个一起改** —— 只改 `room.fen` 的话，
 * 活实例还停在旧局面，走子校验会拿旧局面来判。
 */
function setPosition(room: RoomInternal, fen: string): void {
  room.game = new Chess(fen);
  room.fen = fen;
}

/**
 * **两个人进房并各自点「准备」** → 开局。
 *
 * 新规则：黑白是两人到齐时**抽签**定的，而且**双方都点「准备」**才开局
 * （抽签之后白方先走，得给他一点时间看清自己执的是哪一边）。
 *
 * 于是老测试里那一串「join 两次」现在要补上「准备」——
 * 绝大多数测试只关心开局之后的局面，所以统一走这个 helper。
 */
function seatAndReady(
  rm: RoomManager,
  room: RoomInternal,
  a: typeof alice = alice,
  b: typeof bob = bob,
): void {
  rm.joinRoom(room.code, a, 'play');
  rm.joinRoom(room.code, b, 'play');
  rm.markReady(room, a);
  rm.markReady(room, b);
}

describe('房间加入与座位', () => {
  it('第一个进入者执白，第二个执黑', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    expect(room.seats.w?.userId).toBe(alice.userId);
    expect(room.seats.b?.userId).toBe(bob.userId);
    expect(room.status).toBe('playing');
  });

  it('观战者不占座位', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.joinRoom(room.code, carol, 'spectate');
    expect(room.seats.w?.userId).not.toBe(carol.userId);
    expect(room.seats.b?.userId).not.toBe(carol.userId);
    expect(room.spectators.map((s) => s.userId)).toContain(carol.userId);
  });

  it('两人满了之后第三人用 play 模式进来会变成观战', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.joinRoom(room.code, carol, 'play');
    expect(room.seats.w?.userId).not.toBe(carol.userId);
    expect(room.seats.b?.userId).not.toBe(carol.userId);
    expect(room.spectators).toHaveLength(1);
  });

  it('重复 join 不会顶掉已有座位', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, alice, 'play');
    expect(room.spectators).toHaveLength(0);
    // 他现在**颜色待定**（等对手到齐才抽签），不是白方
    expect(room.pending?.userId).toBe(alice.userId);
    expect(room.seats.w).toBeUndefined();
  });
});

describe('走子权威校验', () => {
  it('轮到自己时合法着法被接受', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    const res = rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    expect(res.ok).toBe(true);
    expect(room.fen.split(' ')[1]).toBe('b');
    expect(room.moves).toHaveLength(1);
    expect(room.moves[0].san).toBe('e4');
  });

  it('不是自己回合时被拒绝', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    const res = rm.submitMove(room, bob, { from: 'e7', to: 'e5' });
    expect(res.ok).toBe(false);
    expect(room.moves).toHaveLength(0);
  });

  it('非法着法被拒绝且不改变局面', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    const before = room.fen;
    const res = rm.submitMove(room, alice, { from: 'e2', to: 'e5' });
    expect(res.ok).toBe(false);
    expect(room.fen).toBe(before);
  });

  it('观战者不能走子', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.joinRoom(room.code, carol, 'spectate');
    const res = rm.submitMove(room, carol, { from: 'e2', to: 'e4' });
    expect(res.ok).toBe(false);
  });

  it('将死自动判负', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    // 直接摆一个白方一步杀的局面
    setPosition(room, '6k1/5Q2/5K2/8/8/8/8/8 w - - 0 1');
    const res = rm.submitMove(room, alice, { from: 'f7', to: 'g7' });
    expect(res.ok).toBe(true);
    expect(room.status).toBe('finished');
    expect(room.result).toEqual({ winner: 'w', reason: 'checkmate' });
  });
});

describe('认输 / 和棋 / 再来一局', () => {
  it('认输判对方胜', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.resign(room, bob);
    expect(room.status).toBe('finished');
    expect(room.result).toEqual({ winner: 'w', reason: 'resign' });
  });

  it('和棋需要对方接受', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.offerDraw(room, alice);
    expect(room.drawOffer).toBe('w');
    // 自己不能接受自己的提议
    expect(rm.acceptDraw(room, alice).ok).toBe(false);
    rm.acceptDraw(room, bob);
    expect(room.result).toEqual({ winner: 'draw', reason: 'draw' });
  });

  it('双方同意后再来一局会重置局面', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.submitMove(room, bob, { from: 'e7', to: 'e5' });
    rm.resign(room, bob);
    expect(room.status).toBe('finished');

    rm.requestRematch(room, alice);
    expect(room.status).toBe('finished'); // 只同意一方不会重开
    rm.requestRematch(room, bob);
    // 新规则：真人局重开回到「准备」阶段（而且**重新抽签**）
    expect(room.status).toBe('preparing');
    rm.markReady(room, alice);
    rm.markReady(room, bob);
    expect(room.status).toBe('playing');
    expect(room.moves).toHaveLength(0);
    expect(room.fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it('同一方重复申请再来一局只算一票', () => {
    // 客户端虽然已经在本地锁住了按钮，但服务端也得去重 ——
    // 否则连点两下就会被当成「双方都同意」，直接开新局。
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.submitMove(room, bob, { from: 'e7', to: 'e5' });
    rm.resign(room, bob);
    expect(room.status).toBe('finished');

    rm.requestRematch(room, alice);
    rm.requestRematch(room, alice);
    rm.requestRematch(room, alice);
    expect(room.rematchVotes).toEqual(['w']);
    expect(room.status).toBe('finished'); // 还是只有一方同意 → 不重开
  });

  it('对局没结束不能申请再来一局', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    const res = rm.requestRematch(room, alice);
    expect(res.ok).toBe(false);
    expect(room.rematchVotes).toEqual([]);
  });
});

describe('聊天限频与长度', () => {
  it('空消息被拒绝', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    expect(rm.chat(room, alice, '   ').ok).toBe(false);
  });

  it('超长消息被截断', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    const res = rm.chat(room, alice, 'x'.repeat(500));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message.text.length).toBe(200);
  });

  it('连发太快会被限频', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    expect(rm.chat(room, alice, '第一条').ok).toBe(true);
    expect(rm.chat(room, alice, '第二条').ok).toBe(false);
  });
});

/**
 * 快捷聊天**不进聊天记录**（用户拍板）。
 *
 * 记录里留的全是正经聊的话；弹幕一扫就没，不占地方。
 */
describe('快捷聊天不进聊天记录', () => {
  it('快捷聊天不写进 room.chat，且消息带 quick 标记', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');

    // 打字的 → 进记录
    expect(rm.chat(room, alice, '打字的进记录').ok).toBe(true);
    // 快捷的 → 不进记录
    const res = rm.quickChat(room, alice, '好棋');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message.quick).toBe(true);

    expect(room.chat.map((c) => c.text)).toEqual(['打字的进记录']);
  });

  it('快捷聊天和打字聊天各走各的限频，互不拖累', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');

    // 先连发两条快捷聊天 → 第二条被限频
    expect(rm.quickChat(room, alice, '好棋').ok).toBe(true);
    expect(rm.quickChat(room, alice, '快点吧').ok).toBe(false);
    // 但打字聊天不受影响（各走各的计数器）
    expect(rm.chat(room, alice, '我还在').ok).toBe(true);
  });
});

describe('断线与重连', () => {
  it('断线后座位保留', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.disconnect(room, bob);
    expect(room.seats.b?.userId).toBe(bob.userId);
    expect(room.seats.b?.connected).toBe(false);
  });

  it('重连后恢复连接状态', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.disconnect(room, bob);
    rm.reconnect(room, bob);
    expect(room.seats.b?.connected).toBe(true);
  });

  it('断线超过宽限期后判对方胜，房间不再挂成「进行中」', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });

    rm.disconnect(room, bob);
    // 伪造「已经断线很久」：把断线时刻往前拨过整个宽限期
    const seat = room.seats.b!;
    seat.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;

    const events = rm.tick();
    expect(events.length).toBe(1);
    expect(room.status).toBe('finished');
    expect(room.result).toEqual({ winner: 'w', reason: 'abandon' });
  });

  it('断线但仍在宽限期内时，对局继续挂着等重连', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.disconnect(room, bob);

    // 刚断线：不算超时
    expect(rm.tick().length).toBe(0);
    expect(room.status).toBe('playing');
    // 座位仍在，等对方回来
    expect(room.seats.b?.userId).toBe(bob.userId);
  });

  it('所有玩家都断线且超过宽限期后，房间会被清理掉', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.disconnect(room, alice);

    // 刚断线：房间还在，留着重连的余地
    rm.cleanup();
    expect(rm.getRoom(room.code)).toBeDefined();

    // 断线时刻往前拨过整个宽限期 → 没人会回来了 → 房间没意义，删掉
    room.pending!.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;
    rm.cleanup();
    expect(rm.getRoom(room.code)).toBeUndefined();
  });

  it('cleanup() 会报告是否真的删掉了房间（调用方据此广播大厅）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.disconnect(room, alice);

    // 还在宽限期内 → 什么都没删
    expect(rm.cleanup()).toBe(false);
    expect(rm.getRoom(room.code)).toBeDefined();

    // 超过宽限期 → 房间被删，返回 true
    room.pending!.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;
    expect(rm.cleanup()).toBe(true);
    expect(rm.getRoom(room.code)).toBeUndefined();
  });

  it('还有观战者在的房间不会被清理', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, carol, 'spectate');
    rm.disconnect(room, alice);
    room.pending!.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;
    rm.cleanup();
    expect(rm.getRoom(room.code)).toBeDefined();
  });

  it('新玩家不会被塞进一个「该判负」的房间（开局即终局）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });

    // 甲掉线，并伪造「已经断线超过宽限期」
    rm.disconnect(room, alice);
    room.seats.w!.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;

    // 丙拿着房间码进来：结算应先发生 —— 房间已结束，丙不能加入
    const res = rm.joinRoom(room.code, carol, 'play');
    expect(res.ok).toBe(false);
    expect(room.status).toBe('finished');
    expect(room.result).toEqual({ winner: 'b', reason: 'abandon' });
  });

  it('waiting 房间里掉线的人会被清掉，房间还能接新玩家', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play'); // 只有一人 → waiting
    expect(room.status).toBe('waiting');

    rm.disconnect(room, alice);
    room.pending!.disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;

    // 新玩家进来：僵死的待抽签玩家先被清掉，他接手这个房间（颜色待定）
    const res = rm.joinRoom(room.code, bob, 'play');
    expect(res.ok).toBe(true);
    expect(room.pending?.userId).toBe(bob.userId);
    expect(room.status).toBe('waiting');
  });

  it('玩家主动离开直接判负', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.leaveRoom(room, bob);
    expect(room.result).toEqual({ winner: 'w', reason: 'abandon' });
  });
});

describe('快速匹配队列', () => {
  it('第一个人入队时没有对手', () => {
    const mm = new Matchmaker();
    expect(mm.push({ userId: 'a', name: 'A' })).toBeNull();
    expect(mm.size).toBe(1);
  });

  it('第二个人入队时与第一个人配对', () => {
    const mm = new Matchmaker();
    mm.push({ userId: 'a', name: 'A' });
    const opponent = mm.push({ userId: 'b', name: 'B' });
    expect(opponent?.userId).toBe('a');
    expect(mm.size).toBe(0);
  });

  it('重复入队不会把自己当对手', () => {
    const mm = new Matchmaker();
    mm.push({ userId: 'a', name: 'A' });
    expect(mm.push({ userId: 'a', name: 'A' })).toBeNull();
    expect(mm.size).toBe(1);
  });

  it('离开队列后被移除', () => {
    const mm = new Matchmaker();
    mm.push({ userId: 'a', name: 'A' });
    mm.remove('a');
    expect(mm.size).toBe(0);
  });
});

describe('人机对局', () => {
  it('AI 执白、玩家执黑时可以走子', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.setupVsAI(room, alice, 'b');
    expect(room.seats.w?.isAI).toBe(true);
    expect(room.seats.b?.userId).toBe(alice.userId);
    expect(room.status).toBe('playing');
    // 玩家执黑，开局不能走
    expect(rm.submitMove(room, alice, { from: 'e2', to: 'e4' }).ok).toBe(false);
  });

  it('AI 会走出合法的一步', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.setupVsAI(room, alice, 'b');
    const res = rm.submitAiMove(room);
    expect(res.ok).toBe(true);
    expect(room.moves).toHaveLength(1);
    expect(room.moves[0].color).toBe('w');
  });
});

/* ------------------------------------------------------------------ */
/* 悔棋                                                                */
/* ------------------------------------------------------------------ */

describe('悔棋', () => {
  it('发起悔棋只是挂起请求，棋谱不变', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    const res = rm.offerTakeback(room, alice);
    expect(res.ok).toBe(true);
    expect(room.takebackOffer?.by).toBe('w');
    expect(room.moves).toHaveLength(1);
  });

  it('对方同意后撤销自己的那一步', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.offerTakeback(room, alice);
    expect(rm.acceptTakeback(room, bob).ok).toBe(true);
    expect(room.moves).toHaveLength(0);
    expect(room.fen).toBe(START_FEN);
    expect(room.fen.split(' ')[1]).toBe('w');
    expect(room.takebackOffer).toBeUndefined();
  });

  it('对方已经回应时不能再悔棋（只撤自己那一步做不到）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.submitMove(room, bob, { from: 'e7', to: 'e5' });
    // 白方刚走完就被回应了 → 白方那一步已经不能单独撤
    const res = rm.offerTakeback(room, alice);
    expect(res.ok).toBe(false);
    expect(room.takebackOffer).toBeUndefined();
    expect(room.moves).toHaveLength(2);
  });

  it('只撤销请求方自己那一步，撤完轮到他重走', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.submitMove(room, bob, { from: 'e7', to: 'e5' });
    rm.submitMove(room, alice, { from: 'g1', to: 'f3' });
    // 白方刚走完（黑方还没回应）→ 可以悔
    expect(rm.offerTakeback(room, alice).ok).toBe(true);
    expect(rm.acceptTakeback(room, bob).ok).toBe(true);
    // 只撤了白方自己那一步，黑方那一步**还在**
    expect(room.moves).toHaveLength(2);
    expect(room.moves[1].color).toBe('b');
    // 局面回到白方走 g1-f3 之前 → 轮次回到白方
    expect(room.fen.split(' ')[1]).toBe('w');
    expect(room.fen).toContain('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR');
  });

  it('不能同意自己的悔棋请求', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.offerTakeback(room, alice);
    expect(rm.acceptTakeback(room, alice).ok).toBe(false);
    expect(room.moves).toHaveLength(1);
  });

  it('对方拒绝后请求作废，棋谱不变', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.offerTakeback(room, alice);
    expect(rm.declineTakeback(room, bob).ok).toBe(true);
    expect(room.takebackOffer).toBeUndefined();
    expect(room.moves).toHaveLength(1);
  });

  it('悔棋**不回退棋钟**（时间照常走，悔棋者重新开始计时）', async () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    const before = room.clock.wMs;
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    // 走完那一步时结算过一次 → 白方剩余时间已经比开局少（可能还有加秒）
    const afterMove = room.clock.wMs;
    expect(afterMove).toBeLessThanOrEqual(before);
    // 让黑方（当前该走棋的一方）真的思考一会儿
    await sleep(40);
    rm.offerTakeback(room, alice);
    await sleep(40);
    rm.acceptTakeback(room, bob);
    // 悔棋**不恢复**棋钟快照：白方的时间没有被「退回去」
    expect(room.clock.wMs).toBe(afterMove);
    // 对方思考的那段时间算**对方**的，不转嫁给悔棋者
    expect(room.clock.bMs).toBeLessThan(before);
    // 而且轮次回到白方 → 白方的钟重新开始走（running = true）
    expect(room.fen.split(' ')[1]).toBe('w');
    expect(room.clock.running).toBe(true);
  });

  it('没走过棋的人不能悔棋', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    const res = rm.offerTakeback(room, bob);
    expect(res.ok).toBe(false);
  });

  it('对方是电脑时自动同意并直接撤销', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.setupVsAI(room, alice, 'b');
    rm.submitAiMove(room);
    expect(room.moves).toHaveLength(1);
    // 玩家自己也走一步，才能悔**自己**那一步
    rm.submitMove(room, alice, { from: 'e7', to: 'e5' });
    expect(room.moves).toHaveLength(2);
    const res = rm.offerTakeback(room, alice);
    expect(res.ok).toBe(true);
    expect(res.ok && res.autoAccepted).toBe(true);
    // 只撤销玩家自己那一步，电脑那步留着
    expect(room.moves).toHaveLength(1);
    expect(room.moves[0].color).toBe('w');
  });
});

/* ------------------------------------------------------------------ */
/* 请求超时 = 自动拒绝                                                 */
/* ------------------------------------------------------------------ */

describe('请求超时自动拒绝', () => {
  it('和棋请求超时后自动作废', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.offerDraw(room, alice);
    expect(room.drawOffer).toBe('w');
    room.drawDeadline = Date.now() - 1;
    const events = rm.tick();
    expect(room.drawOffer).toBeUndefined();
    expect(room.drawDeadline).toBeUndefined();
    const expired = events.find((e) => e.event === 'offer-expired');
    expect(expired && expired.event === 'offer-expired' && expired.kind).toBe('draw');
  });

  it('超时之后再来接受也来不及了', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.offerDraw(room, alice);
    room.drawDeadline = Date.now() - 1;
    expect(rm.acceptDraw(room, bob).ok).toBe(false);
    expect(room.result).toBeUndefined();
  });

  it('悔棋请求超时后自动作废', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    rm.offerTakeback(room, alice);
    room.takebackOffer!.deadline = Date.now() - 1;
    const events = rm.tick();
    expect(room.takebackOffer).toBeUndefined();
    const expired = events.find((e) => e.event === 'offer-expired');
    expect(expired && expired.event === 'offer-expired' && expired.kind).toBe('takeback');
    expect(room.moves).toHaveLength(1);
  });

  it('电脑直接拒绝和棋（不用干等超时）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    rm.setupVsAI(room, alice, 'b');
    const res = rm.offerDraw(room, alice);
    expect(res.ok).toBe(false);
    expect(room.drawOffer).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 超时判负 —— 但不结束棋局                                            */
/* ------------------------------------------------------------------ */

/**
 * 把当前走子方的时间**直接设成已经超时**（不用真等）。
 *
 * 做法：把剩余时间设成 30ms，再把 `lastTickAt` 往回拨 100ms ——
 * 服务端 `tick()` 算的是 `剩余 - (now - lastTickAt)`，这样一 tick 就越界了。
 */
function forceTimeout(room: RoomInternal, color: 'w' | 'b' = 'w'): void {
  const key = color === 'w' ? 'wMs' : 'bMs';
  room.clock[key] = 30;
  room.clock.lastTickAt = Date.now() - 100;
}

describe('超时判负但不终局', () => {
  it('超时后对局**不结束**，结果记为对方胜并锁定', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    forceTimeout(room, 'w');

    const events = rm.tick();
    // 超时事件照发（前端要靠它弹提示）
    expect(events.some((e) => e.event === 'timeout')).toBe(true);
    // **关键**：棋局还在继续
    expect(room.status).toBe('playing');
    // 结果：白方超时 → 黑方胜
    expect(room.result).toEqual({ winner: 'b', reason: 'timeout' });
    // 结果被锁定
    expect(room.resultLocked).toBe(true);
    // 白方被标记为「已超时」
    expect(room.flagged).toContain('w');
    // 棋钟还在走（继续下棋，时间继续往负数走）
    expect(room.clock.running).toBe(true);
  });

  it('同一方超时**只播报一次**（每秒 tick 不重复报）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    forceTimeout(room, 'w');

    expect(rm.tick().some((e) => e.event === 'timeout')).toBe(true);
    // 再 tick 十次也不该重复播报
    for (let i = 0; i < 10; i += 1) rm.tick();
    expect(rm.tick().some((e) => e.event === 'timeout')).toBe(false);
    expect(room.flagged).toEqual(['w']);
  });

  it('超时后**还能继续走棋**', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    forceTimeout(room, 'w');
    rm.tick();

    const res = rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    expect(res.ok).toBe(true);
    expect(room.moves).toHaveLength(1);
    expect(room.status).toBe('playing');
  });

  it('超时后棋钟**能变成负数**（走完那一步就结算成负数）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    forceTimeout(room, 'w');
    rm.tick();

    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    // 白方的剩余时间是负的（超时了 70ms 左右）
    expect(room.clock.wMs).toBeLessThan(0);
  });

  it('判负后**增量照发**（规则统一，不给判负方开特例）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    room.clock.incrementMs = 3000;
    forceTimeout(room, 'w');
    rm.tick();

    rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    // 超时欠了约 70ms，走完这一步拿到 +3 秒 → 时间被增量拉回了正数。
    // 这是「增量照发、不给判负方开特例」的必然结果：
    // 棋钟只是个能变负的数，而**结果早在超时那一刻就锁定了**，不受影响。
    expect(room.clock.wMs).toBeGreaterThan(0);
    expect(room.clock.wMs).toBeLessThan(3000);
    expect(room.resultLocked).toBe(true);
    expect(room.result).toEqual({ winner: 'b', reason: 'timeout' });
  });

  it('锁定的结果**不被后来的终局改写**（认输也不改）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    forceTimeout(room, 'w');
    rm.tick();
    expect(room.result?.reason).toBe('timeout');

    // 白方认输 —— 对局结束，但结果还是那次超时
    const res = rm.resign(room, alice);
    expect(res.ok).toBe(true);
    expect(room.status).toBe('finished');
    expect(room.result).toEqual({ winner: 'b', reason: 'timeout' });
  });

  it('超时后**可以申请再来一局**，双方同意就开新局（并清掉锁定）', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    forceTimeout(room, 'w');
    rm.tick();
    expect(room.status).toBe('playing');

    // 对局还没结束，但结果已定 → 允许申请
    expect(rm.requestRematch(room, alice).ok).toBe(true);
    expect(room.rematchVotes).toContain('w');
    // 只有一方申请 → 还不开新局
    expect(room.moves).toHaveLength(0);

    rm.requestRematch(room, bob);
    // 双方同意 → 开新局：锁定和「已超时」标记都清掉
    expect(room.result).toBeUndefined();
    expect(room.resultLocked).toBe(false);
    expect(room.flagged).toEqual([]);
  });

  it('没超时的时候不能申请再来一局', () => {
    const rm = new RoomManager(() => 0);
    const room = rm.createRoom();
    seatAndReady(rm, room);
    const res = rm.requestRematch(room, alice);
    expect(res.ok).toBe(false);
  });
});
