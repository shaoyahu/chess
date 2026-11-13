/**
 * 变异测试 —— 验证 3D 取景这套守卫**真的能抓到 bug**。
 *
 * 两个阶段：
 *   ① 离线（单测）：src/lib/frame3d.ts × tests/frame3d.test.ts
 *   ② 浏览器（真实页面）：src/components/Board3D.tsx × scripts/verify-3d-viewport.ts
 *      ——「旋转时相机不许自动后退」这条规则只在**运行时**成立
 *      （相机在 three.js 的每帧回调里被推动），必须打真实页面才测得到。
 *
 * 规矩：写完守卫必须做变异测试 —— 把生产代码改回 bug，确认用例确实变红。
 * 否则「测试全绿」只是假绿（本项目已经栽过好几次：变异脚本自身有 bug、
 * 断言没执行到、检测逻辑和测试框架的输出格式对不上）。
 *
 * 判定方式：**用进程退出码**，不 grep 测试框架的文本标记 ——
 * vitest 默认 reporter 不输出 TAP 标记，grep 永远匹配不到，脚本会恒判失败。
 *
 * 用法：
 *   npx tsx scripts/mutate-frame3d.ts                 # 全跑（浏览器那条需要服务已启动 + 本机 Chromium）
 *   npx tsx scripts/mutate-frame3d.ts M7              # 只跑名字里含 M7 的那条
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const APP_URL = 'http://127.0.0.1:3000';
const MODEL_FILE = 'src/lib/frame3d.ts';
const TEST_FILE = 'tests/frame3d.test.ts';

interface Edit {
  /** 原文（必须唯一命中） */
  from: string;
  /** 改成的文字 */
  to: string;
}

interface Mutation {
  name: string;
  /** 要改的文件（相对项目根） */
  file?: string;
  /** 单处替换（等价于 edits 只有一项） */
  from?: string;
  to?: string;
  /** 多处替换 —— 还原一个被删掉的功能时经常要同时补回 import 和变量声明 */
  edits?: Edit[];
  /** 验证方式：单测 / 真实页面 */
  kind?: 'unit' | 'browser';
  /** browser 阶段：期望门禁打印出来的关键片段（必须出现在 ❌ 行里） */
  expect?: string;
}

const AUTO_FRAME_RESTORE = `  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    const azimuth = c.getAzimuthalAngle();
    const polar = c.getPolarAngle();
    const signature = \`\${azimuth.toFixed(5)}|\${polar.toFixed(5)}\`;
    if (signature !== lastPose.current) {
      lastPose.current = signature;
      const target = c.target;
      const offset = camera.position.clone().sub(target);
      const dist = offset.length();
      if (dist > 0.001) {
        const safe = safeDistance(polar, azimuth, CAMERA_TARGET_Z * sign, CAMERA_ASPECT);
        if (safe > dist) {
          camera.position.copy(target).addScaledVector(offset.normalize(), safe);
        }
      }
    }
    publishCameraState(camera, c);
  });`;

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 出画判定退回「跨度 + 中心」的错误写法',
    from: `  return (
    e.u0 / aspect >= -margin &&
    e.u1 / aspect <= margin &&
    e.v0 >= -margin &&
    e.v1 <= margin
  );`,
    to: `  const { uMid, vMid, uSpan, vSpan } = extentStats(e);
  return (
    uSpan / aspect <= 2 * margin &&
    vSpan <= 2 * margin &&
    Math.abs(uMid) / aspect <= margin &&
    Math.abs(vMid) <= margin
  );`,
  },
  {
    name: 'M2 投影的横向坐标取反（左右镜像）',
    from: '    const u = cx / depth / HALF_FOV;',
    to: '    const u = -cx / depth / HALF_FOV;',
  },
  {
    name: 'M3 棋子最高点算矮一半（最坏情况建模失效）',
    from: 'export const PIECE_TOP = 1.04;',
    to: 'export const PIECE_TOP = 0.52;',
  },
  {
    name: 'M4 安全距离永远返回下界（参考模型算错）',
    from: `  let r = hi;
  for (let i = 0; i < 60 && r < 40; i += 1) {`,
    to: `  let r = lo;
  for (let i = 0; i < 0 && r < 40; i += 1) {`,
  },
  {
    name: 'M5 画布宽高比解错（横向不再与纵向贴合）',
    from: '  return { r, targetZ, aspect: stats.uSpan / stats.vSpan };',
    to: '  return { r, targetZ, aspect: stats.uSpan };',
  },
  {
    name: 'M6 正交基的 x 轴叉乘方向反了（镜像等价性被破坏）',
    from: '  let ax: Vec3 = { x: az.z, y: 0, z: -az.x };',
    to: '  let ax: Vec3 = { x: -az.z, y: 0, z: az.x };',
  },
  {
    name: 'M7 旋转时把相机推远（自动退镜头又回来了）',
    file: 'src/components/Board3D.tsx',
    kind: 'browser',
    expect: '旋转时相机距离变了',
    edits: [
      {
        from: "import { OrbitControls } from '@react-three/drei';",
        to: "import { OrbitControls } from '@react-three/drei';\nimport { safeDistance } from '@/lib/frame3d';",
      },
      {
        from: '  const { camera } = useThree();',
        to: "  const { camera } = useThree();\n  const lastPose = useRef<string>('');",
      },
      {
        from: `  useFrame(() => {
    publishCameraState(camera, controls.current);
  });`,
        to: AUTO_FRAME_RESTORE,
      },
    ],
  },
];

