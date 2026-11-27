/**
 * **残局题库体检** —— `scripts/audit-endgame-puzzles.ts`
 *
 * ## 它回答什么
 *
 * 「这批题到底怎么样」——不是跑一遍就完事，而是每次改生成器后都能重跑对比：
 *
 *   1. 关卡数、主题覆盖、难度分布、多步将杀的数量；
 *   2. **对手着法的质量** —— 对手有没有在犯傻？
 *   3. 解说数据是否覆盖到了关键场景（拖时间 / 唯一着法 / 弃子）。
 *
 * ## 为什么第 2 条要用引擎重算
 *
 * 题库里存的是**离线算好的**解说事实。要验证那些事实还成立，
 * 就得拿引擎重新算一遍 —— 这是唯一诚实的做法。
 *
 * 判据用 **MultiPV 一次搜索**（所有候选同源可比）+ **清哈希**：
 * 逐个着法单独搜索的话，每次搜索都带着上一遍的哈希表残留，
 * 分数能漂二十几厘兵 —— 拿这种数字判「谁最优」是在比噪声。
 *
 * ## 用法
 *
 *   npx tsx scripts/audit-endgame-puzzles.ts
 *   npx tsx scripts/audit-endgame-puzzles.ts --sample=30   # 只抽 30 关，快一些
 *   npx tsx scripts/audit-endgame-puzzles.ts --data=.cache/data-300.ts  # 审候选产物
 *
 * `--data=` 很重要：**先审候选产物，审过了再拷回 `data.ts`** ——
 * 免得不合格的数据先进了仓库，再发现要重跑。
 */
import { Chess } from 'chess.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StockfishBackend } from '../src/lib/engine/uci-backend';
import { opponentNoteText } from '../src/lib/practice/puzzles/notes';
import { PUZZLE_THEMES } from '../src/lib/practice/puzzles/themes';
import type { Puzzle } from '../src/lib/practice/puzzles/types';

const args = process.argv.slice(2);
const sampleArg = args.find((a) => a.startsWith('--sample='));
/** 只抽这么多关来跑引擎检查（0 = 全跑） */
const SAMPLE = sampleArg ? Number(sampleArg.slice('--sample='.length)) : 0;
/** 要审的题库文件（默认是仓库里的 data.ts） */
const dataArg = args.find((a) => a.startsWith('--data='));

/**
 * 读要审的题库。
 *
 * 用**动态导入**而不是顶层 await ——
 * 脚本按 CommonJS 跑，顶层 await 会直接报错。
 */
async function loadPuzzles(): Promise<Puzzle[]> {
  if (!dataArg) {
    const mod = await import('../src/lib/practice/puzzles/data');
    return mod.PUZZLES;
  }
  const path = resolve(dataArg.slice('--data='.length));
  const mod = (await import(pathToFileURL(path).href)) as { PUZZLES: Puzzle[] };
  return mod.PUZZLES;
}

/** 搜索深度 —— 与生成器一致 */
const DEPTH = 12;

interface NodeResult {
  puzzleId: string;
  san: string;
  /** 与引擎最优**同一着法** */
  identical: boolean;
  /** 评估差距（厘兵，对手视角；正 = 实际那手更差） */
  gap: number;
  /** 杀棋距离差（正 = 实际那手拖得更久 = 更好） */
  mateGap: number;
  /** 这手的解说文本 */
  text: string;
  /** note 里有没有 note */
  hopeless: boolean;
  legalCount: number;
  /** 对手在这局面**能不能杀**玩家（边角局面：题本该是玩家赢的） */
  opponentCanMate: boolean;
  /** 这一手走完之后对手是不是被杀棋 */
  opponentIsMated: boolean;
}

