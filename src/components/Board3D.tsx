'use client';

/**
 * 3D 棋盘 —— three.js / @react-three/fiber。
 *
 * 关键点（R4）：
 *  - 相机始终位于**玩家自己这一侧**的后方：白方 z>0，黑方 z<0。
 *    观战者默认白方视角，可手动切换。
 *  - 走子动画是**立体位移**：棋子离开棋面、沿抛物线越过中线、再落回。
 *    2D 端看到的是格子间平移 —— 同一件事，两种表现。
 *  - 场景对象由同一份 FEN 驱动（useTrackedPieces 保证身份稳定）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { useTrackedPieces, type TrackedPiece } from '@/hooks/useTrackedPieces';
import { easeInOutQuad, liftArc, MOVE_SPEED } from '@/lib/motion3d';
import { displayCol, displayRow } from '@/hooks/useBoardInteraction';
import type { BoardInteraction } from '@/hooks/useBoardInteraction';
import { getWoodTexture } from '@/lib/woodTexture';
import { getBoardTheme, type BoardTheme } from '@/lib/board-themes';
import { arrowPolygon, ARROW_3D } from '@/lib/moveArrow';
import { worldToSquare } from '@/lib/dragGeometry';
import { PALETTE } from '@/components/PieceGlyph';
import {
  detailMaterial,
  outlineMaterial,
  pieceAccentMaterial,
  pieceDetailGeometry,
  pieceFaceGeometries,
  pieceGeometry,
  pieceGlossMaterial,
  pieceMaterial,
  piecePixelGeometries,
  squareToWorld,
} from './pieceGeometry';
import { piecePalette, type PieceMaterial, type PieceStyle } from '@/lib/piece-appearance';
import type { Color, PieceType } from '@/lib/types';

export interface Board3DProps {
  fen: string;
  interaction: BoardInteraction;
  /** 观战者手动翻转 */
  flipped?: boolean;
  /**
   * 上一步走子（起点 → 终点）。
   *
   * 由房间页从服务端的走子记录里取，2D / 3D 用的是同一份数据。
   */
  lastMove?: { from: string; to: string } | null;
  /** 棋盘配色主题（设置里选；与 2D 用同一套 theme） */
  theme?: BoardTheme;
  /** 推荐下一步（辅助下棋）—— 蓝色指引箭头 */
  hintMove?: { from: string; to: string } | null;
  /** 棋子风格（造型语言） */
  pieceStyle?: PieceStyle;
  /** 棋子材质（表面表现） */
  pieceMaterial?: PieceMaterial;
}

/**
 * 环境贴图（**金属材质必须有**）。
 *
 * 金属的渲染靠的是**反射**：没有环境贴图，metalness≈0.9 的材质会把漫反射全部吃掉，
 * 渲出来是一团黑 —— 金属棋子会变成「黑掉」。
 *
 * 用 three 自带的 RoomEnvironment（**不联网**、不引外部资源），
 * 烘成 PMREM 后按渲染器缓存，一个浏览器只生成一次。
 */
const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

function getEnvironment(gl: THREE.WebGLRenderer): THREE.Texture | null {
  const cached = envCache.get(gl);
  if (cached) return cached;
  try {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    envCache.set(gl, env);
    return env;
  } catch {
    // 生成失败（比如老显卡）就退化成没有环境贴图：木头 / 塑料照常，金属会暗一点
    return null;
  }
}

/**
 * 3D 棋盘格子的默认颜色 —— **只是兜底值**。
 *
 * 真正的颜色由 `theme`（设置里选的配色）决定：
 *   - 3D 棋面要吃光照（漫反射 + 高光），同一个色值在 3D 上会显得更暗，
 *     所以每套主题额外给一档「3D 色」（light3d / dark3d），
 *     让 2D 和 3D 看起来是同一套配色。
 */
/**
 * 3D 场景背景 —— 亮色冷灰。
 *
 * 之前是近黑（#191512），黑棋落在深色格上直接糊成一团。
 * 改成明亮的冷灰后：黑棋有对比、白棋有对比、暖色木纹棋盘也跳得出来。
 * 用**冷色**而不是米色，是为了让棋盘木纹和背景在色相上明确分开。
 */
const SCENE_BG = '#cbd4de';

/**
 * 轮廓壳的粗细（世界单位）—— 按风格走。
 *
 * 卡通要一圈粗墨线；像素的暗边已经烤在位图里，壳太粗反而糊；
 * 涂鸦的线是马克笔，比经典略粗一点。
 */
const OUTLINE_WIDTH: Record<PieceStyle, number> = {
  classic: 0.014,
  cartoon: 0.021,
  doodle: 0.016,
  pixel: 0.008,
};

/**
 * 棋面上的各个平面层的高度（世界坐标 y）。
 *
 * 底板 box 顶面在 y=0.02，棋格平面必须**高于**它足够多，否则两者共面 → z-fighting → 棋盘「撕裂」。
 * 棋子底面也贴合这个高度，保证棋子「站在」棋面上而不是陷进去。
 *
 * 棋格平面之上的所有叠加层（高亮 / 箭头 / 落点提示）也必须**互不相同的高度**，
 * 否则同样共面 → 撕裂。
 */
const BOARD_TOP = 0.05;
/** 上一手的格子高亮 */
const LASTMOVE_Y = 0.056;
/** 走子箭头 */
const ARROW_Y = 0.06;
/** 选中格高亮 */
const SELECTED_Y = 0.064;
/** 合法落点提示 */
const TARGET_Y = 0.068;

/**
 * 拖拽时棋子**抬起**的高度（世界单位，1 格 = 1）。
 *
 * 「稍微上抬一点」—— 抬得够多能看出是浮在棋面之上，
 * 抬得太高又会挡住落点提示，所以取三分之一格左右。
 */
const DRAG_LIFT = 0.32;

/**
 * 「拖」与「点」的分界：指针移动超过这么多像素才算拖动。
 *
 * 与 2D 用的是**同一个阈值**（4px）—— 两边的规则必须一致，
 * 不许「2D 算拖、3D 算点」。
 */
const DRAG_THRESHOLD = 4;

