'use client';

/**
 * 程序化木纹贴图 —— 用 canvas 现场生成，不依赖任何外部图片。
 *
 * 为什么不用 AI 生成的贴图：
 *  - 生成器容易把「木纹」理解成**拼花地板**（自带方格），直接贴到棋盘上会出现方块状撕裂；
 *  - 程序化生成可以精确控制：连续纹理、无接缝、方向可控、颜色稳定。
 *
 * 生成原理：多层正弦噪声叠加出年轮般的纹理，再加上轻微的垂直纤维划痕。
 * 同一 seed 永远得到同一张图，保证所有客户端看到一致的棋盘。
 */

/** 简易可重复随机数（mulberry32） */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WoodOptions {
  size?: number;
  /** 基础色 */
  base: [number, number, number];
  /** 纹理深浅对比强度 */
  contrast?: number;
  seed?: number;
}

/** 生成一张木纹贴图，返回 data URL */
export function generateWoodTexture(options: WoodOptions): string {
  const canvas = generateWoodCanvas(options);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * 生成一张木纹贴图的 **canvas**（不转成 data URL）。
 *
 * 3D 的棋子材质需要一张**同步**拿得到的贴图：
 *   TextureLoader.load(dataURL) 是异步的，棋子第一帧会没有贴图（闪一下），
 *   而 CanvasTexture 是同步的 —— 建好就能用。
 */
export function generateWoodCanvas(options: WoodOptions): HTMLCanvasElement {
  const size = options.size ?? 256;
  const contrast = options.contrast ?? 0.16;
  const rand = makeRandom(options.seed ?? 20241110);
  void rand;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const image = ctx.createImageData(size, size);
  const data = image.data;
  const [br, bg, bb] = options.base;

  // 预生成若干条「年轮」参数：频率、相位、强度
  const rings = Array.from({ length: 9 }, () => ({
    freq: 1.5 + rand() * 9,
    phase: rand() * Math.PI * 2,
    amp: 0.35 + rand() * 0.65,
    warpFreq: 0.5 + rand() * 1.5,
    warpAmp: 0.02 + rand() * 0.05,
  }));

  /**
   * 关键：噪声必须是**空间连续**的，不能逐像素随机。
   * 逐像素随机会产生高频白噪声，在缩小显示时形成摩尔纹（横条纹），
   * 在 3D 透视下尤其明显（表现为棋盘「撕裂」）。
   * 这里用多倍频正弦叠加模拟连续的纤维纹理，天然带限、无摩尔纹。
   */
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;

      // 主纹理：沿 x 方向变化的年轮（竖直木纹），多倍频叠加
      let n = 0;
      for (const ring of rings) {
        // 加入 y 方向的缓慢相位扰动，让纹理有自然弯曲
        const warp = Math.sin(v * Math.PI * 2 * ring.warpFreq + ring.phase) * ring.warpAmp;
        n += Math.sin((u * ring.freq + warp + ring.phase) * Math.PI * 2) * ring.amp;
      }
      n /= rings.length;

      // 连续的低频起伏，避免纹理过于规则
      n += Math.sin(v * Math.PI * 2 * 1.3 + 0.7) * 0.1;

      const delta = n * contrast * 255;
      const idx = (y * size + x) * 4;
      data[idx] = Math.max(0, Math.min(255, br + delta));
      data[idx + 1] = Math.max(0, Math.min(255, bg + delta * 0.92));
      data[idx + 2] = Math.max(0, Math.min(255, bb + delta * 0.78));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** 浅格木纹色 */
export const LIGHT_WOOD: [number, number, number] = [226, 202, 158];
/** 深格木纹色 */
export const DARK_WOOD: [number, number, number] = [157, 112, 68];

/** 缓存生成的贴图，避免重复计算 */
const cache = new Map<string, string>();

/** 取木纹贴图（带缓存） */
export function getWoodTexture(
  kind: 'light' | 'dark',
): string {
  const key = kind;
  const cached = cache.get(key);
  if (cached) return cached;
  const url = generateWoodTexture({
    base: kind === 'light' ? LIGHT_WOOD : DARK_WOOD,
    contrast: kind === 'light' ? 0.15 : 0.19,
    seed: kind === 'light' ? 20241110 : 98765432,
  });
  cache.set(key, url);
  return url;
}
