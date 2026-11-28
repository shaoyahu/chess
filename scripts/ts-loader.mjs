/**
 * node 的 TypeScript 启动加载器（用 `--import` 预加载）。
 *
 * 它本身什么都不干，只把 `ts-resolver.mjs` 注册成 node 的模块解析钩子。
 * 分成两个文件是因为 node 的 `register()` 要一个**独立**的模块文件
 * （钩子里不能直接用注册它的那个模块的变量）。
 *
 * ```bash
 * node --experimental-transform-types \
 *      --import file:///<仓库根>/scripts/ts-loader.mjs \
 *      server-ws.ts
 * ```
 *
 * 为什么要这么做、覆盖哪些导入，见 `ts-resolver.mjs` 的注释。
 */
import { register } from 'node:module';

register('./ts-resolver.mjs', import.meta.url);
