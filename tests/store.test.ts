/**
 * **存档写盘**的测试 —— `tests/store.test.ts`
 *
 * 覆盖一条真实事故（2026-11-27 取证发现）：
 *   生产服务器上存档从 11-25 16:34 起就一直在报
 *   `rename '/opt/lan-chess/.data/rooms.json.tmp' -> '...rooms.json': ENOENT`，
 *   **连续 46 小时** —— 也就是说，房间和会话状态那段时间**根本没存进盘**，
 *   而服务端只是把错误打印出来，谁也没看见。
 *
 * 根因：原子写用了**固定的临时文件名**（`${file}.tmp`）。
 *   两个并发的写会互相抢那个 tmp 文件：
 *   A 写完 tmp → B 覆盖写 tmp → A 先 rename 把 tmp 移走 → B 再 rename
 *   → 源文件已经不在了 → **ENOENT**。
 *
 *   机器越忙（写盘越慢）越容易交错 —— 而那正是最需要存档的时候。
 *
 * 所以这里测两件事：
 *   1. **并发 flush 不会报错**：并发写同一个文件，tmp 文件名必须互不相同；
 *   2. **并发 flush 之后存档是完整的**：不是空的、不是半截 JSON。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flush, resetStore, setDataDir } from '@/server/store';
import type { RoomArchive, SessionArchive } from '@/lib/types';

let dataDir: string;

/** 造一份带明显标记的房间快照（用房间码区分是哪一次写的） */
function roomsWithCode(code: string): RoomArchive[] {
  return [
    {
      state: {
        code,
        status: 'waiting',
        visibility: 'public',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        seats: { w: null, b: null },
        spectators: [],
        chat: [],
        clock: { enabled: false, running: false, wMs: 600000, bMs: 600000, lastTickAt: Date.now() },
      },
      timeControl: 'blitz',
    } as unknown as RoomArchive,
  ];
}

function sessionsWithName(name: string): SessionArchive[] {
  return [{ token: `token-${name}`, userId: `user-${name}`, name, roomCode: undefined, lastActiveAt: Date.now() }];
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lan-chess-store-'));
  setDataDir(dataDir);
  resetStore();
});

afterEach(() => {
  resetStore();
  setDataDir(null);
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('存档写盘', () => {
  it('并发的 flush 不会互相抢临时文件（也不会报 ENOENT）', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args[0]);
    });

    // 20 次并发写同一个文件 —— 固定 tmp 名的话，这里必炸
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => flush(roomsWithCode(`R${i}`), sessionsWithName(`u${i}`))),
    );

    expect(errors).toEqual([]);
    // 没有残留的临时文件
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('并发写完之后，存档是**完整**的一份（不是空的、不是半截 JSON）', async () => {
    await Promise.all([
      flush(roomsWithCode('RACE'), sessionsWithName('alice')),
      flush(roomsWithCode('RACE'), sessionsWithName('alice')),
      flush(roomsWithCode('RACE'), sessionsWithName('alice')),
    ]);

    const rooms = JSON.parse(readFileSync(join(dataDir, 'rooms.json'), 'utf8')) as RoomArchive[];
    const sessions = JSON.parse(
      readFileSync(join(dataDir, 'sessions.json'), 'utf8'),
    ) as SessionArchive[];

    expect(rooms).toHaveLength(1);
    expect(rooms[0].state.code).toBe('RACE');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('alice');
  });

  it('写盘失败要看得见（不能静默吞掉）', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });

    // 把存档目录指到一个**写不进去**的地方（文件当目录用）
    const blocked = join(dataDir, 'blocked');
    await (await import('node:fs/promises')).writeFile(blocked, 'not a dir', 'utf8');
    setDataDir(join(blocked, 'sub'));

    await flush(roomsWithCode('X'), sessionsWithName('y'));

    expect(errors.some((e) => e.includes('保存失败'))).toBe(true);
  });
});
