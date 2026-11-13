'use client';

/**
 * 3D 棋子检阅页 —— /pieces3d
 *
 * 用途：**造型验收**，不是给玩家用的界面。
 *   把六种棋子按对局里的**同一套材质、同一套打光、同一个机位**摆成一排，
 *   一眼就能比出「象像不像象、后像不像后、马是不是侧脸」。
 *
 * 为什么要有这个页：
 *   3D 棋子是程序化几何，造型对不对**看截图才知道** ——
 *   在对局页里棋子又小又挤，还被棋盘和阴影干扰，根本比不出来。
 *   这个页把棋子放大、单独摆平，专门用来迭代造型。
 *
 * 用**正交相机**：透视相机会让排在两端的棋子变形（竖轴歪掉），
 * 看造型时这种畸变会误导人；正交投影看到的才是真实剪影。
 * 机位的极角仍与对局页一致（38.05°），所以看到的体积关系也是真的。
 *
 * 顶部可以切**风格**与**材质**（和设置里是同套）——
 *   造型、材质在 3D 里各有一套实现，这一页就是它们的对照台。
 *
 * 与 /pieces（2D 素材页）是一对：2D 看剪影，3D 看体量。
 */
import { useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
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
} from '@/components/pieceGeometry';
import { PIECE_STYLES, PIECE_MATERIALS, piecePalette } from '@/lib/piece-appearance';
import type { PieceMaterial, PieceStyle } from '@/lib/piece-appearance';
import type { PieceType } from '@/lib/types';

const TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];
const NAMES: Record<PieceType, string> = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };

/** 棋子的横向间距（世界单位） */
const GAP = 1.3;

/** 与对局页一致的机位（极角 38.05°，从 +Y 量起） */
const POLAR = (38.0518 * Math.PI) / 180;

/** 轮廓壳的粗细（与对局页一致） */
const OUTLINE_WIDTH: Record<PieceStyle, number> = {
  classic: 0.014,
  cartoon: 0.021,
  doodle: 0.016,
  pixel: 0.008,
};

/** 环境贴图（金属材质必须有，否则渲出来是黑的） */
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
    return null;
  }
}

/** 一排棋子 */
function Row({
  color,
  style,
  materialKind,
}: {
  color: 'w' | 'b';
  style: PieceStyle;
  materialKind: PieceMaterial;
}) {
  const gl = useThree((s) => s.gl);
  const env = useMemo(() => getEnvironment(gl), [gl]);
  const palette = piecePalette(materialKind, color);

  const geometry = useMemo(() => TYPES.map((t) => pieceGeometry(t, style)), [style]);
  const material = useMemo(
    () => pieceMaterial(color, materialKind, style, env),
    [color, materialKind, style, env],
  );
  const outline = useMemo(
    () => outlineMaterial(palette.stroke, OUTLINE_WIDTH[style]),
    [palette.stroke, style],
  );
  // 细节件（象的裂口、马的眼睛与鬃毛）—— 与对局页同一套对比色材质
  const details = useMemo(() => TYPES.map((t) => pieceDetailGeometry(t, style)), [style]);
  const detailMat = useMemo(() => detailMaterial(color, materialKind), [color, materialKind]);

  const pixels = useMemo(
    () => (style === 'pixel' ? TYPES.map((t) => piecePixelGeometries(t)) : []),
    [style],
  );
  const pixelAccent = useMemo(
    () => (style === 'pixel' ? pieceAccentMaterial(color, materialKind, style, env) : null),
    [color, materialKind, style, env],
  );
  const pixelGloss = useMemo(
    () => (style === 'pixel' ? pieceGlossMaterial(color, materialKind, style, env) : null),
    [color, materialKind, style, env],
  );
  const faces = useMemo(
    () => (style === 'cartoon' ? TYPES.map((t) => pieceFaceGeometries(t)) : []),
    [style],
  );

  const offset = (TYPES.length - 1) / 2;

  return (
    <>
      {TYPES.map((type, i) => (
        <group key={type} position={[(i - offset) * GAP, 0, 0]}>
          {/*
           * 轮廓壳（反壳做法）只给连续表面的风格用。
           * 像素几何是「一行一个盒子」，壳会把每一行的顶面都盖成深色 ——
           * 而像素位图自带描边格，壳是多余的（详见 Board3D.tsx 里的同一段注释）。
           */}
          {style !== 'pixel' && <mesh geometry={geometry[i]} material={outline} />}
          {style === 'pixel' ? (
            <>
              {pixels[i]?.body && (
                <mesh geometry={pixels[i]!.body!} material={material} castShadow receiveShadow />
              )}
              {pixels[i]?.accent && pixelAccent && (
                <mesh geometry={pixels[i]!.accent!} material={pixelAccent} castShadow receiveShadow />
              )}
              {pixels[i]?.gloss && pixelGloss && (
                <mesh geometry={pixels[i]!.gloss!} material={pixelGloss} castShadow />
              )}
            </>
          ) : (
            <mesh geometry={geometry[i]} material={material} castShadow receiveShadow />
          )}
          {details[i] && <mesh geometry={details[i]!} material={detailMat} />}
          {faces[i]?.white && (
            <mesh geometry={faces[i]!.white!}>
              <meshStandardMaterial color="#ffffff" roughness={0.34} metalness={0} />
            </mesh>
          )}
          {faces[i]?.pupil && (
            <mesh geometry={faces[i]!.pupil!}>
              <meshStandardMaterial color="#232a3a" roughness={0.4} metalness={0} />
            </mesh>
          )}
        </group>
      ))}
    </>
  );
}

