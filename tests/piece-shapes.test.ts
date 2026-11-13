/**
 * 棋子造型的回归测试 —— 守的是「辨识度」这件事。
 *
 * 背景（2026-11-11 用户实测反馈）：
 *   「3D 的几乎都看不出来到底是什么棋子，棋子的特点都没有显示出来」。
 *   根因是**六种棋子都是同一个回转体剪影**：兵/象/后/王只差几个半径，
 *   远看全是「瓶子」；而唯一能认的特征件（十字、冠齿、城垛）又做得太小。
 *
 * 这里把当时真正的验收标准写成断言：
 *   ① 六种棋子的剪影**两两不同**（在对局视角下投影后比对占用图）；
 *   ② 最高的王**不超取景上限**（超了就会被画布上沿裁掉）；
 *   ③ 特征件（象的裂口、马的眼睛鬃毛）**贴在 +z 面** ——
 *      Board3D 按观看方把棋子转 0/π，+z 面永远正对当前观看方，
 *      贴错面就等于「特征件背着人」；
 *   ④ 3D 的马**复用 2D 那条轮廓**（同一份真源，不会各画各的）。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  pieceGeometry,
  pieceDetailGeometry,
  pieceHeight,
  detailMaterial,
  PIECE_HEIGHT,
  knightFaceNormal,
  KNIGHT_HEAD_TILT,
  KNIGHT_HEAD_PIVOT,
} from '@/components/pieceGeometry';
import { PIECE_STROKE, pieceDetailShapes, buildPieceShapes } from '@/components/PieceGlyph';
import { parseSvgPath } from '@/lib/svg-path';
import { POLAR, project, sharedBounds, silhouette } from './helpers/silhouette';
import type { PieceType } from '@/lib/types';

const TYPES: PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];

/** 棋面高度：棋子底座坐在这个面上 */
const BOARD_TOP = 0.05;
/** 取景模型允许的最高棋子顶（src/lib/frame3d.ts 的 PIECE_TOP） */
const PIECE_TOP = 1.04;
/**
 * 象的**领圈半径**（pieceGeometry 里主教冠下面那一圈）。
 *
 * 用来当基准：主教冠必须比领圈明显鼓出去（胖水滴），
 * 否则就退回成「一根又窄又尖的锥子」—— 用户明确点名过的旧问题。
 */
const BISHOP_COLLAR_R = 0.104;

