/**
 * 调试工具：把 3D 棋子几何正交投影成 PNG 剪影图（零依赖）。
 *
 * 用途：**造型迭代**。
 *   3D 造型对不对，看剪影最快 ——
 *   在 3D 场景里，斜视角 + 明暗 + 描边会把形状细节搅乱；
 *   这里把实体的所有三角形投影后填成一张黑白图，得到的正是**真实剪影**。
 *
 * 为什么自己写 PNG：
 *   ① 直接把几十万三角形塞进 SVG 的 path，Chromium 会因为路径段数上限**整条路径不渲染**；
 *   ② 光栅化之后既是剪影，又能顺便输出成一张能直接看的图。
 *
 * 用法：
 *   npx tsx scripts/dump-piece-silhouette.ts [输出目录] [绕 Y 轴角度] [投影方式] [风格]
 *   角度 0 = 正对着 XY 平面看（马头的侧脸就是这个方向）
 *   投影方式：'front'（纯侧影）/ 'game'（对局页相机方向，极角 38°）
 *   风格：classic / cartoon / pixel / doodle
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { pieceGeometry } from '../src/components/pieceGeometry';
import type { PieceType } from '@/lib/types';
import type { PieceStyle } from '@/lib/piece-appearance';

const TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];
const NAMES: Record<PieceType, string> = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };

const OUT = process.argv[2] ?? join(process.cwd(), 'artifacts', 'silhouette');
/** 绕 Y 轴旋转的角度（弧度）—— 用来从不同方向看同一枚棋子 */
const YAW = Number(process.argv[3] ?? 0) * (Math.PI / 180);
/**
 * 投影方式：
 *   'front' —— 正对 XY 平面（看纯侧影）
 *   'game'  —— **对局页相机方向**（极角 38.05°，即玩家实际看到的样子）
 */
const MODE = (process.argv[4] ?? 'front') as 'front' | 'game';
/** 造型风格（像素风格是体素化的，同一份位图挤出来的） */
const STYLE = (process.argv[5] ?? 'classic') as PieceStyle;

/** 对局页相机的极角（与 Board3D.tsx 的 CAMERA_POLAR 一致） */
const GAME_POLAR = (38.0518 * Math.PI) / 180;

/* ------------------------------------------------------------------ */
/* 最小 PNG 编码器                                                     */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGB（每像素 3 字节）→ PNG */
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 光栅化                                                              */
/* ------------------------------------------------------------------ */

interface Tri {
  x: number[];
  y: number[];
}

/** 把几何体沿视线投影成三角形集合（XY 平面，可绕 Y 旋转） */
function project(type: PieceType): { tris: Tri[]; minX: number; maxX: number; minY: number; maxY: number } {
  const geo = pieceGeometry(type, STYLE);
  const pos = geo.getAttribute('position');
  const index = geo.getIndex();
  const cos = Math.cos(YAW);
  const sin = Math.sin(YAW);
  // 'game' 模式：屏幕竖轴 = y·sinθ − z·cosθ（相机极角 θ，绕 Y 旋转后再投影）
  const upY = MODE === 'game' ? Math.sin(GAME_POLAR) : 1;
  const upZ = MODE === 'game' ? -Math.cos(GAME_POLAR) : 0;
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // 绕 Y 轴旋转
    const rx = x * cos + z * sin;
    const rz = -x * sin + z * cos;
    px.push(rx);
    py.push(y * upY + rz * upZ);
  }
  const tris: Tri[] = [];
  const count = index ? index.count : pos.count;
  for (let i = 0; i < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    tris.push({ x: [px[ia], px[ib], px[ic]], y: [py[ia], py[ib], py[ic]] });
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of tris) {
    for (let i = 0; i < 3; i += 1) {
      if (t.x[i] < minX) minX = t.x[i];
      if (t.x[i] > maxX) maxX = t.x[i];
      if (t.y[i] < minY) minY = t.y[i];
      if (t.y[i] > maxY) maxY = t.y[i];
    }
  }
  return { tris, minX, maxX, minY, maxY };
}

/** 填充三角形（重心坐标法） */
function fillTri(mask: Uint8Array, W: number, H: number, t: Tri, toPx: (x: number, y: number) => [number, number]): void {
  const p0 = toPx(t.x[0], t.y[0]);
  const p1 = toPx(t.x[1], t.y[1]);
  const p2 = toPx(t.x[2], t.y[2]);
  const minPX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const maxPX = Math.min(W - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const minPY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const maxPY = Math.min(H - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  const d = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1]);
  if (Math.abs(d) < 1e-12) return;
  for (let py = minPY; py <= maxPY; py += 1) {
    for (let px = minPX; px <= maxPX; px += 1) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const l0 = ((p1[1] - p2[1]) * (cx - p2[0]) + (p2[0] - p1[0]) * (cy - p2[1])) / d;
      const l1 = ((p2[1] - p0[1]) * (cx - p2[0]) + (p0[0] - p2[0]) * (cy - p2[1])) / d;
      const l2 = 1 - l0 - l1;
      if (l0 >= -0.002 && l1 >= -0.002 && l2 >= -0.002) mask[py * W + px] = 1;
    }
  }
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const CELL = 220;
  const CELL_H = 300;
  const W = CELL * 3;
  const H = CELL_H * 2;
  const rgb = Buffer.alloc(W * H * 3, 0xff);

  TYPES.forEach((type, i) => {
    const { tris, minX, maxX, minY, maxY } = project(type);
    const w = maxX - minX;
    const h = maxY - minY;
    const scale = Math.min((CELL - 60) / w, (CELL_H - 70) / h);
    const cx = (i % 3) * CELL + CELL / 2;
    const cy = Math.floor(i / 3) * CELL_H + CELL_H - 45;

    const mask = new Uint8Array(CELL * CELL_H);
    const cellX = (i % 3) * CELL;
    const cellY = Math.floor(i / 3) * CELL_H;
    // toPx 返回**格子内**坐标（mask 是每格一张，不能用画布绝对坐标）
    const toPx = (x: number, y: number): [number, number] => [
      cx - cellX + (x - (minX + maxX) / 2) * scale,
      cy - cellY - (y - minY) * scale,
    ];
    for (const t of tris) fillTri(mask, CELL, CELL_H, t, toPx);

    // 画到 RGB 上
    for (let y = 0; y < CELL_H; y += 1) {
      for (let x = 0; x < CELL; x += 1) {
        if (!mask[y * CELL + x]) continue;
        const px = (i % 3) * CELL + x;
        const py = Math.floor(i / 3) * CELL_H + y;
        const o = (py * W + px) * 3;
        rgb[o] = 0x22;
        rgb[o + 1] = 0x22;
        rgb[o + 2] = 0x22;
      }
    }
    console.log(
      `${NAMES[type]} (${type})  宽=${w.toFixed(3)} 高=${h.toFixed(3)}  三角形=${tris.length}`,
    );
  });

  const file = join(OUT, `silhouette-${STYLE}-${MODE}-yaw${Math.round(YAW)}.png`);
  writeFileSync(file, encodePng(W, H, rgb));
  console.log(`✓ 剪影图 → ${file}`);
}

main();
