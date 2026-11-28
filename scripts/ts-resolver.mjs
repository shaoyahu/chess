/**
 * node 的模块解析钩子 —— 让 node **直接跑 TypeScript 源码**。
 *
 * ## 为什么需要它
 *
 * 生产上原来用 `tsx` 跑服务端。tsx 每次要拉起**两套**东西：
 * 一个 tsx 的 node 运行时 + 一个常驻的 esbuild 服务。
 * 服务端本身又会 spawn 一个独立的引擎 worker 子进程，**那个子进程也是用 tsx 起的** ——
 * 于是开一局 AI 对局时，服务 cgroup 里是 **7 个进程**、RSS 合计约 460MB，
 * 内存上限根本压不到 256M（实测 256M / 320M 都会被 cgroup OOM killer 打死引擎）。
 *
 * node 22.18+ 自带 TypeScript 类型剥离（`--experimental-transform-types` 连
 * enum、参数属性这些要转换的语法也支持），所以**不需要 esbuild**。
 * 但 node 的 ESM 解析器比 tsx 严：
 *   - 必须带文件扩展名（`./foo` 不行，得是 `./foo.ts`）；
 *   - 不认 tsconfig 里的 `paths` 别名（`@/lib/x`）。
 * 这两件事就是本文件要补的。
 *
 * ## 为什么不用「打包成 JS」那条路
 *
 * 打包（esbuild bundle）也能去掉 tsx，但 `src/server/engine-pool.ts` 的
 * `projectRoot()` 是从 `import.meta.url` 往上数两级的 —— 产物一旦放到 `dist/`，
 * 它算出来的根目录就变成 `/`，引擎 worker 的路径全错，而且是**静默**的错。
 * 直接跑源码没有这个问题：跑的就是仓库里那份文件。
 *
 * ## 覆盖范围
 *
 *   - `@/xxx`        → `<仓库根>/src/xxx`（tsconfig 的 paths 别名）
 *   - `./xxx` / `../xxx`（没扩展名）→ 依次试 `.ts` / `.tsx` / `/index.ts` / `/index.tsx`
 *   - 其余（`ws`、`chess.js`、`node:fs` …）→ 交给 node 自己解析
 *
 * ⚠️ **本文件是纯 JavaScript（.mjs），不是 TypeScript** ——
 *    它由 node 在**类型剥离生效之前**加载，写了类型标注会直接语法错误。
 *
 * 用法（注意 `--import` 在前，脚本路径在后）：
 *
 * ```bash
 * node --experimental-transform-types \
 *      --import file:///<仓库根>/scripts/ts-loader.mjs \
 *      server-ws.ts
 * ```
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根目录 —— 本文件在 `<根>/scripts/ts-resolver.mjs` */
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** 候选后缀：空（本身就是文件）、.ts、.tsx、目录下的 index */
const SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/**
 * 在 `base` 上依次拼候选后缀，返回第一个真实存在的文件。
 * @param {string} base
 * @returns {string | null} 绝对路径；全都不存在返回 null
 */
function firstExistingFile(base) {
  for (const suffix of SUFFIXES) {
    const candidate = base + suffix;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* 权限之类的异常就当它不存在，继续试下一个 */
    }
  }
  return null;
}

/**
 * node 的模块解析钩子。
 *
 * 只做两件事：**补扩展名**、**解 tsconfig 别名**。
 * 其余一律交回 node 默认逻辑 —— 不自己实现解析规则，
 * 免得跟 node 的行为不一致（那才是难查的坑）。
 *
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: unknown) => Promise<{ url: string }>} nextResolve
 * @returns {Promise<{ url: string }>}
 */
export async function resolve(specifier, context, nextResolve) {
  // ① tsconfig 的 paths 别名：@/xxx → <根>/src/xxx
  if (specifier.startsWith('@/')) {
    const hit = firstExistingFile(join(ROOT, 'src', specifier.slice(2)));
    if (hit) return nextResolve(pathToFileURL(hit).href, context);
    throw new Error(
      `解析不了别名导入 "${specifier}"（找的是 ${join(ROOT, 'src', specifier.slice(2))}）`,
    );
  }

  // ② 相对导入且没带扩展名 → 试 .ts / .tsx / /index.ts
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !extname(specifier)) {
    const parentDir = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : ROOT;
    const hit = firstExistingFile(resolvePath(parentDir, specifier));
    if (hit) return nextResolve(pathToFileURL(hit).href, context);
    // 找不到就**继续往下走**：让 node 报它自己的错，
    // 那条错信息比我们自己编的有用。
  }

  return nextResolve(specifier, context);
}