async function audit(): Promise<void> {
  console.log('═══ 残局题库体检 ═══\n');
  const PUZZLES = await loadPuzzles();
  if (dataArg) console.log(`（审的是 ${dataArg.slice('--data='.length)}）\n`);

  /* ---------- 1. 静态统计 ---------- */
  console.log('▸ 关卡与分布');
  console.log(`  关卡总数        ${PUZZLES.length}`);

  const themes = new Map<string, number>();
  for (const p of PUZZLES) themes.set(p.theme, (themes.get(p.theme) ?? 0) + 1);
  console.log(`  主题类别数      ${themes.size} / ${Object.keys(PUZZLE_THEMES).length}（主题表里登记的）`);
  const top = [...themes.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  最多的三类      ${top.slice(0, 3).map(([t, n]) => `${t}×${n}`).join('，')}`);
  const maxShare = top[0][1] / PUZZLES.length;
  console.log(`  最大单类占比    ${(maxShare * 100).toFixed(1)}%${maxShare > 0.2 ? ' ⚠️ 超过 20%' : ''}`);

  const bands = new Map<number, number>();
  for (const p of PUZZLES) bands.set(p.difficulty, (bands.get(p.difficulty) ?? 0) + 1);
  console.log(`  难度分布        ${[...bands.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}档×${n}`).join(' ')}`);

  const goals = new Map<string, number>();
  for (const p of PUZZLES) goals.set(p.goal, (goals.get(p.goal) ?? 0) + 1);
  console.log(`  目标分布        ${JSON.stringify(Object.fromEntries(goals))}`);

  const mates = PUZZLES.filter((p) => p.goal === 'mate');
  const multi2 = mates.filter((p) => (p.mateIn ?? 0) >= 2);
  const multi3 = mates.filter((p) => (p.mateIn ?? 0) >= 3);
  console.log(`  将死题          ${mates.length}（其中 ≥2 手 ${multi2.length}，≥3 手 ${multi3.length}）`);

  const noteCount = PUZZLES.reduce(
    (acc, p) => acc + p.line.filter((ply) => ply.color !== p.side && ply.note).length,
    0,
  );
  console.log(`  带解说的对手节点 ${noteCount}`);

  /* ---------- 2. 引擎复核 ---------- */
  const puzzles = SAMPLE > 0 ? PUZZLES.slice(0, SAMPLE) : PUZZLES;
  console.log(`\n▸ 引擎复核对手着法质量${SAMPLE > 0 ? `（抽 ${puzzles.length} 关）` : '（全跑）'}`);

  const sf = new StockfishBackend({ threads: 1 });
  await sf.start();

  const results: NodeResult[] = [];
  for (const p of puzzles) {
    const game = new Chess(p.fen);
    for (const ply of p.line) {
      if (ply.color === p.side) {
        try { game.move(ply.san); } catch { break; }
        continue;
      }
      const nodeFen = game.fen();
      const rows = await sf.analyzeMulti(nodeFen, ply.color, {
        depth: DEPTH,
        multiPv: 16,
        clearHash: true,
      });
      const scored = rows
        .map((r) => {
          const probe = new Chess(nodeFen);
          let played;
          try {
            played = probe.move({
              from: r.move.from,
              to: r.move.to,
              ...(r.move.promotion ? { promotion: r.move.promotion } : {}),
            });
          } catch {
            return null;
          }
          return { san: played.san, cp: r.scoreCp, mate: r.mateIn };
        })
        .filter(Boolean) as { san: string; cp: number | null; mate: number | null }[];

      const best = scored[0];
      const played = scored.find((r) => r.san === ply.san);
      if (best && played) {
        const bestCp = best.cp ?? (best.mate !== null ? (best.mate > 0 ? 100000 : -100000) : 0);
        const playedCp = played.cp ?? (played.mate !== null ? (played.mate > 0 ? 100000 : -100000) : 0);
        let mateGap = 0;
        if (best.mate !== null && best.mate < 0 && played.mate !== null && played.mate < 0) {
          mateGap = played.mate - best.mate;
        }
        results.push({
          puzzleId: p.id,
          san: ply.san,
          identical: best.san === played.san,
          gap: bestCp - playedCp,
          mateGap,
          text: ply.note ? (opponentNoteText(ply.note) ?? '') : '',
          hopeless: ply.note?.hopeless ?? false,
          legalCount: ply.note?.legalCount ?? 0,
          opponentCanMate: best.mate !== null && best.mate > 0,
          opponentIsMated: played.mate !== null && played.mate < 0,
        });
      }
      try { game.move(ply.san); } catch { break; }
    }
  }
  sf.close();

  const n = results.length;
  const identical = results.filter((r) => r.identical).length;
  const effective = results.map((r) => Math.max(r.gap, r.mateGap));
  /*
   * 「等价」的门槛要对齐**解说里的容差**（30 厘兵）。
   *
   * 不对齐的话会出现自相矛盾：
   * 一条解说说「这一手是此刻最强的一着」，
   * 体检却把同一手列为「明显更差」——
   * 两边标准不一样，报告就互相打脸。
   */
  const EQUIV_CP = 30;
  const equivalent = effective.filter((g) => g <= EQUIV_CP).length;
  const worse = n - equivalent;
  const sorted = [...effective].sort((a, b) => a - b);
  console.log(`  对手节点        ${n}`);
  console.log(`  与引擎最优同一着 ${identical}（${((identical / n) * 100).toFixed(1)}%）`);
  console.log(`  评估等价（≤${EQUIV_CP}） ${equivalent}（${((equivalent / n) * 100).toFixed(1)}%）`);
  console.log(`  明显更差         ${worse}（${((worse / n) * 100).toFixed(1)}%）`);
  console.log(
    `  差距分位         p50=${sorted[Math.floor(n * 0.5)]} p75=${sorted[Math.floor(n * 0.75)]} p90=${sorted[Math.floor(n * 0.9)]} max=${sorted[n - 1]}`,
  );

  /* ---------- 3. 解说覆盖 ---------- */
  console.log('\n▸ 解说覆盖到的场景');
  const withText = results.filter((r) => r.text.length > 0);
  console.log(`  有解说文本       ${withText.length} / ${n}`);
  const scenes = {
    '唯一合法着法': results.filter((r) => r.legalCount === 1).length,
    '已败/输定': results.filter((r) => r.hopeless).length,
    '不是最优': results.filter((r) => r.text.includes('不是最优')).length,
    '在拖时间': results.filter((r) => r.text.includes('最能拖')).length,
    '有更好的走法': results.filter((r) => r.text.includes('更好的走法')).length,
    '弃子': results.filter((r) => r.text.includes('代价是丢了')).length,
    '唯一 + 已败': results.filter((r) => r.legalCount === 1 && r.hopeless).length,
  };
  for (const [k, v] of Object.entries(scenes)) {
    console.log(`  ${k.padEnd(14)} ${v}`);
  }

  /*
   * 「已败」还要拆开看 —— 两句话的含义完全不同：
   *   - 无解   = 被杀棋（对手在拖时间）
   *   - 输定   = 子力大劣（对手在少输）
   * 两者的比例决定解说有没有信息量：
   * 全是「输定」的话，解说就只剩一句话在重复。
   */
  const mateCount = results.filter((r) => r.opponentIsMated).length;
  console.log(`  ├ 无解（被杀棋） ${mateCount}`);
  console.log(`  └ 输定（子力劣） ${results.filter((r) => r.hopeless).length - mateCount}`);

  /*
   * 边角局面：对手自己握着杀棋。
   *
   * 练习题不该出现这种局面（玩家才是解题方），但真出现了就得知道 ——
   * 「对手能杀」时，比较着法的口径要换一套。
   */
  const canMate = results.filter((r) => r.opponentCanMate).length;
  console.log(`  对手握着杀棋     ${canMate}${canMate > 0 ? ' ⚠️ 出现了不该有的局面' : ''}`);

  const distinct = new Set(withText.map((r) => r.text)).size;
  console.log(`  不同说法的种类   ${distinct}`);

  /* ---------- 4. 明显更差的样本 ---------- */
  const badSamples = results.filter((r) => Math.max(r.gap, r.mateGap) > EQUIV_CP).slice(0, 6);
  if (badSamples.length > 0) {
    console.log('\n▸ 对手明显走弱的样本');
    for (const r of badSamples) {
      console.log(`  [${r.puzzleId}] ${r.san}  差 ${Math.max(r.gap, r.mateGap)}`);
      console.log(`     解说：${r.text}`);
    }
  }

  console.log('\n═══ 体检完毕 ═══');
}

audit().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
