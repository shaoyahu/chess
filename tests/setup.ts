/**
 * **测试环境的存档隔离**。
 *
 * 为什么需要它：
 *  服务端的持久化会写 `<cwd>/.data/rooms.json` 和 `sessions.json`。
 *  测试里造出来的 hub 一样会落盘 —— 于是**测试的假房间会混进玩家真正的存档**：
 *  下次真重启服务，凭空多出几个房间，还带着测试用的名字。
 *
 * 所以每个测试文件都把存档目录指到自己的临时目录，
 * 跑完随临时目录一起消失，碰不到真实存档。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setDataDir } from '@/server/store';

const dir = mkdtempSync(path.join(tmpdir(), 'lan-chess-testdata-'));
setDataDir(dir);