/**
 * 棋面所在的平面 —— 把鼠标射线投影到它上面，得到「光标落在棋盘的哪一点」。
 *
 * 平面方程 `y = BOARD_TOP`，法线 (0,1,0) ⇒ `normal·p + constant = 0`
 * ⇒ `constant = -BOARD_TOP`。
 */
const BOARD_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_TOP);

/** 射线与棋面相交的落点（复用同一个向量，调用方立刻取用） */
const _planeHit = new THREE.Vector3();

function boardPlaneHit(ray: THREE.Ray): THREE.Vector3 | null {
  return ray.intersectPlane(BOARD_PLANE, _planeHit);
}

/**
 * 3D 拖拽状态（放在 ref 里 —— 每一帧都要读，不能走 React state）。
 */
interface Drag3D {
  /** 原格 */
  from: string;
  /** 抓取点相对棋子中心的偏移 —— 保住「抓哪就是哪」的手感 */
  offsetX: number;
  offsetZ: number;
  /** 棋子当前的世界坐标（xz） */
  posX: number;
  posZ: number;
}

/**
 * 「按下了但还没走够远」的状态 —— 等着看这一下是**点**还是**拖**。
 *
 * 分开存，是因为「点一下棋子要能选中」和「按住棋子要能拖起来」
 * 这两件事在按下那一刻**还分不清**。
 */
interface Pending3D {
  /** 按住的是哪枚棋子 */
  from: string;
  /** 抓取点相对棋子中心的偏移 */
  offsetX: number;
  offsetZ: number;
}

interface DragState {
  /** 正在拖的棋子（null = 没在拖） */
  current: Drag3D | null;
  /** 按下了棋子但还没起拖 */
  pending: Pending3D | null;
  /** 指针按下的屏幕坐标（DOM 层记的） */
  pointerStart: { x: number; y: number } | null;
  /** 刚拖完 → 吞掉随后的那一次 click */
  justDragged: boolean;
}

/**
 * 相机默认机位。
 *
 * 取景目标：**棋盘同时撑满画布的宽和高**，任何子力分布都不会被裁掉，投影居中。
 *
 * 这三个数是**解出来的**，不是手调的：
 *   - `CAMERA_POLAR` 是极角（从 +Y 轴量起），沿用线上版本的角度，
 *     所以 3D 的观感不变，只是把取景重新摆正；
 *   - `CAMERA_DISTANCE` / `CAMERA_TARGET_Z` 让「棋盘 + 全部棋子」在纵向
 *     恰好占满画布高度的 97%，且上下居中；
 *   - `CAMERA_ASPECT` 是内容在该机位下的投影宽高比，
 *     写进 globals.css 的 `--board3d-aspect`，横向也就刚好撑满。
 *
 * 关键约束：**棋盘高度按「每个格子上都可能站最高的王」来算**，
 * 所以任何局面、任何走法都不会把棋子顶出画布（线上版本曾把远端一排棋子裁掉）。
 *
 * 推导与校验跑 `npx tsx scripts/solve-3d-camera.ts`；
 * 改动极角 / 距离 / fov 必须重新求解，并同步 globals.css 的 --board3d-aspect。
 */
const CAMERA_POLAR = (38.0518 * Math.PI) / 180;
/** 相机到看向点的距离（= OrbitControls 的 distance） */
const CAMERA_DISTANCE = 9.3407;
/** 看向点沿 z 指向近端的偏移量（黑方视角取负） */
const CAMERA_TARGET_Z = 0.8181;
/** 内容在该机位下的投影宽高比 —— 必须与 globals.css 的 --board3d-aspect 一致 */
const CAMERA_ASPECT = 1.5579;
/** 相机位置（白方视角；黑方视角整体沿 z 镜像） */
const CAMERA_POS: [number, number, number] = [
  0,
  CAMERA_DISTANCE * Math.cos(CAMERA_POLAR),
  CAMERA_TARGET_Z + CAMERA_DISTANCE * Math.sin(CAMERA_POLAR),
];
/**
 * 把相机真实状态挂到 window 上 —— **诊断接口**，供 `npm run verify:3d` 读取。
 *
 * 取景对不对，看数字比看截图准：位置 / fov / 画布比例 / 看向点 / 距离 / 极角 / 方位角。
 * 只读不改，不会影响渲染。
 */
function publishCameraState(
  camera: THREE.Camera,
  controls: React.ComponentRef<typeof OrbitControls> | null,
): void {
  if (typeof window === 'undefined') return;
  const cam = camera as THREE.PerspectiveCamera;
  const target = controls?.target ?? null;
  (window as unknown as { __chessCam?: unknown }).__chessCam = {
    pos: cam.position.toArray(),
    fov: cam.fov,
    aspect: cam.aspect,
    target: target ? target.toArray() : null,
    distance: target ? camera.position.distanceTo(target) : null,
    polar: controls?.getPolarAngle?.() ?? null,
    azimuth: controls?.getAzimuthalAngle?.() ?? null,
    /**
     * 相机控制器**当前是不是开着**。
     *
     * 这一项是查「拖棋子时相机为什么不动」的**关键读数**：
     * 开着却不动 → 是事件链断了；关着 → 是开关把它关了。
     */
    enabled: controls?.enabled ?? null,
  };
}

/**
 * 3D 拖拽诊断 —— `window.__chessDrag`（**只读，不影响渲染**）。
 *
 * 门禁要验「拖动时棋子真的抬起来了」，而这件事**没法从截图判**
 * （抬起来在画面上是几个像素，取决于机位）。
 * 所以把棋子**实际渲染出来的世界坐标**挂出来 —— 门禁量的是真值，不是估算。
 */
interface DragDiag {
  /** 正在拖吗 */
  active: boolean;
  /** 被拖棋子的原格 */
  from: string;
  /** 被拖棋子的实际世界坐标（就是渲染出来的那一份） */
  x: number;
  y: number;
  z: number;
  /** 棋子**静止**时的高度 —— 拿它和 `y` 相减，就是「抬起了多少」 */
  restY: number;
}

const dragDiag: DragDiag = {
  active: false,
  from: '',
  x: 0,
  y: 0,
  z: 0,
  restY: BOARD_TOP,
};

