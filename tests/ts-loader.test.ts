/**
 * node 的 TypeScript 解析加载器（`scripts/ts-resolver.mjs`）的规则。
 *
 * 为什么要有这个加载器：生产上不再用 tsx 跑服务端（tsx 每次拉起一整套
 * node 运行时 + esbuild 服务，开一局 AI 对局时 cgroup 里就是 7 个进程，
 * 内存上限压不到 256M）。改用 node 自带的类型剥离后，node 的 ESM 解析器
 * 缺两样东西：**补文件扩展名**和**解 tsconfig 的 `@/` 别名**。
 *
 * 这个测试把这两条规则钉死 —— 它们错了，症状是「服务起不来」，
 * 但报错信息会长得像 node 自己的 bug，很难一眼看出是加载器的锅。
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());

/** 加载 .mjs 解析器（它是纯 JS，没有类型声明，所以只能动态 import） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolverModule = (await import('../scripts/ts-resolver.mjs')) as any;
const resolve = resolverModule.resolve as (
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (s: string, c: unknown) => Promise<{ url: string }>,
) => Promise<{ url: string }>;

/** 假的下一步解析：原样返回，够用来观察「我们有没有改写 specifier」 */
const passthrough = async (specifier: string): Promise<{ url: string }> => ({ url: specifier });

describe('ts-resolver · tsconfig 的 @/ 别名', () => {
  it('@/xxx 解析到 <仓库根>/src/xxx.ts', async () => {
    const r = await resolve('@/lib/types', {}, passthrough);
    expect(fileURLToPath(r.url)).toBe(path.join(ROOT, 'src', 'lib', 'types.ts'));
  });

  it('别名指向的目录会落到 index.ts', async () => {
    const r = await resolve('@/lib/practice/puzzles', {}, passthrough);
    expect(fileURLToPath(r.url)).toBe(
      path.join(ROOT, 'src', 'lib', 'practice', 'puzzles', 'index.ts'),
    );
  });

  it('别名指向不存在的文件 → 明确报错，不静默走偏', async () => {
    await expect(resolve('@/lib/根本没有这个', {}, passthrough)).rejects.toThrow(
      /解析不了别名导入/,
    );
  });
});

describe('ts-resolver · 相对导入补扩展名', () => {
  const parent = pathToFileURL(path.join(ROOT, 'src', 'lib', 'types.ts')).href;

  it('./xxx 补上 .ts', async () => {
    const r = await resolve('./types', { parentURL: parent }, passthrough);
    expect(fileURLToPath(r.url)).toBe(path.join(ROOT, 'src', 'lib', 'types.ts'));
  });

  it('../xxx 补上 .ts', async () => {
    const r = await resolve('../lib/types', { parentURL: parent }, passthrough);
    expect(fileURLToPath(r.url)).toBe(path.join(ROOT, 'src', 'lib', 'types.ts'));
  });

  it('目录形式补上 /index.ts', async () => {
    const r = await resolve('./practice/puzzles', { parentURL: parent }, passthrough);
    expect(fileURLToPath(r.url)).toBe(
      path.join(ROOT, 'src', 'lib', 'practice', 'puzzles', 'index.ts'),
    );
  });
});

describe('ts-resolver · 不该乱动的东西', () => {
  it('带扩展名的相对导入原样交回 node', async () => {
    const r = await resolve('./types.ts', { parentURL: undefined }, passthrough);
    expect(r.url).toBe('./types.ts');
  });

  it('第三方包原样交回 node', async () => {
    const r = await resolve('ws', { parentURL: undefined }, passthrough);
    expect(r.url).toBe('ws');
  });

  it('node 内置模块原样交回 node', async () => {
    const r = await resolve('node:fs', { parentURL: undefined }, passthrough);
    expect(r.url).toBe('node:fs');
  });

  it('相对导入找不到文件时交回 node（让它报自己的错，不自己编）', async () => {
    const parent = pathToFileURL(path.join(ROOT, 'src', 'lib', 'types.ts')).href;
    const r = await resolve('./根本没有这个', { parentURL: parent }, passthrough);
    expect(r.url).toBe('./根本没有这个');
  });
});
