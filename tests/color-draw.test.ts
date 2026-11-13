import { describe, expect, it } from 'vitest';
import { RoomManager, type RoomInternal } from '@/server/room-manager';
import { START_FEN } from '@/lib/constants';

const alice = { userId: 'u-alice', name: '球球' };
const bob = { userId: 'u-bob', name: '小明' };

/**
 * 抽签是**随机**的，所以「谁执白」在测试里天然不可预测。
 *
 * `RoomManager` 构造器接受一个随机源：
 *   · `() => 0` → 永远抽到「先进的人执白」
 *   · `() => 1` → 永远抽到「先进的人执黑」
 *   · 序列源   → 可以精确控制「先白后黑」，用来测「真的会换边」
 */
function fixedRm(value: number): RoomManager {
  return new RoomManager(() => value);
}

/** 依次返回给定序列的随机源 */
function sequenceRm(values: number[]): RoomManager {
  let i = 0;
  return new RoomManager(() => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  });
}

describe('抽签定黑白', () => {
  it('先进来的人**颜色待定**，不是白方', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    // 他还没进座位 —— 黑白要等对手到齐才抽
    expect(room.seats.w).toBeUndefined();
    expect(room.seats.b).toBeUndefined();
    expect(room.pending?.userId).toBe(alice.userId);
    expect(room.status).toBe('waiting');
  });

  it('两人到齐后各执一边（先进的人不一定执白）', () => {
    const rm = fixedRm(1); // 抽到「后进的人执白」
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    expect(room.seats.w?.userId).toBe(bob.userId);
    expect(room.seats.b?.userId).toBe(alice.userId);
    expect(room.pending).toBeUndefined();
  });

  it('抽签结果真的会换边（不是恒定一方执白）', () => {
    // 先 0 后 1：第一次先进的人执白，第二次（重开）后进的人执白
    const rm = sequenceRm([0, 1]);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    expect(room.seats.w?.userId).toBe(alice.userId);
    expect(room.seats.b?.userId).toBe(bob.userId);
  });

  it('第三个人进来只能观战（不会挤掉已在抽签中的两人）', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    rm.joinRoom(room.code, { userId: 'u-carol', name: '小红' }, 'play');
    expect(room.spectators.map((s) => s.userId)).toEqual(['u-carol']);
    expect(room.seats.w?.userId).toBe(alice.userId);
    expect(room.seats.b?.userId).toBe(bob.userId);
  });
});

describe('准备环节', () => {
  it('两人到齐后进入「准备」阶段，还没开局', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    expect(room.status).toBe('preparing');
    // 还没开局：棋谱是空的，而且走子会被服务端拒（下面那条单独测）
    expect(room.moves).toHaveLength(0);
  });

  it('只有一方点准备不会开局', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    expect(rm.markReady(room, alice).ok).toBe(true);
    expect(room.status).toBe('preparing');
    expect(room.moves).toHaveLength(0);
  });

  it('双方都点准备才开局，且白方先走', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    rm.markReady(room, alice);
    rm.markReady(room, bob);
    expect(room.status).toBe('playing');
    expect(room.fen).toBe(START_FEN);
    expect(room.fen.split(' ')[1]).toBe('w');
  });

  it('准备阶段走不了子', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    const res = rm.submitMove(room, alice, { from: 'e2', to: 'e4' });
    expect(res.ok).toBe(false);
  });

  it('准备阶段不算认输 / 和棋', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    expect(rm.resign(room, alice).ok).toBe(false);
    expect(rm.offerDraw(room, alice).ok).toBe(false);
  });

  it('人机对局**不走**准备环节（AI 不需要准备），直接开局', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.setupVsAI(room, alice, 'w');
    expect(room.status).toBe('playing');
    expect(room.fen).toBe(START_FEN);
  });
});

