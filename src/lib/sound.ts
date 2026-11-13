'use client';

/**
 * 音效 —— **全部用 WebAudio 现场合成**，不引入任何音频文件。
 *
 * 为什么不用现成的 mp3/wav：
 *   - 素材必须自产（项目硬约束），网上找的音效有版权问题；
 *   - 合成出来的「落子声 / 将军声」体积是 **0 字节**，也不占仓库。
 *
 * 合成思路：
 *   - **落子 / 吃子**：一段带通滤波的噪声爆发（木头撞击的瞬态）
 *     + 一个低频正弦（木头腔体的共鸣），指数衰减；
 *   - **将军**：两声方波短鸣（频率上行），像裁判的哨子；
 *   - **胜负**：三音琶音（上行 = 赢，下行 = 输，两音 = 和）。
 *
 * 浏览器要求 AudioContext 必须在**用户手势之后**创建/恢复，
 * 所以 `resumeAudio()` 要在设置里打开音效的那一刻调用。
 */

export type SoundName = 'move' | 'capture' | 'check' | 'win' | 'draw' | 'lose' | 'click';

let ctx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

/** 取（或建）AudioContext；不支持就返回 null（音效直接不响，不能因此报错） */
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** 在用户手势里调用：解锁被浏览器挂起的音频上下文 */
export function resumeAudio(): void {
  const c = getCtx();
  if (c && c.state === 'suspended') void c.resume();
}

/** 一段 0.5 秒的白噪声（各种撞击声的原料） */
function getNoise(c: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const len = Math.floor(c.sampleRate * 0.5);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) {
    // 简单衰减白噪，避免尾部突兀
    data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  }
  noiseBuffer = buf;
  return buf;
}

/** 一次撞击：噪声瞬态 + 低频共鸣 */
function strike(
  c: AudioContext,
  at: number,
  opts: { freq: number; q: number; gain: number; decay: number; body: number },
): void {
  const src = c.createBufferSource();
  src.buffer = getNoise(c);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = opts.freq;
  band.Q.value = opts.q;
  const env = c.createGain();
  env.gain.setValueAtTime(opts.gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + opts.decay);
  src.connect(band).connect(env).connect(c.destination);
  src.start(at);
  src.stop(at + opts.decay + 0.02);

  // 木头腔体的低频共鸣
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(opts.body, at);
  const bodyEnv = c.createGain();
  bodyEnv.gain.setValueAtTime(opts.gain * 0.9, at);
  bodyEnv.gain.exponentialRampToValueAtTime(0.0001, at + opts.decay * 1.6);
  osc.connect(bodyEnv).connect(c.destination);
  osc.start(at);
  osc.stop(at + opts.decay * 1.6 + 0.02);
}

/** 一个单音（用于琶音 / 提示音） */
function tone(
  c: AudioContext,
  at: number,
  freq: number,
  dur: number,
  gain: number,
  type: OscillatorType = 'triangle',
): void {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(env).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/**
 * 播一个音效。
 *
 * @param volume 0..1；0 或负数直接不响
 */
export function playSound(name: SoundName, volume: number): void {
  const v = Math.min(1, Math.max(0, volume));
  if (v <= 0) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();

  const now = c.currentTime + 0.01;
  // 整体音量做一次缩放（strike/tone 内部用的是绝对增益）
  const g = v * 0.35;

  switch (name) {
    case 'move':
      strike(c, now, { freq: 900, q: 1.1, gain: g, decay: 0.09, body: 170 });
      break;
    case 'capture':
      strike(c, now, { freq: 1900, q: 1.6, gain: g * 1.15, decay: 0.13, body: 120 });
      break;
    case 'check':
      tone(c, now, 880, 0.13, g * 0.7, 'square');
      tone(c, now + 0.16, 1174, 0.16, g * 0.7, 'square');
      break;
    case 'win':
      tone(c, now, 523.25, 0.16, g * 0.8);
      tone(c, now + 0.13, 659.25, 0.16, g * 0.8);
      tone(c, now + 0.26, 783.99, 0.34, g * 0.9);
      break;
    case 'draw':
      tone(c, now, 587.33, 0.18, g * 0.8);
      tone(c, now + 0.16, 440, 0.32, g * 0.8);
      break;
    case 'lose':
      tone(c, now, 392, 0.16, g * 0.8);
      tone(c, now + 0.14, 329.63, 0.16, g * 0.8);
      tone(c, now + 0.28, 261.63, 0.36, g * 0.85);
      break;
    case 'click':
      tone(c, now, 660, 0.05, g * 0.4, 'sine');
      break;
    default:
      break;
  }
}