/**
 * 发布拖拽诊断。
 *
 * 改的是**同一个对象**（不是每次新建）——
 * 每帧新建对象会让 GC 压力白白涨上来，而门禁只需要读最新值。
 */
function publishDragState(patch: Partial<DragDiag>): void {
  if (typeof window === 'undefined') return;
  Object.assign(dragDiag, patch);
  (window as unknown as { __chessDrag?: DragDiag }).__chessDrag = dragDiag;
}

/**
 * 屏幕投影诊断 —— `window.__chessProject(square, y?)` / `window.__chessProjectWorld(x, z)`。
 *
 * 门禁要知道「某个格子在屏幕上的哪个像素」才能模拟一次真实拖动。
 *
 * ## 高度参数为什么不能省
 *
 * 如果按**棋面平面**（y = BOARD_TOP）投影，射线是擦着棋子的**细杆**掠过去的 ——
 * 实测余量不到 0.01 个世界单位，稍微偏一点就打不中棋子。
 * 所以门禁按**棋子本体的高度**（比如 0.27）投影，稳稳打中。
 */
function DragDiagnostics(): null {
  const { camera, gl } = useThree();
  useEffect(() => {
    const projectPoint = (x: number, y: number, z: number): { x: number; y: number } | null => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: rect.left + ((v.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - v.y) / 2) * rect.height,
      };
    };
    /** 某个格子在指定高度处的屏幕投影（高度默认棋面） */
    const project = (square: string, y = BOARD_TOP): { x: number; y: number } | null => {
      const w = squareToWorld(square);
      return projectPoint(w.x, y, w.z);
    };
    /** 棋面上任意一点（世界坐标 xz）的屏幕投影 */
    const projectWorld = (x: number, z: number): { x: number; y: number } | null =>
      projectPoint(x, BOARD_TOP, z);

    (window as unknown as { __chessProject?: typeof project }).__chessProject = project;
    (window as unknown as { __chessProjectWorld?: typeof projectWorld }).__chessProjectWorld =
      projectWorld;
    return () => {
      delete (window as unknown as { __chessProject?: typeof project }).__chessProject;
      delete (window as unknown as { __chessProjectWorld?: typeof projectWorld }).__chessProjectWorld;
    };
  }, [camera, gl]);
  return null;
}

/**
 * 抓取诊断 —— `window.__chessGrab`。
 *
 * 记的是「按下时手抓在棋子上的哪个点」——
 * 也就是抓取点相对棋子中心的偏移。
 * 门禁要靠它换算「松手时指针该在哪，棋子才会落在目标格」。
 */
interface GrabDiag {
  /** 按住的是哪枚棋子 */
  from: string;
  /** 抓取点相对棋子中心的偏移（世界坐标） */
  offsetX: number;
  offsetZ: number;
}

const grabDiag: GrabDiag = { from: '', offsetX: 0, offsetZ: 0 };

function publishGrabState(patch: Partial<GrabDiag>): void {
  if (typeof window === 'undefined') return;
  Object.assign(grabDiag, patch);
  (window as unknown as { __chessGrab?: GrabDiag }).__chessGrab = grabDiag;
}