describe('人机对战选色', () => {
  it('玩家选「我执白」→ 玩家坐白方，电脑坐黑方', () => {
    const rm = fixedRm(1); // 随机源故意偏向黑，抽签也没用
    const room = rm.createRoom();
    rm.setupVsAI(room, alice, 'w');
    expect(room.seats.w?.userId).toBe(alice.userId);
    expect(room.seats.w?.isAI).toBe(false);
    expect(room.seats.b?.isAI).toBe(true);
  });

  it('玩家选「我执黑」→ 玩家坐黑方，电脑坐白方', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.setupVsAI(room, alice, 'b');
    expect(room.seats.b?.userId).toBe(alice.userId);
    expect(room.seats.w?.isAI).toBe(true);
  });

  it('玩家选「随机」→ 由抽签决定', () => {
    const rmWhite = fixedRm(0);
    const roomW = rmWhite.createRoom();
    rmWhite.setupVsAI(roomW, alice, 'random');
    expect(roomW.seats.w?.userId).toBe(alice.userId);

    const rmBlack = fixedRm(1);
    const roomB = rmBlack.createRoom();
    rmBlack.setupVsAI(roomB, alice, 'random');
    expect(roomB.seats.b?.userId).toBe(alice.userId);
  });
});

describe('再来一局与人员变动', () => {
  it('真人局「再来一局」会**重新抽签**（黑白可能互换）', () => {
    // 先 0 后 1：第一次 alice 白，重开后 bob 白
    const rm = sequenceRm([0, 1]);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    rm.markReady(room, alice);
    rm.markReady(room, bob);
    expect(room.seats.w?.userId).toBe(alice.userId);

    // 走到终局
    rm.resign(room, bob);
    expect(room.status).toBe('finished');

    rm.requestRematch(room, alice);
    rm.requestRematch(room, bob);
    // 重新抽签 → 这次 bob 执白
    expect(room.seats.w?.userId).toBe(bob.userId);
    expect(room.seats.b?.userId).toBe(alice.userId);
    // 而且回到「准备」阶段
    expect(room.status).toBe('preparing');
  });

  it('开局前一方离开，另一方退回「颜色待定」（换对手要重抽）', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    // 抽签完成，但**还没开局**（一方没点准备）
    rm.markReady(room, alice);
    expect(room.status).toBe('preparing');
    rm.leaveRoom(room, bob);
    // 对局没开始 → 剩下的人退回「颜色待定」，等新对手来了重抽
    expect(room.seats.w).toBeUndefined();
    expect(room.seats.b).toBeUndefined();
    expect(room.pending?.userId).toBe(alice.userId);
    expect(room.status).toBe('waiting');
  });

  it('对局中一方离开 → 判负，另一方**保留座位**（不退回待抽签）', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.joinRoom(room.code, bob, 'play');
    rm.markReady(room, alice);
    rm.markReady(room, bob);
    expect(room.status).toBe('playing');

    rm.leaveRoom(room, bob);
    /*
     * 胜负已定 → 房间是「finished」，不是「waiting」；
     * 对手**留在座位上** —— 否则胜负记录跟着空座位一起没了，
     * 对手那边看到的就是「空房间」，而不是「我赢了」。
     */
    expect(room.status).toBe('finished');
    expect(room.result?.reason).toBe('abandon');
    expect(room.result?.winner).toBe(alice.userId === room.seats.w?.userId ? 'w' : 'b');
    expect(room.pending).toBeUndefined();
    expect(Object.keys(room.seats).filter((k) => room.seats[k as 'w' | 'b'])).toHaveLength(1);
  });

  it('待抽签的玩家断线超时后，房间能接新玩家', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.disconnect(room, alice);
    // 伪造「已经断线超过宽限期」
    room.pending!.disconnectedAt = Date.now() - 10 * 60 * 1000;
    const res = rm.joinRoom(room.code, bob, 'play');
    expect(res.ok).toBe(true);
    expect(room.pending?.userId).toBe(bob.userId);
  });

  it('待抽签的玩家断线后房间不会被当成空房清理掉', () => {
    const rm = fixedRm(0);
    const room = rm.createRoom();
    rm.joinRoom(room.code, alice, 'play');
    rm.disconnect(room, alice);
    // 还在宽限期内 → 房间留着等重连
    expect(rm.cleanup()).toBe(false);
    expect(rm.getRoom(room.code)).toBeDefined();
  });

  it('快速匹配也走抽签 + 准备流程', () => {
    const rm = fixedRm(1);
    const room = rm.createRoom();
    rm.setupMatch(room, alice, bob);
    expect(room.seats.w?.userId).toBe(bob.userId);
    expect(room.status).toBe('preparing');
    rm.markReady(room, alice);
    rm.markReady(room, bob);
    expect(room.status).toBe('playing');
  });
});

/** 让 TS 知道 RoomInternal 用到了（避免 unused import 警告） */
export type _Unused = RoomInternal;