describe('3D 棋子造型', () => {
  it('六种棋子的剪影两两不同（对局视角下比对占用图）', () => {
    const geos = TYPES.map((t) => pieceGeometry(t));
    const bounds = sharedBounds(geos);
    const maps = new Map<PieceType, string>();
    for (const t of TYPES) maps.set(t, silhouette(pieceGeometry(t), bounds).join(''));

    for (const a of TYPES) {
      for (const b of TYPES) {
        if (a >= b) continue;
        expect(
          maps.get(a),
          `${a} 和 ${b} 的 3D 剪影一模一样 —— 这正是「看不出来是什么棋子」的病根`,
        ).not.toBe(maps.get(b));
      }
    }
  });

  it('最高的王不超取景上限（超了会被画布上沿裁掉）', () => {
    const tallest = Math.max(...TYPES.map((t) => pieceHeight(t)));
    expect(tallest).toBeLessThanOrEqual(PIECE_TOP - BOARD_TOP);
    // 王必须是最高的，且明显高过兵
    expect(pieceHeight('k')).toBeGreaterThan(pieceHeight('p'));
    expect(tallest).toBe(pieceHeight('k'));
  });

  it('棋子都坐在棋面上（底座不悬空也不陷进去）', () => {
    for (const t of TYPES) {
      const box = pieceGeometry(t).boundingBox;
      expect(box, `${t} 没有 boundingBox`).toBeTruthy();
      expect(box!.min.y, `${t} 的底座陷到棋面以下了`).toBeGreaterThan(-0.01);
      expect(box!.min.y, `${t} 的底座悬空了`).toBeLessThan(0.02);
    }
  });

  it('特征件贴在朝外面 —— 转 0/π 后永远正对当前观看方', () => {
    for (const t of ['n', 'b'] as PieceType[]) {
      const detail = pieceDetailGeometry(t);
      expect(detail, `${t} 应该有对比色细节件`).toBeTruthy();
      detail!.computeBoundingBox();
      const box = detail!.boundingBox!;
      if (t === 'b') {
        // 象是回转体：细节件整体贴在 +z 半边
        expect(box.min.z, '象的细节件不在 +z 面，转过去就背着观众了').toBeGreaterThan(0);
      } else {
        // 马的头**后仰了 25°**，侧脸法线变成「朝上 + 朝 +z」。
        // 细节件贴在侧脸上，所以它的中心必须落在法线方向上（而不是 +z 半边）。
        const n = knightFaceNormal();
        const c = new THREE.Vector3();
        detail!.computeBoundingBox();
        box.getCenter(c);
        const along = (c.x - 0) * n.x + (c.y - 0.1418) * n.y + c.z * n.z;
        expect(along, '马的细节件没有贴在仰起后的侧脸上').toBeGreaterThan(0.05);
      }
    }
  });

  it('细节件不会飘在棋子外面（贴在表面上，不是悬空的贴片）', () => {
    for (const t of ['n', 'b'] as PieceType[]) {
      const detail = pieceDetailGeometry(t)!;
      detail.computeBoundingBox();
      const d = detail.boundingBox!;
      const p = pieceGeometry(t).boundingBox!;
      expect(d.min.x).toBeGreaterThan(p.min.x - 0.02);
      expect(d.max.x).toBeLessThan(p.max.x + 0.02);
      expect(d.min.y).toBeGreaterThan(p.min.y - 0.02);
      expect(d.max.y).toBeLessThan(p.max.y + 0.02);
    }
  });

  it('象和马必须有细节件，其余棋子不需要', () => {
    expect(pieceDetailGeometry('b')).toBeTruthy();
    expect(pieceDetailGeometry('n')).toBeTruthy();
    for (const t of ['p', 'r', 'q', 'k'] as PieceType[]) {
      expect(pieceDetailGeometry(t), `${t} 不该有细节件`).toBeNull();
    }
  });

  it('3D 的马复用 2D 那条轮廓（同一份真源，只多了一个后仰角）', () => {
    // 2D 的马从 (64, 78) 起笔 → 世界坐标 (0.1418, 0.1418)
    const S = 0.78 / 77;
    const wantX = (64 - 50) * S;
    const wantY = (92 - 78) * S;
    // 3D 的马头绕脖子根部后仰了 KNIGHT_HEAD_TILT —— 先把整个几何**转回**原位，
    // 再找那个起笔点。这样断言的是「3D 就是 2D 那条轮廓」，
    // 而不是「3D 碰巧有某个点长得像」。
    const geo = pieceGeometry('n').clone();
    geo.translate(0, -KNIGHT_HEAD_PIVOT, 0);
    geo.rotateX(-KNIGHT_HEAD_TILT);
    geo.translate(0, KNIGHT_HEAD_PIVOT, 0);
    const pos = geo.getAttribute('position');
    let hit = false;
    for (let i = 0; i < pos.count; i += 1) {
      if (
        Math.abs(pos.getX(i) - wantX) < 2e-3 &&
        Math.abs(pos.getY(i) - wantY) < 2e-3
      ) {
        hit = true;
        break;
      }
    }
    expect(hit, '3D 马身上找不到 2D 轮廓的起笔点 —— 两个视角的马已经不是同一个造型了').toBe(true);
  });

  it('马的侧脸在���局视角下是「张开」的（不能被俯角压成一张卡片）', () => {
    // 相机俯角 52°，竖直的侧脸被压掉近四成 → 马变成一张横卡片，
    // 靠边的马再叠上透视倾斜就彻底读不出来（用户实测：黑棋马像斧刃）。
    // 头后仰 25° 后，侧脸与视线的「张开度」必须回到 0.8 以上。
    const n = knightFaceNormal();
    // 白方相机在 +z，看向 (0, 0, +0.8181)：视线方向（相机 → 看向点）
    const view = new THREE.Vector3(0, -Math.cos(POLAR), -Math.sin(POLAR)).normalize();
    const openness = Math.abs(view.dot(n));
    expect(openness, `马的侧脸张开度只有 ${openness.toFixed(2)}，会被俯角压扁`).toBeGreaterThan(0.8);
    // 仰角必须朝上（朝相机），不能朝下
    expect(n.y, '马头应该往后仰（法线朝上），不是前倾').toBeGreaterThan(0.3);
    // 黑白对称：法线的 z 分量不受 yaw 影响 → 两种颜色读起来一样
    expect(n.z).toBeGreaterThan(0.8);
  });

  it('细节贴片用双面材质（画布 y 轴翻转过三角绕序，单面会被背面剔除掉）', () => {
    // 2D 画布 y 轴向下 → 映射到 3D 时 Y 取负 → 三角绕序整体翻转，
    // 法线朝 -z。单面材质（FrontSide）会把整块贴片**背面剔除掉**，
    // 马的眼睛和鬃毛直接消失 —— 这种坑只能靠双面材质兜住。
    for (const c of ['w', 'b'] as const) {
      expect(detailMaterial(c).side).toBe(THREE.DoubleSide);
    }
  });

  it('PIECE_HEIGHT 表与实际几何高度一致（表是给取景用的，别写飘）', () => {
    for (const t of TYPES) {
      expect(pieceHeight(t)).toBeGreaterThan(PIECE_HEIGHT[t] - 0.06);
      expect(pieceHeight(t)).toBeLessThanOrEqual(PIECE_HEIGHT[t] + 0.06);
    }
  });

  /**
   * 象的头必须是**胖水滴**，不能是一根尖锥。
   *
   * 用户原话：「2D 的就比如相，和常见的相长得也不一样」。
   * 旧版 3D 的主教冠是一根最宽处半径 0.1、高 0.4 的细锥 ——
   * 在 52° 俯角下远看就是「一根尖锥」，和后、兵分不开。
   *
   * 判据（结构性，不写死魔法数）：
   *   ① 头部的最宽处必须**比它的领圈宽** —— 尖锥不会比领圈宽；
   *   ② 头部必须**明显比兵的头宽** —— 兵的球头是天然的上限参考。
   */
  it('象的主教冠是胖水滴，不是一根尖锥', () => {
    const headRadius = (type: PieceType): number => {
      const pos = pieceGeometry(type).getAttribute('position');
      let max = 0;
      for (let i = 0; i < pos.count; i += 1) {
        if (pos.getY(i) < 0.28) continue; // 只看头部
        max = Math.max(max, Math.hypot(pos.getX(i), pos.getZ(i)));
      }
      return max;
    };

    const bishopHead = headRadius('b');
    const pawnHead = headRadius('p');

    // ① 头部必须明显鼓出领圈 —— 尖锥不会比领圈宽
    //    （余量给到 0.008：判据卡在 0.104 这种临界值上，浮点一抖就假绿）
    expect(bishopHead).toBeGreaterThan(BISHOP_COLLAR_R + 0.008);
    // ② 头明显比兵的头宽
    expect(bishopHead).toBeGreaterThan(pawnHead * 1.25);
  });

  it('2D 的象也是胖水滴（主教冠不能是一根窄锥）', () => {
    // 象的 detail 裂口必须压在主教冠上
    const shapes = buildPieceShapes('b');
    const mitre = shapes.find(
      (s) => s.kind === 'path' && s.tone !== 'detail' && s.d.includes('C60 31'),
    );
    expect(mitre, '没找到象的主教冠路径').toBeTruthy();
    const cmds = parseSvgPath((mitre as { d: string }).d);
    const xs = cmds.map((c) => ('x' in c ? c.x : 0));
    const width = Math.max(...xs) - Math.min(...xs);
    // 主教冠至少占画布 1/4 宽（旧版的窄锥做不到）
    expect(width).toBeGreaterThanOrEqual(24);
  });
});