/** 单个棋子组件：负责自己的移动动画 */
function Piece3D({
  piece,
  selected,
  onSelect,
  orientation,
  drag,
  canDragFrom,
  onGrab,
  style,
  material: materialKind,
  env,
}: {
  piece: TrackedPiece;
  selected: boolean;
  onSelect: (square: string) => void;
  /** 观看方（白方视角 / 黑方视角）—— 决定棋子朝向 */
  orientation: 'w' | 'b';
  /** 拖拽状态（全局共享） */
  drag: React.MutableRefObject<DragState>;
  /** 这一格能不能起拖 */
  canDragFrom: (square: string) => boolean;
  /** 按住了棋子 → 立刻关掉相机旋转 */
  onGrab: () => void;
  /** 棋子风格 */
  style: PieceStyle;
  /** 棋子材质 */
  material: PieceMaterial;
  /** 环境贴图（金属材质用） */
  env: THREE.Texture | null;
}) {
  const world = squareToWorld(piece.square);

  // 三个位置向量一开始就等于棋子真实坐标，避免第一帧出现在世界原点
  const target = useRef(new THREE.Vector3(world.x, 0, world.z));
  const current = useRef(new THREE.Vector3(world.x, 0, world.z));
  const start = useRef(new THREE.Vector3(world.x, 0, world.z));
  const group = useRef<THREE.Group>(null);
  const lift = useRef(0);
  const moving = useRef(false);
  const progress = useRef(1);
  const mounted = useRef(false);

  /**
   * 位置同步。
   *
   * 首次挂载必须**直接就位**：如果也走一遍「从 start 插值到 target」，
   * 而 start 默认是 (0,0,0)，那么开局 32 枚棋子会全部叠在棋盘中心再散开。
   * 所以挂载时把 moving 复位、progress 置 1，只在真正换格时才启动动画。
   */
  useEffect(() => {
    const pos = squareToWorld(piece.square);
    const next = new THREE.Vector3(pos.x, 0, pos.z);

    if (!mounted.current) {
      mounted.current = true;
      current.current.set(pos.x, 0, pos.z);
      target.current.set(pos.x, 0, pos.z);
      start.current.set(pos.x, 0, pos.z);
      progress.current = 1;
      moving.current = false;
      lift.current = 0;
      return;
    }

    if (!current.current.equals(next)) {
      start.current.copy(current.current);
      target.current.copy(next);
      progress.current = 0;
      moving.current = true;
    }
  }, [piece.square]);

  useFrame((_, delta) => {
    if (!group.current) return;
    /*
     * 拖动中：位置**由手指决定**，并整体抬起一点。
     *
     * 这一段在走子动画**之前**判断 —— 拖动时棋子归手指管，
     * 局面的变化（走子）要等松手之后才发生。
     */
    const d = drag.current.current;
    if (d && d.from === piece.square) {
      group.current.position.set(d.posX, BOARD_TOP + DRAG_LIFT, d.posZ);
      // 把**实际渲染出来的坐标**挂出去（门禁量的是真值，不是估算）
      publishDragState({
        active: true,
        from: piece.square,
        x: group.current.position.x,
        y: group.current.position.y,
        z: group.current.position.z,
      });
      return;
    }
    if (moving.current) {
      progress.current = Math.min(1, progress.current + delta * MOVE_SPEED);
      const t = progress.current;
      // 位置做缓动插值
      const eased = easeInOutQuad(t);
      current.current.lerpVectors(start.current, target.current, eased);
      // 抬升：走子中段最高，形成抛物线弧（立体位移的关键，见 src/lib/motion3d.ts）
      lift.current = liftArc(t);
      if (t >= 1) {
        moving.current = false;
        lift.current = 0;
        current.current.copy(target.current);
      }
    }
    group.current.position.set(current.current.x, BOARD_TOP + lift.current, current.current.z);
    // 移动时略微前倾，增加立体感
    group.current.rotation.x = moving.current ? -0.12 : 0;
  });

  const color: Color = piece.color;
  const palette = piecePalette(materialKind, color);
  const geometry = useMemo(() => pieceGeometry(piece.type, style), [piece.type, style]);
  const material = useMemo(
    () => pieceMaterial(color, materialKind, style, env),
    [color, materialKind, style, env],
  );
  /**
   * 轮廓壳：沿法线外扩一圈、只画背面 → 棋子外缘出现描边。
   *
   * 白棋用深色描边、黑棋用浅色描边（与 2D 的调色板完全一致），
   * 这样无论落在浅格还是深格上，都能一眼看出是什么子。
   *
   * 粗细按风格走：卡通要粗墨线、像素要细（位图自带暗边）、涂鸦略粗。
   */
  const outline = useMemo(
    () => outlineMaterial(palette.stroke, OUTLINE_WIDTH[style] ?? 0.014),
    [palette.stroke, style],
  );
  /**
   * 细节件：象的裂口、马的眼睛与鬃毛。
   *
   * 用**对比色**渲染（白棋深色 / 黑棋浅色），和 2D 的 detail 刻线一套语言 ——
   * 这类特征靠「同色凹凸」做的话，在斜视角和小尺寸下会彻底消失。
   */
  const detail = useMemo(() => pieceDetailGeometry(piece.type, style), [piece.type, style]);
  const detailMat = useMemo(() => detailMaterial(color, materialKind), [color, materialKind]);

  /*
   * 像素风格：本体 / 描边 / 高光是**三块独立网格**（颜色不同）。
   * 直接把三种颜色烤进一张网格也行，但那样就没法给描边单独换颜色了。
   */
  const pixel = useMemo(
    () => (style === 'pixel' ? piecePixelGeometries(piece.type) : null),
    [piece.type, style],
  );
  const pixelAccentMat = useMemo(
    () =>
      style === 'pixel' ? pieceAccentMaterial(color, materialKind, style, env) : null,
    [color, materialKind, style, env],
  );
  const pixelGlossMat = useMemo(
    () => (style === 'pixel' ? pieceGlossMaterial(color, materialKind, style, env) : null),
    [color, materialKind, style, env],
  );

  /** 卡通风格的大眼睛（眼白 + 瞳孔分开两件，材质独立于棋子本体） */
  const face = useMemo(
    () => (style === 'cartoon' ? pieceFaceGeometries(piece.type) : null),
    [piece.type, style],
  );

  /**
   * 棋子朝向 —— **整枚棋子按观看方转 0 / π**，没有例外。
   *
   * 局部坐标里「正对自己的那一面」是 **+z**：
   *   · 象的裂口贴在 +z 面上；
   *   · 马的侧脸（以及贴在侧脸上的眼睛、鬃毛）在 +z 面上；
   *   · 白方相机在 +z、黑方相机在 -z。
   * 于是按观看方转 0 / π 之后，**两种颜色的棋子、六个兵种，
   * 特征件永远正对当前观看方**。
   *
   * ── 这里曾经有一个「黑马再多转半圈」的特例 ──
   *   当时的意图是「白马朝左、黑马朝右」，但马头是**单面**的侧影，
   *   多转半圈等于让**其中一色的马把后脑勺对着观众**：
   *   实拍里黑棋的马直接变成一把斧刃（鬃毛从背面支出来挡住了整个马脸）。
   *   现在没有特例 —— 谁在看，马都是侧脸。
   */
  const yaw = orientation === 'w' ? 0 : Math.PI;

  return (
    <group
      ref={group}
      position={[world.x, BOARD_TOP, world.z]}
      rotation={[0, yaw, 0]}
      onClick={(e) => {
        e.stopPropagation();
        /*
         * 拖完之后的这一次 click 由 **window 捕获阶段**统一吞掉
         * （见 Scene 里的那段 effect）——
         * 否则刚放下的棋子会立刻被「选中」，还顺带显示它的合法落点。
         */
        onSelect(piece.square);
      }}
      onPointerDown={(e) => {
        // 按住棋子 = 拖棋子（按住空白处仍然是转视角）
        e.stopPropagation();
        if (!canDragFrom(piece.square)) return;
        const p = boardPlaneHit(e.ray);
        if (!p) return;
        const w = squareToWorld(piece.square);
        /*
         * 这里**只记「按住了哪枚棋子」**，不立刻起拖 ——
         * 这一下到底是「点一下」还是「拖一下」，要等指针走够远才知道。
         * 起拖的判定在 DragPointer 里（DOM 层，和 2D 用同一个阈值）。
         */
        drag.current.pending = {
          from: piece.square,
          offsetX: p.x - w.x,
          offsetZ: p.z - w.z,
        };
        // 抓取诊断：门禁靠它换算松手位置
        publishGrabState({
          from: piece.square,
          offsetX: p.x - w.x,
          offsetZ: p.z - w.z,
        });
        // 立刻关掉相机旋转：否则第一次移动就会把视角甩出去
        onGrab();
      }}
      onPointerOver={() => {
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      {/*
       * 轮廓壳先画（不投影），本体后画（投影）。
       *
       * ⚠️ **像素风格不套壳**：
       *   轮廓壳是「沿法线把整个几何往外推一点」的反壳做法 ——
       *   对车床/挤出这种**连续表面**有效，壳只在剪影边缘露出来。
       *   但像素几何是**一行一个盒子**拼起来的：推出去的不只是剪影边缘，
       *   每一行的**顶面**都会被壳盖住 —— 结果整枚棋子被深色横条盖满，
       *   白棋看起来是「深棕的」（实测截图确认过）。
       *   而像素位图**自带一圈描边格**（accent 层就是描边色），
       *   壳本来就是多余的 —— 所以像素风格直接不画壳。
       */}
      {style !== 'pixel' && <mesh geometry={geometry} material={outline} />}
      {style === 'pixel' ? (
        <>
          {pixel?.body && (
            <mesh geometry={pixel.body} material={material} castShadow receiveShadow />
          )}
          {pixel?.accent && pixelAccentMat && (
            <mesh geometry={pixel.accent} material={pixelAccentMat} castShadow receiveShadow />
          )}
          {pixel?.gloss && pixelGlossMat && (
            <mesh geometry={pixel.gloss} material={pixelGlossMat} castShadow />
          )}
        </>
      ) : (
        <mesh geometry={geometry} material={material} castShadow receiveShadow />
      )}
      {/* 细节件（对比色刻线）：贴在 +z 侧面上，正对当前观看方 */}
      {detail && <mesh geometry={detail} material={detailMat} />}
      {/* 卡通的大眼睛：独立材质（眼睛不能是「木头眼睛」） */}
      {face?.white && (
        <mesh geometry={face.white}>
          <meshStandardMaterial color="#ffffff" roughness={0.34} metalness={0} />
        </mesh>
      )}
      {face?.pupil && (
        <mesh geometry={face.pupil}>
          <meshStandardMaterial color="#232a3a" roughness={0.4} metalness={0} />
        </mesh>
      )}
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.3, 0.38, 32]} />
          <meshBasicMaterial color="#ffd166" transparent opacity={0.9} />
        </mesh>
      )}
    </group>
  );
}