/** 正交相机：极角与对局页一致，视角方向对所有棋子相同（无畸变） */
function CameraRig({ distance, height, zoom }: { distance: number; height: number; zoom: number }) {
  const { camera } = useThree();
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.position.set(0, height + distance * Math.cos(POLAR), distance * Math.sin(POLAR));
    cam.lookAt(0, height * 0.55, 0);
    cam.zoom = zoom;
    cam.updateProjectionMatrix();
  }, [camera, distance, height, zoom]);
  return null;
}

export default function Pieces3DPage() {
  const [style, setStyle] = useState<PieceStyle>('classic');
  const [material, setMaterial] = useState<PieceMaterial>('wood');

  return (
    <div style={{ padding: 24, background: '#cbd4de', minHeight: '100vh', color: '#241f19' }}>
      <h2 style={{ marginBottom: 4 }}>3D 棋子检阅</h2>
      <p style={{ fontSize: 13, marginBottom: 12, color: '#3c4a5a' }}>
        与对局页同一套材质 / 打光 / 极角（正交投影，无畸变）。造型不对就直接改 pieceGeometry.ts。
      </p>

      <div style={{ display: 'flex', gap: 18, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#3c4a5a' }}>风格</span>
          {PIECE_STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => setStyle(s.id)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                border: style === s.id ? '2px solid #2f5ea8' : '1px solid #9aa8b8',
                background: style === s.id ? '#ffffff' : 'transparent',
                cursor: 'pointer',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#3c4a5a' }}>材质</span>
          {PIECE_MATERIALS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMaterial(m.id)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                border: material === m.id ? '2px solid #2f5ea8' : '1px solid #9aa8b8',
                background: material === m.id ? '#ffffff' : 'transparent',
                cursor: 'pointer',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {(['w', 'b'] as const).map((color) => (
        <div key={color} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, marginBottom: 6, color: '#3c4a5a' }}>
            {color === 'w' ? '白方' : '黑方'}
          </div>
          <div
            style={{
              position: 'relative',
              width: '100%',
              maxWidth: 1100,
              height: 300,
              borderRadius: 12,
              overflow: 'hidden',
              background: '#cbd4de',
              boxShadow: '0 10px 30px rgba(20,32,48,0.18)',
            }}
          >
            <Canvas
              orthographic
              shadows
              dpr={[1, 2]}
              gl={{ antialias: true }}
              camera={{ position: [0, 4.6, 3.3], zoom: 100, near: -50, far: 100 }}
            >
              <color attach="background" args={['#cbd4de']} />
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
              <directionalLight position={[0, 5, -9]} intensity={0.62} />
              <mesh position={[0, -0.03, 0]} receiveShadow>
                <boxGeometry args={[9.6, 0.06, 2.4]} />
                <meshStandardMaterial color="#e3cfa6" roughness={0.72} metalness={0.02} />
              </mesh>
              <Row color={color} style={style} materialKind={material} />
              <CameraRig distance={6} height={0.35} zoom={100} />
            </Canvas>
          </div>
          <div
            style={{
              display: 'flex',
              maxWidth: 1100,
              marginTop: 6,
              fontSize: 12,
              color: '#3c4a5a',
            }}
          >
            {TYPES.map((t) => (
              <div key={t} style={{ width: `${100 / TYPES.length}%`, textAlign: 'center' }}>
                {NAMES[t]}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