describe('2D 棋子造型', () => {
  it('六个棋子都有图形', () => {
    for (const t of TYPES) {
      expect(buildPieceShapes(t).length, `${t} 没有图形`).toBeGreaterThan(0);
    }
  });

  it('描边够粗（棋盘 48px 下不能发虚）', () => {
    expect(PIECE_STROKE).toBeGreaterThanOrEqual(2.4);
  });

  it('马和象必须有细节刻线（2D/3D 同一套语言）', () => {
    expect(pieceDetailShapes('n').length).toBeGreaterThanOrEqual(2);
    expect(pieceDetailShapes('b').length).toBeGreaterThanOrEqual(1);
  });

  it('细节刻线用描边色（反着配色，白棋深槽黑棋亮槽）', () => {
    for (const t of TYPES) {
      for (const s of pieceDetailShapes(t)) {
        expect(s.tone).toBe('detail');
      }
    }
  });
});

describe('SVG path 解析器', () => {
  it('能解析 M/L/C/Q/Z（绝对坐标）', () => {
    const cmds = parseSvgPath('M1 2 L3 4 C5 6 7 8 9 10 Q11 12 13 14 Z');
    expect(cmds.map((c) => c.op)).toEqual(['M', 'L', 'C', 'Q', 'Z']);
    expect(cmds[2]).toEqual({ op: 'C', c1x: 5, c1y: 6, c2x: 7, c2y: 8, x: 9, y: 10 });
  });

  it('支持负数与小数', () => {
    const cmds = parseSvgPath('M-1.5 2.25 L3.5 -4');
    expect(cmds[0]).toEqual({ op: 'M', x: -1.5, y: 2.25 });
    expect(cmds[1]).toEqual({ op: 'L', x: 3.5, y: -4 });
  });

  it('2D 棋子的每条路径都能被解析（3D 复用它们的唯一前提）', () => {
    for (const t of TYPES) {
      for (const s of buildPieceShapes(t)) {
        if (s.kind !== 'path') continue;
        const cmds = parseSvgPath(s.d);
        expect(cmds.length, `${t} 的路径解析不出命令`).toBeGreaterThan(0);
        expect(cmds[0].op, `${t} 的路径不是以 M 开头`).toBe('M');
      }
    }
  });
});