/**
 * 加载木纹贴图 —— 与 2D 用**同一份**程序化木纹，风格完全统一。
 * 不用 AI 生成图：生成器容易产出「拼花地板」自带的方格，贴到棋盘上会撕裂。
 */
function useWoodTextures(enabled: boolean): { light: THREE.Texture | null; dark: THREE.Texture | null } {
  const [textures, setTextures] = useState<{
    light: THREE.Texture | null;
    dark: THREE.Texture | null;
  }>({ light: null, dark: null });

  useEffect(() => {
    // 纯色主题（默认）**根本不加载贴图** —— 少了贴图，格子就是纯色块
    if (!enabled) {
      setTextures({ light: null, dark: null });
      return;
    }
    let alive = true;
    const loader = new THREE.TextureLoader();
    const make = (kind: 'light' | 'dark'): void => {
      loader.load(
        getWoodTexture(kind),
        (tex) => {
          if (!alive) return;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(1, 1);
          setTextures((prev) => ({ ...prev, [kind]: tex }));
        },
        undefined,
        () => {
          // 生成失败时回退到纯色，不影响可用性
        },
      );
    };
    make('light');
    make('dark');
    return () => {
      alive = false;
    };
  }, [enabled]);

  return textures;
}

/**
 * 上一步的走子箭头 —— 贴着棋面的一枚扁平箭头。
 *
 * 和 2D 用的是**同一套几何**（src/lib/moveArrow.ts），只是渲染方式不同：
 * 2D 是 SVG 多边形，3D 是 ShapeGeometry。
 *
 * 它**垫在棋子下面**（ARROW_Y 只比棋面高 0.01）：
 * 箭头尖会落在终点格的棋子底座里，被棋子挡住 —— 这是刻意的，
 * 换来的是「不遮挡棋子」。所以 3D 同时给上一手的两个格子加了高亮，
 * 保证「走到了哪」这件事仍然一眼可见。
 *
 * 但纯平面的箭头在 3D 斜视角下几乎读不出来（截图实测：只剩一小截黄杆）：
 *   - 棋子底座半径 0.19~0.22 格，箭头**整个头**被吞掉；
 *   - 斜视角下平贴棋面的薄片被透视压扁；
 *   - 更要命的是塔身把它身后约 0.45~0.7 格的棋面整个挡住
 *     （遮挡长度 ≈ 棋子高 / tan(52°)），而终点棋子就站在箭尖那里。
 * 所以 3D 这边做了三件事：
 *   1. **加宽加长**（3D 专用尺寸，比 2D 粗一截）；
 *   2. **尖端回退** 0.3 格，让箭头头骑在棋子底座外缘而不是正下方；
 *   3. **挤出厚度**（ExtrudeGeometry），箭头有侧面和顶面，斜视角下有体积感。
 *
 * 另外 3D 给上一手的**两个格子**都加了琥珀高亮（起点 + 终点），
 * 「走到了哪」由高亮承担，箭头负责「从哪来、朝哪去」。
 */