function runTests(): { code: number; tail: string } {
  try {
    const out = execFileSync('npx', ['vitest', 'run', TEST_FILE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, tail: out.slice(-600) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    return { code: e.status ?? 1, tail: out.slice(-600) };
  }
}

function sh(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 当前**监听** 3000 端口的 PID 列表。
 *
 * 注意 `-sTCP:LISTEN` —— 只算监听方，别把「连着 3000 的客户端」也捞进来
 * （门禁自己的 node 进程、Chromium helper、甚至用户正在用的浏览器）。
 * 这段的用途是 `kill -9`，捞错就会误杀。
 */
function listeners(): string[] {
  const r = spawnSync('bash', ['-c', 'lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | tr \'\\n\' \' \''], {
    encoding: 'utf8',
  });
  return (r.stdout ?? '').trim().split(/\s+/).filter(Boolean);
}

/** 重新构建并重启生产服务（等端口真的空出来再启，否则会打到旧服务上） */
function rebuild(): void {
  console.log('   · 重新构建…');
  const b = sh('npm', ['run', 'build']);
  if (b.code !== 0) {
    console.error(b.out.slice(-2000));
    throw new Error('构建失败');
  }

  /*
   * build 之后**校验产物完整**。
   *
   * 为什么：Next 的 build 会先把 `.next` 清空再写。
   * 如果 build 过程中被打断（超时、被 kill、机器负载高），`.next` 会留下**半成品**，
   * 症状是「服务起不来」（报「没有生产构建」）——
   * 而真正的原因在**几分钟之前**，报错现场却指向「服务」。
   */
  if (!existsSync(join(ROOT, '.next/BUILD_ID'))) {
    console.error('   · 构建产物不完整（.next/BUILD_ID 缺失）—— build 很可能被中断了');
    throw new Error('构建产物不完整');
  }

  for (let i = 0; i < 40; i += 1) {
    const pids = listeners();
    if (pids.length === 0) break;
    sh('bash', ['-c', `for p in ${pids.join(' ')}; do kill -9 "$p" 2>/dev/null; done; true`]);
    spawnSync('sleep', ['0.5']);
  }
  if (listeners().length !== 0) throw new Error('旧服务没停干净');

  spawnSync('bash', ['-c', 'PORT=3000 nohup npm start > /tmp/chess-server.log 2>&1 &'], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  for (let i = 0; i < 60; i += 1) {
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${APP_URL}/`], {
      encoding: 'utf8',
    });
    if ((r.stdout ?? '').trim() === '200' && listeners().length > 0) return;
    spawnSync('sleep', ['0.5']);
  }
  throw new Error('服务重启后没有响应');
}

const FILTER = process.argv[2] ?? '';
const RUN = FILTER ? MUTATIONS.filter((m) => m.name.includes(FILTER)) : MUTATIONS;
if (RUN.length === 0) {
  console.error(`❌ 没有名字里含「${FILTER}」的变异`);
  process.exit(1);
}

const originals = new Map<string, string>();
let allCaught = true;
let needRebuild = false;

console.log(`变异测试：3D 取景守卫（${RUN.length} 条）\n`);

// 先确认基线是绿的
const baseline = runTests();
if (baseline.code !== 0) {
  console.error('❌ 基线测试就不绿，变异测试无从谈起。先修测试。');
  console.error(baseline.tail);
  process.exit(1);
}
console.log('基线：未变异 → 全绿 ✅\n');

for (const m of RUN) {
  const file = m.file ?? MODEL_FILE;
  const path = join(ROOT, file);
  const original = originals.get(file) ?? readFileSync(path, 'utf8');
  originals.set(file, original);

  const edits: Edit[] = m.edits ?? (m.from != null && m.to != null ? [{ from: m.from, to: m.to }] : []);
  if (edits.length === 0) {
    console.error(`❌ ${m.name}：没有替换内容`);
    allCaught = false;
    continue;
  }

  let mutated = original;
  let broken = false;
  for (const e of edits) {
    const hits = original.split(e.from).length - 1;
    if (hits !== 1) {
      console.error(`❌ ${m.name}：目标串在 ${file} 里命中 ${hits} 次（必须恰好 1 次）`);
      broken = true;
      break;
    }
    mutated = mutated.replace(e.from, e.to);
  }
  if (broken) {
    allCaught = false;
    continue;
  }

  console.log(`\n▶ 变异：${m.name}`);
  try {
    writeFileSync(path, mutated, 'utf8');
    if ((m.kind ?? 'unit') === 'browser') {
      needRebuild = true;
      rebuild();
      const r = sh('npx', ['tsx', 'scripts/verify-3d-viewport.ts', APP_URL]);
      const gateRed = r.out.split('\n').some((l) => l.includes('❌') && l.includes(m.expect ?? ''));
      const nonzero = r.code !== 0;
      if (gateRed && nonzero) {
        console.log(`   ✅ 抓到了：${m.expect} 变红，且进程退出码 ${r.code}`);
      } else {
        allCaught = false;
        console.error(`   ❌ 没抓到！gateRed=${gateRed} exitCode=${r.code}`);
        console.error(r.out.slice(-2500));
      }
    } else {
      const r = runTests();
      if (r.code !== 0) {
        console.log(`   ✅ 抓到了：${TEST_FILE} 变红，且进程退出码 ${r.code}`);
      } else {
        allCaught = false;
        console.error(`   ❌ 没抓到！exitCode=${r.code}`);
        console.error(r.tail.slice(-1200));
      }
    }
  } finally {
    writeFileSync(path, original);
  }
}

// 恢复原状后重建一次，保证工作区和服务都是干净的
if (needRebuild) {
  console.log('\n恢复原状并重建…');
  rebuild();
}

console.log('');
console.log(allCaught ? '结果：✅ 全部变异都被抓到，守卫有效' : '结果：❌ 存在漏检，守卫不可信');
process.exitCode = allCaught ? 0 : 1;
