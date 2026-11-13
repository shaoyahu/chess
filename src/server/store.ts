/**
 * 持久化：把房间状态与会话档案写入 `.data/`。
 *
 * 目的：
 *  1. **服务重启后对局不丢失** —— 局域网内多人一起玩，重启一次不至于全部重来；
 *  2. **重启后玩家还认得回自己** —— 会话档案（token → 身份）一起存，
 *     否则玩家刷新页面带 token 回来会被当成新用户，座位就认不回来了。
 *
 * 写入采用「节流 + 原子替换」，避免半截文件。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RoomArchive, SessionArchive } from '../lib/types';

/**
 * 存档目录。
 *
 * 优先级：`setDataDir()` 注入 > `LAN_CHESS_DATA_DIR` 环境变量 > `<cwd>/.data`。
 *
 * 为什么**运行时求值**而不是模块加载时算死：
 *  - 模块加载时算死的话，`process.cwd()` 之后再改就不生效了
 *    （测试里 `process.chdir()` 到临时目录，存档却仍写进仓库根目录）；
 *  - 写进仓库根目录会**污染真实存档** —— 测试造出来的假房间
 *    混进玩家真正在玩的局，重启后凭空多出几个房间。
 *
 * 环境变量的用处：部署时可以把存档放到别的盘上；
 * 门禁脚本要跑「服务端重启后恢复」，也需要每个实例一个独立目录。
 */
let dataDirOverride: string | null = null;

/**
 * 注入存档目录（传 `null` 恢复默认）。
 *
 * @returns 上一个目录设置（便于还原）
 */
export function setDataDir(dir: string | null): string | null {
  const prev = dataDirOverride;
  dataDirOverride = dir;
  return prev;
}

function dataDir(): string {
  if (dataDirOverride) return dataDirOverride;
  const fromEnv = process.env.LAN_CHESS_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), '.data');
}

function roomsFile(): string {
  return path.join(dataDir(), 'rooms.json');
}

function sessionsFile(): string {
  return path.join(dataDir(), 'sessions.json');
}

let writeTimer: NodeJS.Timeout | null = null;
let pendingRooms: RoomArchive[] | null = null;
let pendingSessions: SessionArchive[] | null = null;

async function ensureDir(): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
}

/** 原子写：先写临时文件，再 rename 覆盖 */
async function writeAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** 保存房间快照（节流：最多每 2 秒写一次盘） */
export function scheduleSave(rooms: RoomArchive[]): void {
  pendingRooms = rooms;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flush();
  }, 2000);
  // 不阻止进程退出
  if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

/** 保存会话档案（与房间共用节流 —— 一次写盘把两份都写掉） */
export function scheduleSaveSessions(sessions: SessionArchive[]): void {
  pendingSessions = sessions;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flush();
  }, 2000);
  if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

/**
 * 立即写盘。
 *
 * 传入**当前**的完整快照 —— 而不是依赖内部缓冲。
 *
 * 为什么：缓冲（`pendingRooms`）只有被 `scheduleSave` 填上之后才有值。
 * 而「立即写盘」最常见的用途是**进程退出前**（那时缓冲可能还没到节流时间），
 * 或者测试里想立刻落盘 —— 两种场景下缓冲都可能还是空的，
 * 于是「立即写盘」什么也没写。
 *
 * 所以这里让调用方**显式给出**要写什么：写什么由调用方说了算，
 * 不会有「以为写了其实没写」的静默失败。
 */
export async function flush(rooms?: RoomArchive[], sessions?: SessionArchive[]): Promise<void> {
  const roomsToWrite = rooms ?? pendingRooms;
  const sessionsToWrite = sessions ?? pendingSessions;
  pendingRooms = null;
  pendingSessions = null;
  try {
    await ensureDir();
    if (roomsToWrite) await writeAtomic(roomsFile(), roomsToWrite);
    if (sessionsToWrite) await writeAtomic(sessionsFile(), sessionsToWrite);
  } catch (err) {
    console.error('[store] 保存失败:', err);
  }
}

/**
 * 清空内部缓冲并取消待写的节流定时器。
 *
 * 用途：切换存档目录前调用 —— 否则上一个目录排队的定时器醒来后，
 * 会把**旧目录**的快照写到**新目录**里去。
 */
export function resetStore(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  pendingRooms = null;
  pendingSessions = null;
}

/**
 * 读取已保存的房间。
 *
 * 返回 `unknown[]` 而不是 `RoomArchive[]` —— 磁盘上的文件**可能是旧格式**
 * （本功能上线前写的存档直接就是房间快照，没有外壳）。
 * 认格式是房间管理器的活（`normalizeArchive`），store 只负责把字节读成 JSON。
 */
export async function loadRooms(): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(roomsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as unknown[];
  } catch {
    return [];
  }
}

/** 读取已保存的会话档案 */
export async function loadSessions(): Promise<SessionArchive[]> {
  try {
    const raw = await fs.readFile(sessionsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SessionArchive[];
  } catch {
    return [];
  }
}

/** 清空持久化文件 */
export async function clearRooms(): Promise<void> {
  try {
    await ensureDir();
    await writeAtomic(roomsFile(), []);
    await writeAtomic(sessionsFile(), []);
  } catch {
    /* ignore */
  }
}