function MoveArrow3D({
  from,
  to,
  color = '#f0af28',
  emissive = '#7a5106',
}: {
  from: string;
  to: string;
  color?: string;
  emissive?: string;
}) {
  const geometry = useMemo(() => {
    const a = squareToWorld(from);
    const b = squareToWorld(to);
    const poly = arrowPolygon({ x: a.x, y: a.z }, { x: b.x, y: b.z }, ARROW_3D);
    if (!poly.length) return null;
    const shape = new THREE.Shape();
    // Shape 建在 XY 平面；绕 X 轴转 -90° 后，shape 的 +Y 对应世界的 -Z，
    // 所以这里把世界 z 取反塞进 shape.y，转完就正回来了。
    poly.forEach(([x, z], i) => {
      if (i === 0) shape.moveTo(x, -z);
      else shape.lineTo(x, -z);
    });
    shape.closePath();
    // 挤出一点厚度：箭头有顶面和侧面，斜视角下不是「一张纸」
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [from, to]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) return null;
  return (
    <mesh geometry={geometry} position={[0, ARROW_Y, 0]} renderOrder={2}>
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={0.45}
        roughness={0.5}
        metalness={0.02}
        transparent
        opacity={0.95}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}

/** 棋盘（含格子和落点提示） */
function BoardSurface({
  interaction,
  orientation,
  lastMove,
  theme,
}: {
  interaction: BoardInteraction;
  orientation: 'w' | 'b';
  lastMove: { from: string; to: string } | null;
  theme: BoardTheme;
}) {
  const { selected, targetMap, onSquareClick, dragFrom, dragTargetMap } = interaction;
  const wood = useWoodTextures(theme.wood);
  /*
   * 拖动时的落点提示走**拖动的那枚棋子**的合法着，
   * 点选时的提示走 `selected` 的合法着 —— 两者不能同时显示。
   */
  const shownTargets = dragFrom ? dragTargetMap : targetMap;

  const squares = useMemo(() => {
    const list: Array<{ square: string; x: number; z: number; light: boolean }> = [];
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const fileIndex = orientation === 'w' ? col : 7 - col;
        const rankNumber = orientation === 'w' ? 8 - row : row + 1;
        const square = `${String.fromCharCode(97 + fileIndex)}${rankNumber}`;
        const world = squareToWorld(square);
        list.push({ square, x: world.x, z: world.z, light: (col + row) % 2 === 0 });
      }
    }
    return list;
  }, [orientation]);

  return (
    <group>
      {squares.map((cell) => {
        const target = shownTargets.get(cell.square);
        // 原格在拖动时也高亮 —— 让人知道「是从这儿拿起来的」
        const isSelected = selected === cell.square || dragFrom === cell.square;
        return (
          <group key={cell.square}>
            <mesh
              position={[cell.x, BOARD_TOP, cell.z]}
              rotation={[-Math.PI / 2, 0, 0]}
              receiveShadow
              onClick={(e) => {
                e.stopPropagation();
                onSquareClick(cell.square);
              }}
            >
              <planeGeometry args={[1, 1]} />
              <meshStandardMaterial
                color={cell.light ? theme.light3d : theme.dark3d}
                map={cell.light ? wood.light ?? undefined : wood.dark ?? undefined}
                roughness={0.72}
                metalness={0.02}
              />
            </mesh>
            {/* 上一手的两个格子（起点 + 终点） */}
            {lastMove &&
              (lastMove.from === cell.square || lastMove.to === cell.square) && (
                <mesh position={[cell.x, LASTMOVE_Y, cell.z]} rotation={[-Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[0.96, 0.96]} />
                  <meshBasicMaterial color="#f0af28" transparent opacity={0.3} />
                </mesh>
              )}
            {/* 选中高亮 */}
            {isSelected && (
              <mesh position={[cell.x, SELECTED_Y, cell.z]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.96, 0.96]} />
                <meshBasicMaterial color="#ffd166" transparent opacity={0.4} />
              </mesh>
            )}
            {/* 合法落点 */}
            {target && !target.capture && (
              <mesh position={[cell.x, TARGET_Y, cell.z]} rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[0.14, 24]} />
                <meshBasicMaterial color="#2a2118" transparent opacity={0.42} />
              </mesh>
            )}
            {target?.capture && (
              <mesh position={[cell.x, TARGET_Y, cell.z]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[0.36, 0.45, 32]} />
                <meshBasicMaterial color="#c4342c" transparent opacity={0.75} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

/** 相机：始终位于玩家自己这一侧 */
function PlayerCamera({ orientation, dragging }: { orientation: 'w' | 'b'; dragging: boolean }) {
  const { camera, gl } = useThree();
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const sign = orientation === 'w' ? 1 : -1;

  useEffect(() => {
    camera.position.set(CAMERA_POS[0], CAMERA_POS[1], CAMERA_POS[2] * sign);
    // 看向点要往**近端**偏一点，棋盘投影才会在画布里上下居中（见 CAMERA_TARGET_Z 注释）
    camera.lookAt(0, 0, CAMERA_TARGET_Z * sign);
    camera.updateProjectionMatrix();
    publishCameraState(camera, controls.current);
  }, [camera, orientation, sign]);

  /**
   * 相机状态每帧发布一次（`npm run verify:3d` 的诊断接口靠它读机位）。
   *
   * **这里刻意不做「自动退镜头」**。
   *
   * 旧实现：检测到用户转了视角，就按投影模型算出「此刻棋盘仍能完整落在画布内」
   * 的距离，把相机推远 —— 于是棋盘会自己缩小，把用户刚用滚轮放大的视角又缩回去。
   * 用户明确要求「**棋盘转过来就转过来，不要自动进行缩放**」，
   * 所以现在相机距离**只由用户的滚轮缩放决定**，转多少度都不动。
   *
   * 代价（几何上回避不掉）：棋盘是平铺在地面上的**正方形**，
   * 转到接近对角线方向时它在画面里会变得更高，而画布高度是固定的 ——
   * 于是上下边缘会有一部分走出画布。
   * 要完整可见就只能把相机推远（= 被否掉的那个设计）或把画布加高（布局不允许）。
   * 这笔账模型算得出来：`frame3d.ts` 的 `safeDistance` 是**参考模型**
   * （「此刻要退到多远才不裁」），运行时不再调用它。
   */
  useFrame(() => {
    publishCameraState(camera, controls.current);
  });

  return (
    <OrbitControls
      ref={controls}
      /*
       * **显式指定**接在哪个元素上。
       *
       * 不写的话，drei 会用 `events.connected || gl.domElement` ——
       * 而 `events.connected` 是 R3F **异步**写上去的（挂载之后才有值），
       * 于是这个 prop 会在某个时刻从「画布」变成「外层 div」。
       *
       * 一变，drei 那个 effect 就会重跑：`dispose()` 会把
       * **document 上的 pointermove 监听摘掉**，而这一下正好发生在
       * 「按下棋子」引起的重渲染里 —— 于是这次手势被中途拆掉，
       * 相机就不会跟着转了。
       *
       * 也就是说：**「按住棋子不转视角」曾经是靠这个副作用偶然成立的**。
       * 钉死 domElement 之后，这条规矩就只剩下面那个 `enabled` 开关撑着 ——
       * 显式、可查、也经得起变异测试。
       */
      domElement={gl.domElement}
      // 旋转中心必须与相机的看向点一致，否则第一次拖拽会把视角甩掉
      target={[0, 0, CAMERA_TARGET_Z * sign]}
      /*
       * 拖棋子的时候**不许转视角**。
       *
       * 按住棋子 = 拖棋子，按住空白处 = 转视角（用户拍板）。
       *
       * 这个开关**必须在 pointerdown 之前就关掉** ——
       * OrbitControls 在 `enabled === false` 时压根不接管手势，
       * 所以「关掉」等于「这次按下就不是转视角」，而不是「转了一半再停」。
       */
      enabled={!dragging}
      enablePan={false}
      minDistance={7.5}
      maxDistance={22}
      minPolarAngle={Math.PI * 0.16}
      maxPolarAngle={Math.PI * 0.36}
      // 限制方位角：不能转到对面视角（保持「自己这一侧」的观感）
      // 方位角以 +Z 轴为 0：白方相机在 z>0 → 约 0；黑方相机在 z<0 → 约 π。
      // 所以黑方的允许区间必须**以 π 为中心**，否则 OrbitControls 会把相机
      // 从 π 强行夹回 [0, 0.62π]，棋盘看起来就是斜的。
      minAzimuthAngle={orientation === 'w' ? -Math.PI * 0.38 : Math.PI * 0.62}
      maxAzimuthAngle={orientation === 'w' ? Math.PI * 0.38 : Math.PI * 1.38}
      enableDamping
      dampingFactor={0.08}
    />
  );
}

/**
 * 拖拽的指针层 —— 挂在 Canvas 里面，负责「手指动了 → 棋子跟着动」。
 *
 * 为什么用 **DOM 事件**而不是 R3F 的 `onPointerMove`：
 *   R3F 的指针事件只在**命中某个物体**时才派发。
 *   棋子被拖起来之后，光标常常已经不在任何物体上（悬在棋盘外、或者在另一枚棋子上），
 *   那时 R3F 就不再派发 move 了 —— 棋子会「卡住」不跟手。
 *   DOM 事件挂在画布上，永远都在。
 */
function DragPointer({
  drag,
  onDragStart,
  onDrop,
  onRelease,
}: {
  drag: React.MutableRefObject<DragState>;
  /** 走够距离、正式起拖 */
  onDragStart: (square: string) => void;
  /** 松手：把落点格交给上层（上层决定走不走） */
  onDrop: (square: string | null) => void;
  /** 松手（不管有没有起拖） */
  onRelease: () => void;
}) {
  const { camera, raycaster, gl } = useThree();
  const pointer = useMemo(() => new THREE.Vector2(), []);

  /** 屏幕坐标 → 棋面上的点 */
  const toPlane = useCallback(
    (clientX: number, clientY: number): THREE.Vector3 | null => {
      const el = gl.domElement;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      pointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return boardPlaneHit(raycaster.ray);
    },
    [gl, camera, raycaster, pointer],
  );

  useEffect(() => {
    /*
     * 指针按下的屏幕坐标 —— DOM 层记的。
     *
     * 为什么不在 R3F 的 onPointerDown 里记：
     *   R3F 事件对象上的 clientX 能不能拿到跟版本有关；
     *   DOM 事件一定拿得到，而且**不依赖事件派发顺序**。
     */
    const onDown = (e: PointerEvent): void => {
      drag.current.pointerStart = { x: e.clientX, y: e.clientY };
    };

    const onMove = (e: PointerEvent): void => {
      const d = drag.current.current;
      if (d) {
        const p = toPlane(e.clientX, e.clientY);
        if (!p) return;
        // 棋子位置 = 光标落点 - 抓取偏移（偏移保持不变，手感才「跟手」）
        d.posX = p.x - d.offsetX;
        d.posZ = p.z - d.offsetZ;
        return;
      }

      /*
       * 还没起拖：看指针有没有走够远。
       *
       * 规则和 2D 一致：**动了才算拖，没动就是点** ——
       * 点一下棋子要能正常「选中」，不能被拖拽流程吃掉。
       */
      const pending = drag.current.pending;
      const start = drag.current.pointerStart;
      if (!pending || !start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      // 走够远了 → 此刻才真的起拖（棋子这时才抬起来）
      const w = squareToWorld(pending.from);
      drag.current.current = {
        from: pending.from,
        offsetX: pending.offsetX,
        offsetZ: pending.offsetZ,
        posX: w.x,
        posZ: w.z,
      };
      drag.current.pending = null;
      drag.current.pointerStart = null;
      onDragStart(pending.from);
    };

    /**
     * 结束一次拖动。
     *
     * @param commit true = 正常松手（按落点走子）；false = 手势被取消（**不走子**）。
     *
     * 为什么要有 commit 这个开关：
     *   `pointercancel` 是浏览器**取消**了这次手势，
     *   这时候松手的位置**不代表**玩家的意图 —— 照着它走子就是乱走。
     */
    const onUp = (commit: boolean): void => {
      const d = drag.current.current;
      drag.current.pending = null;
      drag.current.pointerStart = null;
      onRelease();
      // 没起拖 → 什么都不用做，剩下的交给 click（点选流程原样保留）
      if (!d) return;
      drag.current.current = null;
      // 拖过就算「拖了」：随后那一次 click 必须吞掉
      drag.current.justDragged = true;
      document.body.style.cursor = 'auto';
      publishDragState({ active: false });
      /*
       * 落点 = **棋子**所在的格（`d.posX/posZ` 已经扣掉了抓取偏移）。
       *
       * 不用光标所在的格：抓着棋子边角拖时两者差着半格，
       * 按光标判会「棋子看着在 A 格、却下到 B 格」。
       * 规则统一成：**看到棋子在哪，就下到哪**（2D 同一条）。
       */
      onDrop(commit ? worldToSquare(d.posX, d.posZ) : null);
    };

    const onPointerUp = (): void => onUp(true);
    const onPointerCancel = (): void => onUp(false);

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [toPlane, drag, onDrop, onDragStart, onRelease]);

  return null;
}

/** 场景内容 */
function Scene({
  fen,
  interaction,
  orientation,
  lastMove,
  theme,
  hintMove,
  pieceStyle = 'classic',
  pieceMaterial = 'wood',
}: {
  fen: string;
  interaction: BoardInteraction;
  orientation: 'w' | 'b';
  lastMove: { from: string; to: string } | null;
  theme: BoardTheme;
  hintMove: { from: string; to: string } | null;
  pieceStyle?: PieceStyle;
  pieceMaterial?: PieceMaterial;
}) {
  const pieces = useTrackedPieces(fen);
  const { selected, onSquareClick, canDragFrom, endDrag } = interaction;
  /*
   * 环境贴图：**金属材质没有它就是一团黑**（金属靠反射成像）。
   * 用 three 自带的 RoomEnvironment，不联网、不引外部资源。
   */
  const gl = useThree((s) => s.gl);
  const env = useMemo(() => getEnvironment(gl), [gl]);
  /** 拖拽状态（ref —— 每帧都要读，不能走 state） */
  const drag = useRef<DragState>({
    current: null,
    pending: null,
    pointerStart: null,
    justDragged: false,
  });
  /** interaction 的最新引用（DOM 事件回调里要用） */
  const interactionRef = useRef(interaction);
  useEffect(() => {
    interactionRef.current = interaction;
  }, [interaction]);
  /**
   * 「按住了棋子」—— 从按下到松手这段时间。
   *
   * 用它（而不是 `dragFrom`）去关相机旋转，原因有二：
   *   1. `dragFrom` 要等指针走够远才置位 —— 那之前第一次移动就会把视角甩出去；
   *   2. 按住棋子的那一刻就该知道「这一下不是转视角」。
   */
  const [grabbing, setGrabbing] = useState(false);

  /*
   * 吞掉「拖完之后那一下 click」—— 与 2D **同一套做法**。
   *
   * 浏览器在 pointerup 之后还会派发一次 click（按下与松开在同一个元素上时）。
   * 那一下 click 会落到落点格子上 → 走「点选」流程 → 刚放下的棋子又被选中。
   *
   * 在 **window 捕获阶段**拦一次：拦住就不会走到画布，
   * 而且这一次拦完就复位，下一次正常点击不受影响。
   */
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (!drag.current.justDragged) return;
      drag.current.justDragged = false;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  return (
    <>
      <color attach="background" args={[SCENE_BG]} />
      {/*
        亮色场景的打光。
        之前只有一盏主光 + 0.55 的环境光，背光面直接掉到纯黑，
        近端那一排黑棋只剩剪影。现在：
          · 环境光抬高（整体不闷）
          · 半球光给下半球一点暖色反弹（模拟棋盘反射，暗面不死黑）
          · 补光加强（侧后方向，勾出棋子轮廓）
      */}
      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#e8eff8', '#9c7c54', 0.62]} />
      <directionalLight
        position={[4, 8, 5]}
        intensity={1.65}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={30}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
      />
      <directionalLight position={[-5, 4, -4]} intensity={0.5} />
      {/*
        轮廓补光：从棋盘**远端外侧**打过来，在棋子背光面留一道亮边。
        没有它，棋子（尤其是黑棋）会直接和深色格糊在一起 ——
        亮边是「这个轮廓是个什么形状」的最后一道保险。
      */}
      <directionalLight position={[0, 5, -9]} intensity={0.62} />

      {/* 棋盘底板 */}
      <mesh position={[0, -0.05, 0]} receiveShadow>
        <boxGeometry args={[8.4, 0.14, 8.4]} />
        <meshStandardMaterial color={theme.frame} roughness={0.7} />
      </mesh>

      <BoardSurface interaction={interaction} orientation={orientation} lastMove={lastMove} theme={theme} />

      {/* 上一步的走子箭头（垫在棋子下面） */}
      {lastMove && <MoveArrow3D from={lastMove.from} to={lastMove.to} />}

      {/* 推荐下一步的指引箭头（蓝色，辅助下棋）—— 与走子箭头同一套几何 */}
      {hintMove && (
        <MoveArrow3D from={hintMove.from} to={hintMove.to} color="#2f7fe0" emissive="#123a6b" />
      )}

      {pieces.map((piece) => (
        <Piece3D
          key={piece.id}
          piece={piece}
          selected={selected === piece.square}
          onSelect={onSquareClick}
          orientation={orientation}
          drag={drag}
          canDragFrom={canDragFrom}
          onGrab={() => setGrabbing(true)}
          style={pieceStyle}
          material={pieceMaterial}
          env={env}
        />
      ))}

      {/* 拖拽的指针层（跟着手指走 / 松手落点） */}
      <DragPointer
        drag={drag}
        onDragStart={(square) => {
          interactionRef.current.beginDrag(square);
        }}
        onDrop={(square) => {
          interactionRef.current.endDrag(square);
        }}
        onRelease={() => setGrabbing(false)}
      />

      {/* 诊断接口（只读）：拖拽状态 + 格子→屏幕投影 */}
      <DragDiagnostics />

      {/*
        不用 ContactShadows：它是独立的正交深度渲染 pass，
        与棋盘格子的深度写入会产生 z-fighting，在部分显卡上表现为棋盘「撕裂」。
        方向光的实时阴影已经足够表达立体感。
      */}

      <PlayerCamera orientation={orientation} dragging={grabbing} />
    </>
  );
}

export function Board3D({
  fen,
  interaction,
  flipped,
  lastMove = null,
  theme,
  hintMove = null,
  pieceStyle = 'classic',
  pieceMaterial = 'wood',
}: Board3DProps) {
  const orientation: 'w' | 'b' =
    flipped !== undefined ? (flipped ? 'b' : 'w') : interaction.orientation;
  const activeTheme = useMemo(() => theme ?? getBoardTheme(undefined), [theme]);

  return (
    <div className="board3d-wrap">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true }}
        camera={{ position: CAMERA_POS, fov: 42, near: 0.1, far: 100 }}
      >
        <Scene
          fen={fen}
          interaction={interaction}
          orientation={orientation}
          lastMove={lastMove}
          theme={activeTheme}
          hintMove={hintMove}
          pieceStyle={pieceStyle}
          pieceMaterial={pieceMaterial}
        />
      </Canvas>
    </div>
  );
}
