/**
 * **hook 结构守卫** —— 防止「条件 hook」把整个界面打崩。
 *
 * 背景（本项目真实踩过）：
 *   `PieceGlyph` 里像素版曾经写��� `if (style === 'pixel') return <像素精灵/>`，
 *   而木纹的 `useMemo` 写在它**后面**。
 *   React 的规则是「每次渲染的 hook 数量必须一样」——
 *   从「经典」切到「像素」的那一刻，后面的 hook 被跳过，
 *   React 抛 "Rendered fewer hooks than expected"，
 *   **整棵棋盘直接崩溃消失**（不是画错，是整棵树卸载）。
 *   而且这种 bug 只在**切换设置的那一刻**才炸，
 *   单元测试、静态渲染全都测不出来 —— 只有真实浏览器里点一下才会炸。
 *
 * 为什么用**静态分析**而不是跑一遍 React：
 *   浏览器门禁能抓到这一次，但代价是「构建 + 起服务 + 点设置」，
 *   慢，而且它抓的是**现象**不是**成因**。
 *   而这条规则是纯结构的：hook 必须在所有 return 之前、且必须在函数体顶层。
 *   满足这两条 ⇒ 任何一条渲染路径执行的 hook 序列都相同 ⇒ React 永远不会炸。
 *
 * 用 TypeScript 自带的编译器 API（已经是 devDependency，不新增任何依赖）。
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** 递归收集目录下的 .ts / .tsx */
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** React 的 hook 一律是 `use` + 大写字母 */
function isHookCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    /^use[A-Z]/.test(node.expression.text)
  );
}

/** 一个函数的 hook / return 形状 */
interface FnShape {
  /** 文件里显示用的名字 */
  name: string;
  /** hook 调用：名字 + 位置 + 是否在函数体顶层 */
  hooks: Array<{ name: string; pos: number; topLevel: boolean }>;
  /** 所有 return 的位置 */
  returns: number[];
  /** 藏在条件（三元 / && / || / ??）里的 hook —— 表达式体组件才用得上 */
  condHooks: string[];
}

/**
 * 表达式体里的「条件 hook」。
 *
 * 条件有四种写法，都要认：
 *   `cond ? useMemo(a) : useMemo(b)`   —— 三元
 *   `cond && useMemo(a)`               —— 逻辑与
 *   `cond || useMemo(a)`               —— 逻辑或
 *   `cond ?? useMemo(a)`               —— 空值合并
 */
function conditionalHooks(body: ts.Expression): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      isHookCall(node) &&
      (ts.isConditionalExpression(node.parent) ||
        ts.isBinaryExpression(node.parent) ||
        ts.isParenthesizedExpression(node.parent))
    ) {
      out.push((node.expression as ts.Identifier).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/** 分析一个函数体（不进入嵌套函数 —— 嵌套函数是另一个组件） */
function analyse(name: string, body: ts.Block): FnShape {
  const topLevel = new Set<ts.Node>(body.statements);
  const hooks: FnShape['hooks'] = [];
  const returns: number[] = [];

  const isDirectChild = (node: ts.Node): boolean => {
    let cur: ts.Node | undefined = node;
    while (cur && cur !== body) {
      if (topLevel.has(cur)) return true;
      cur = cur.parent;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node)) returns.push(node.pos);
    if (isHookCall(node)) {
      hooks.push({
        name: (node.expression as ts.Identifier).text,
        pos: node.pos,
        topLevel: isDirectChild(node),
      });
    }
    ts.forEachChild(node, (c) => {
      if (ts.isFunctionLike(c)) return; // 嵌套函数不算这个组件的 hook
      visit(c);
    });
  };
  visit(body);

  return { name, hooks, returns, condHooks: [] };
}

/** 收集文件里所有「组件 / 自定义 hook」的形状 */
function shapesInFile(file: string): FnShape[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const out: FnShape[] = [];

  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      const name = n.name.text;
      // 组件（大写开头）与自定义 hook（use 开头）才受这条规则约束
      if (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name)) {
        out.push(analyse(name, n.body));
      }
    }
    // 箭头函数 / 函数表达式形式的组件也一并收进来
    if (ts.isVariableStatement(n)) {
      for (const decl of n.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (!/^[A-Z]/.test(name) && !/^use[A-Z]/.test(name)) continue;
        const init = decl.initializer;
        if (!init || !(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
        if (ts.isBlock(init.body)) {
          out.push(analyse(name, init.body));
        } else {
          /*
           * 表达式体（`() => <div/>`）：没有语句，也就没有「提前 return」这回事，
           * 但**条件表达式里的 hook** 照样危险 —— `cond ? useMemo(a) : useMemo(b)`。
           * 所以这里单独把「藏在条件里的 hook」挑出来。
           */
          out.push({
            name,
            hooks: [],
            returns: [],
            condHooks: conditionalHooks(init.body),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return out;
}

const FILES = [
  ...walkFiles(path.join(ROOT, 'src/components')),
  ...walkFiles(path.join(ROOT, 'src/app')),
];

describe('hook 结构守卫（条件 hook 会把整棵树打崩）', () => {
  it('扫得到组件（守卫本身不是空跑）', () => {
    const all = FILES.flatMap(shapesInFile);
    const withHooks = all.filter((s) => s.hooks.length > 0);
    expect(all.length).toBeGreaterThan(10);
    expect(withHooks.length).toBeGreaterThan(5);
    // 棋子渲染这条链必须在里面 —— 否则守卫盯错了地方
    expect(
      all.some((s) => s.name === 'PieceGlyph' && s.hooks.length > 0),
      '没扫到 PieceGlyph 的 hook',
    ).toBe(true);
  });

  it('所有 hook 都在函数体顶层（不能藏在 if / && / 三元里）', () => {
    const bad: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(ROOT, file);
      for (const s of shapesInFile(file)) {
        for (const h of s.hooks) {
          if (!h.topLevel) {
            bad.push(`${rel} :: ${s.name} 的 ${h.name}() 不在函数体顶层`);
          }
        }
        for (const h of s.condHooks) {
          bad.push(`${rel} :: ${s.name} 的 ${h}() 藏在条件表达式里`);
        }
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('所有 hook 都排在所有 return 之前（提前 return 不能跳过后面的 hook）', () => {
    const bad: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(ROOT, file);
      for (const s of shapesInFile(file)) {
        if (!s.hooks.length || !s.returns.length) continue;
        const lastHook = Math.max(...s.hooks.map((h) => h.pos));
        const firstReturn = Math.min(...s.returns);
        if (lastHook > firstReturn) {
          bad.push(
            `${rel} :: ${s.name} —— ${s.hooks
              .filter((h) => h.pos > firstReturn)
              .map((h) => h.name)
              .join(',')} 排在 return 之后（提前 return 会跳过它们）`,
          );
        }
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('棋子渲染组件本身就是单 return 路径（4 种风格共用同一棵 hook 树）', () => {
    const file = path.join(ROOT, 'src/components/PieceGlyph.tsx');
    const glyph = shapesInFile(file).find((s) => s.name === 'PieceGlyph');
    expect(glyph).toBeDefined();
    // 单一 return：风格切换不会改变 hook 树
    expect(glyph!.returns.length).toBe(1);
    // hook 数量：useId + useMemo × 6
    expect(glyph!.hooks.length).toBeGreaterThanOrEqual(5);
  });
});
