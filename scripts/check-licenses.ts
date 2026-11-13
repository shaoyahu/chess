/**
 * 许可证门禁 —— 检查整棵依赖树的许可证是否合规。
 *
 * 规则（硬约束）：
 *  - 运行时依赖只允许宽松许可：MIT / ISC / BSD-* / Apache-2.0 / 0BSD /
 *    Python-2.0 / CC0 / Unlicense；
 *  - CC-BY-4.0 只允许出现在**构建期数据**包上（Next.js 的 caniuse-lite），
 *    它是「署名即可」的开放许可，不含任何非商用限制或私有协议条款；
 *  - copyleft（GPL-3.0 等）只允许出现在**明确列在例外表里**的包上，
 *    并且必须写明理由；
 *  - 其它一律视为不合规（例如 BUSL / SSPL / Elastic / 含非商业限制的许可 / 商业许可）。
 *
 * 例外表按 `包名@版本` 精确匹配 —— 升版本会失配并让门禁变红，
 * 这是故意的：换版本等于换了个东西，要人工重新确认一遍许可。
 *
 * 注意：有些包 package.json 里**不写** license 字段，但仓库根目录有 LICENSE 文件。
 * 这时回退去读 LICENSE 文件的前几行做特征匹配 —— 否则会误报。
 *
 * 用法：npm run licenses
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Python-2.0',
  'CC0-1.0',
  'Unlicense',
]);

/**
 * 额外放行：仅限「非源码、构建期数据」且许可证为署名类的开放许可。
 * key = 包名，value = 放行理由。
 */
const ALLOWED_EXCEPTIONS: Record<string, string> = {
  'caniuse-lite@1.0.30001823':
    'CC-BY-4.0：Next.js 自带的浏览器兼容数据集，署名即可，无 NC 限制，仅构建期使用',
  'stockfish@19.0.1':
    'GPL-3.0：Stockfish.js（Stockfish 19 的 WASM 版）。本项目本身也是 GPL-3.0，' +
    '直接使用允许；引擎以独立子进程方式调用，不做任何修改',
};

type Node = {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  dependencies?: Record<string, Node>;
};

function licenseFromFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const candidate = files.find(
    (f) => /^licen[cs]e(\.|$)/i.test(f) || f === 'UNLICENSE' || f === 'COPYING',
  );
  if (!candidate) return null;
  const text = readFileSync(join(dir, candidate), 'utf8').slice(0, 1200);
  if (/Creative Commons Attribution 4\.0/i.test(text) || /Attribution 4\.0 International/i.test(text)) {
    return 'CC-BY-4.0';
  }
  if (/Apache License/i.test(text) && /Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Redistribution and use in source and binary forms/i.test(text)) return 'BSD-3-Clause';
  if (/This is free and unencumbered software released into the public domain/i.test(text)) {
    return 'Unlicense';
  }
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(text)) {
    return 'ISC';
  }
  return null;
}

function normalize(lic: string): string {
  const s = lic.trim();
  if (/^Apache-2\.0/i.test(s)) return 'Apache-2.0';
  if (/^MIT/i.test(s)) return 'MIT';
  if (/^ISC/i.test(s)) return 'ISC';
  if (/^BSD-3-Clause/i.test(s)) return 'BSD-3-Clause';
  if (/^BSD-2-Clause/i.test(s)) return 'BSD-2-Clause';
  if (/^0BSD/i.test(s)) return '0BSD';
  if (/^CC0/i.test(s)) return 'CC0-1.0';
  if (/^CC-BY-4\.0/i.test(s)) return 'CC-BY-4.0';
  if (/^Unlicense/i.test(s)) return 'Unlicense';
  if (/^Python-2\.0/i.test(s)) return 'Python-2.0';
  return s;
}

/**
 * copyleft 许可：一旦依赖树里有这些，项目自身的 license 必须与它兼容，
 * 否则再分发整个作品就违反 copyleft。
 */
const COPYLEFT = new Set(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-3.0']);

/** 与 copyleft 兼容的项目自身 license */
const COPYLEFT_COMPATIBLE = new Set(['GPL-3.0', 'GPL-2.0', 'AGPL-3.0']);

function main(): void {
  const raw = execFileSync('npm', ['ls', '--all', '--json', '--long'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const tree = JSON.parse(raw) as Node;

  // 项目自身：npm ls 会把根包也列出来，它的 license 由「copyleft 兼容性检查」管，
  // 不走依赖许可检查（不然会把项目自己判成不合规）。
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    name?: string;
    version?: string;
    license?: string;
  };

  const violations: string[] = [];
  const exceptions: string[] = [];
  const copyleftDeps: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  const checkPackage = (node: Node): void => {
    const name = node.name ?? '';
    const version = node.version ?? '';
    const key = `${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (name === pkg.name && version === pkg.version) return; // 根包 = 项目本身
    total += 1;

    const rawLic = typeof node.license === 'string' ? node.license : node.license?.type ?? '';
    let lic = normalize(rawLic);
    if (!lic || lic === 'UNKNOWN' || lic === 'SEE LICENSE IN') {
      // package.json 没写 → 去找 LICENSE 文件
      const dirs = [
        join('node_modules', name),
        join('node_modules', ...name.split('/'), version),
      ];
      for (const d of dirs) {
        const fromFile = licenseFromFile(d);
        if (fromFile) {
          lic = normalize(fromFile);
          break;
        }
      }
    }
    if (!lic || lic === 'UNKNOWN' || lic === 'SEE LICENSE IN') {
      violations.push(`${key} :: 无法识别的许可证`);
      return;
    }
    if (ALLOWED.has(lic)) return;
    if (COPYLEFT.has(lic)) copyleftDeps.push(`${key} :: ${lic}`);
    const reason = ALLOWED_EXCEPTIONS[key];
    if (reason) {
      exceptions.push(`${key} :: ${lic} —— ${reason}`);
      return;
    }
    violations.push(`${key} :: ${lic}`);
  };

  const walk = (node: Node | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.name && node.version) checkPackage(node);
    if (node.dependencies) {
      for (const child of Object.values(node.dependencies)) walk(child);
    }
  };
  walk(tree);

  console.log(`依赖包总数: ${total}`);
  if (exceptions.length) {
    console.log('\n额外放行（开放许可 + 明确理由）:');
    for (const e of exceptions) console.log(`  · ${e}`);
  }
  // copyleft 兼容性：依赖树里有 copyleft，项目自身就必须是兼容的 copyleft 许可
  if (copyleftDeps.length > 0) {
    const own = normalize(pkg.license ?? '');
    if (!COPYLEFT_COMPATIBLE.has(own)) {
      violations.push(
        `项目自身 license (${pkg.license ?? '未声明'}) 与 copyleft 依赖不兼容：` +
          copyleftDeps.join('、'),
      );
    }
  }

  if (violations.length) {
    console.error('\n许可证不合规:');
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error('\n门禁未通过：存在非宽松许可 / 无法识别的许可证依赖。');
    process.exit(1);
  }
  console.log(
    '\n✓ 门禁通过：全部依赖均为宽松开源许可或已明确登记的开源例外，' +
      '无私有协议 / 非商用限制；项目自身许可与 copyleft 依赖兼容。',
  );
}

main();
