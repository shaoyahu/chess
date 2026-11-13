/**
 * 引擎战术门禁。
 *
 * 这些用例守的是「引擎说的话是不是人话」，而不是「有没有返回一着法」。
 *
 * 背景：曾经有一版引擎在根节点用 PVS（空窗试探 + 命中后重搜），
 * 但漏了重搜那一半——空窗试探返回的只是**界**，不是着法的真实分值。
 * 结果根节点二十来个着法拿到的分值全挤在一起（24~25），
 * 引擎等于只会走第一着；辅助下棋就会推荐「兵推进去被马白吃」这种废棋。
 *
 * 所以门禁不只测「best 是哪着」，还要测：
 *   - 不同着法的分值必须**分得开**（界值没混进来）
 *   - 兵推进到能被对方马吃的格子时，不能被推荐
 *   - 白送的子必须被吃掉
 *
 * 失败信息一律带门禁编号（E1..E12），方便脚本按编号定位。
 */
import { Chess } from 'chess.js';
import { captureMoveList, searchPosition } from '../src/lib/engine/search';

let failed = 0;

function fail(id: string, msg: string): void {
  failed += 1;
  console.log(`❌ ${id} ${msg}`);
}

function pass(id: string, msg: string): void {
  console.log(`✅ ${id} ${msg}`);
}

/** 把 UCI（'e2e4'）写成 chess.js 能吃的对象 */
function uciOf(m: { from: string; to: string; promotion?: string }): string {
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

/**
 * 跑一次搜索，返回根节点所有着法（按引擎给的顺序）。
 */
function search(fen: string, timeMs = 1500, maxDepth = 12) {
  const outcome = searchPosition(fen, { timeMs, maxDepth });
  const uci = outcome.moves.map((m) => uciOf(m.move));
  const best = outcome.best ? uciOf(outcome.best) : null;
  return { outcome, uci, best, score: outcome.score };
}

/* ------------------------------------------------------------------ *
 * E1 / E2：根节点分值必须分得开
 * ------------------------------------------------------------------ */

// 开局时各着法分值几乎肯定不同（e4/d4/Nf3 各有优劣）。
//
// 这里必须用**精确根分**（exactRootScores）模式：PVS 模式下排在后面的着法
// 拿到的是「上界」而不是真值（界值相同是 PVS 的正常语义，不能拿它当 bug）。
// 所以 E1 守的是「精确根分这条路没坏」——easy 档正是靠它挑次优着法。
{
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const outcome = searchPosition(fen, { timeMs: 2000, maxDepth: 6, exactRootScores: true });
  const scores = outcome.moves.map((m) => m.score);
  const distinct = new Set(scores.map((s) => Math.round(s))).size;
  if (distinct < 8) {
    fail(
      'E1',
      `精确根分下开局 20 个着法只分出 ${distinct} 种分值（${scores.slice(0, 8).join(',')}）——` +
        '根节点拿到的还是界而不是真值，排序不可信',
    );
  } else {
    pass('E1', `精确根分下开局 20 个着法分出 ${distinct} 种分值`);
  }
}

// 同一局面，best 必须落在排序第一位（moves[0]），不能出现「best 与 moves 列表不一致」。
{
  const { uci, best } = search('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  if (best !== uci[0]) {
    fail('E2', `best=${best} 与 moves[0]=${uci[0]} 不一致`);
  } else {
    pass('E2', `best 与 moves[0] 一致（${best}）`);
  }
}

/* ------------------------------------------------------------------ *
 * E3：兵推进到能被对方马吃的格子 → 不能推荐
 * ------------------------------------------------------------------ */

// 黑马 c3 盯着 e2 兵；e2-e4 之后马跳 e4 白吃。
// 正确走法是 e2-e3（马吃不到）。
//
// 用精确根分断言「送兵那步的分值必须明显更低」——这才是真正的棋理断言，
// 光断言「best 不是它」太弱：引擎退化成随便挑一个也可能蒙对。
//
// 同样用 chess.js 现场复核前提：e2-e4 之后对方确实能吃子。
// （曾经把这个用例的格位读错，测的是「马能不能吃 b3」，跟送兵毫无关系。）
{
  const fen = '4k3/8/8/8/8/2n5/4P3/4K1N1 w - - 0 1';
  const blunderUci = 'e2e4';
  const safeUci = 'e2e3';

  const probe = new Chess(fen);
  probe.move(blunderUci);
  const canWin = probe.moves({ verbose: true }).some((m) => m.captured);
  if (!canWin) {
    fail('E3', `前提不成立：走 ${blunderUci} 之后对方并不能吃子，这个用例没测到东西`);
  } else {
    const outcome = searchPosition(fen, { timeMs: 3000, maxDepth: 8, exactRootScores: true });
    const byUci = new Map(outcome.moves.map((m) => [uciOf(m.move), m.score]));
    const blunder = byUci.get(blunderUci);
    const safe = byUci.get(safeUci);
    const best = outcome.best ? uciOf(outcome.best) : null;
    if (blunder === undefined || safe === undefined) {
      fail('E3', `候选列表缺 ${blunderUci}/${safeUci}，无法判定`);
    } else if (safe - blunder < 60) {
      fail(
        'E3',
        `送兵着法 ${blunderUci}(${blunder.toFixed(1)}) 与安全着法 ${safeUci}(${safe.toFixed(1)}) 只差 ` +
          `${(safe - blunder).toFixed(1)} 分——引擎没意识到那兵会被白吃`,
      );
    } else if (best === blunderUci) {
      fail('E3', `引擎推荐了 ${blunderUci}——那兵推进上去就被马白吃（best=${best}）`);
    } else {
      pass('E3', `送兵着法 ${blunderUci} 被正确识别（${blunder.toFixed(1)} vs ${safe.toFixed(1)}）`);
    }
  }
}

// 黑马 d5 盯着 b4：b2-b4 之后马跳 b4 白吃；b2-b3 安全。
//
// 【注意这个用例的坑】FEN 里 '3n4' 出现在第 4 行 = **d5**，不是 d4。
// d5 的马吃 b4、够不到 b3；d4 的马吃 b3、够不到 b4。
// 写反了就会把「送兵着法」和「安全着法」标反，测出来的东西毫无意义。
// 所以下面用 chess.js 现场复核前提：送兵那步之后对方确实能吃子。
{
  const fen = '4k3/8/8/3n4/8/8/1P6/4K1N1 w - - 0 1';
  const blunderUci = 'b2b4';
  const safeUci = 'b2b3';

  // 前提自校验：棋.js 独立确认「送兵那步真的会被吃」
  const probe = new Chess(fen);
  probe.move(blunderUci);
  const canWin = probe.moves({ verbose: true }).some((m) => m.captured);
  if (!canWin) {
    fail('E4', `前提不成立：走 ${blunderUci} 之后对方并不能吃子，这个用例没测到东西`);
  } else {
    const outcome = searchPosition(fen, { timeMs: 3000, maxDepth: 8, exactRootScores: true });
    const byUci = new Map(outcome.moves.map((m) => [uciOf(m.move), m.score]));
    const blunder = byUci.get(blunderUci);
    const safe = byUci.get(safeUci);
    if (blunder === undefined || safe === undefined) {
      fail('E4', `候选列表缺 ${blunderUci}/${safeUci}，无法判定`);
    } else if (safe - blunder < 60) {
      fail(
        'E4',
        `送兵着法 ${blunderUci}(${blunder.toFixed(1)}) 与安全着法 ${safeUci}(${safe.toFixed(1)}) 只差 ` +
          `${(safe - blunder).toFixed(1)} 分——引擎没意识到那兵会被白吃`,
      );
    } else {
      pass('E4', `送兵着法 ${blunderUci} 被正确识别（${blunder.toFixed(1)} vs ${safe.toFixed(1)}）`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * E5 / E6：白送的子必须吃
 * ------------------------------------------------------------------ */

// 白车 a1，黑车 a8 在同一根线上且无保护 → 白车 a1xa8 白吃一车。
{
  const fen = 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 1';
  const { uci, best } = search(fen);
  if (!uci.includes('a1a8')) {
    fail('E5', `候选列表里没有 a1a8（吃白送的车）`);
  } else if (best !== 'a1a8') {
    fail('E5', `引擎没吃白送的车，best=${best}`);
  } else {
    pass('E5', '吃掉了白送的车');
  }
}

// 白车 d1，黑车 d8 同线无保护 → d1xd8。
{
  const fen = '3r1k2/8/8/8/8/8/8/3R1K2 w - - 0 1';
  const { uci, best } = search(fen);
  if (!uci.includes('d1d8')) {
    fail('E6', `候选列表里没有 d1d8（吃白送的车）`);
  } else if (best !== 'd1d8') {
    fail('E6', `引擎没吃白送的车，best=${best}`);
  } else {
    pass('E6', '吃掉了白送的车');
  }
}

/* ------------------------------------------------------------------ *
 * E7：一步杀必须找到
 * ------------------------------------------------------------------ */

// 白车 a1，黑王 g8，f7/g7/h7 有兵 → Ra8#。
{
  const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const { best } = search(fen);
  const game = new Chess(fen);
  const probe = new Chess(fen);
  probe.move('a1a8');
  const isMate = probe.isCheckmate();
  if (!isMate) {
    fail('E7', '测试局面本身不是一步杀，测试用例失效');
  } else if (best !== 'a1a8') {
    fail('E7', `一步杀没找到，best=${best}`);
  } else {
    pass('E7', '一步杀找到了');
  }
  void game;
}

/* ------------------------------------------------------------------ *
 * E8：推荐着法必须合法（chess.js 复核）
 * ------------------------------------------------------------------ */
{
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  ];
  let bad: string | null = null;
  for (const fen of fens) {
    const { outcome } = search(fen, 1000);
    if (!outcome.best) {
      bad = `${fen} → 没给出着法`;
      break;
    }
    const game = new Chess(fen);
    try {
      game.move({
        from: outcome.best.from,
        to: outcome.best.to,
        ...(outcome.best.promotion ? { promotion: outcome.best.promotion } : {}),
      });
    } catch {
      bad = `${fen} → ${uciOf(outcome.best)} 非法`;
      break;
    }
  }
  if (bad) {
    fail('E8', bad);
  } else {
    pass('E8', `${fens.length} 个局面的推荐着法都合法`);
  }
}

/* ------------------------------------------------------------------ *
 * E9：分值必须是有限数（不能有 NaN / Infinity）
 * ------------------------------------------------------------------ */
{
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  ];
  let bad: string | null = null;
  for (const fen of fens) {
    const { outcome } = search(fen, 800);
    if (!Number.isFinite(outcome.score)) {
      bad = `${fen} → score=${outcome.score}`;
      break;
    }
    for (const m of outcome.moves) {
      if (!Number.isFinite(m.score)) {
        bad = `${fen} → ${uciOf(m.move)} 的分值=${m.score}`;
        break;
      }
    }
    if (bad) break;
  }
  if (bad) {
    fail('E9', bad);
  } else {
    pass('E9', '所有分值都是有限数');
  }
}

/* ------------------------------------------------------------------ *
 * E10：不同局面不能返回同一着法（防止又变成「只会走第一着」）
 * ------------------------------------------------------------------ */

// 三个完全不同的局面，best 必须各不相同。
// 如果引擎退化成「永远返回生成顺序的第一个着法」，这三个会撞成一样。
{
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  ];
  const bests = fens.map((fen) => search(fen, 1000).best);
  if (new Set(bests).size !== bests.length) {
    fail('E10', `不同局面返回了相同的 best：${bests.join(' / ')}`);
  } else {
    pass('E10', `三个局面给出不同着法（${bests.join(' / ')}）`);
  }
}

/* ------------------------------------------------------------------ *
 * E11：easy 档（精确根分）下分值必须严格可排序
 * ------------------------------------------------------------------ */

// easy 档靠 outcome.moves 的排序挑次优着法，
// 所以那一档必须用精确根分（exactRootScores），分值不能是界。
{
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const outcome = searchPosition(fen, { timeMs: 600, maxDepth: 2, exactRootScores: true });
  const scores = outcome.moves.map((m) => m.score);
  const distinct = new Set(scores.map((s) => Math.round(s))).size;
  if (distinct < 3) {
    fail('E11', `easy 档 20 个着法只分出 ${distinct} 种分值，排序不可信`);
  } else {
    pass('E11', `easy 档分出 ${distinct} 种分值`);
  }
}

/* ------------------------------------------------------------------ *
 * E12：着法列表必须与 best 一致且非空
 * ------------------------------------------------------------------ */
{
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const { outcome, uci, best } = search(fen, 1000);
  if (outcome.moves.length === 0) {
    fail('E12', '着法列表为空');
  } else if (best !== uci[0]) {
    fail('E12', `best=${best} 与 moves[0]=${uci[0]} 不一致`);
  } else {
    pass('E12', `着法列表 ${outcome.moves.length} 条，best 与首项一致`);
  }
}

/* ------------------------------------------------------------------ *
 * E13：吃子着法生成必须与 chess.js 完全一致（capturesOnly 路径）
 * ------------------------------------------------------------------ */

// quiescence（静态搜索）走的是 genMoves(..., capturesOnly=true) 这条路径，
// 和 legalMoveList 走的普通路径是**两段独立代码**。
//
// 曾经的漏测：所有对拍用的局面都「没有子可吃」，capturesOnly 分支里
// 那些 if (!capturesOnly) 的条件分支一次都没被走到过。
// 所以这里专门挑「有子可吃」的局面来对拍。
{
  const fens = [
    // 车吃车（整条线无子）
    'r3k3/8/8/8/8/8/8/R3K3 w - - 0 1',
    // 兵斜吃兵
    '4k3/8/8/8/8/2p5/3P4/4K3 w - - 0 1',
    // 后吃后（贴身）
    '4k3/8/8/8/8/8/3q4/3QK3 w - - 0 1',
    // 马吃马（一步）
    '4k3/8/8/8/8/8/3n4/R3K3 w - - 0 1',
    // 兵吃子并升变（a7xb8 四个升变）
    '1b5k/P7/8/8/8/8/8/4K3 w - - 0 1',
    // 吃过路兵
    '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
    // 后吃车（隔一路）
    '3rk3/8/8/8/8/8/3Q4/3RB1K1 w - - 0 1',
    // 换边：黑方吃子（黑马 f5 吃 d4 兵）
    '4k3/8/8/5n2/3P4/8/8/4K3 b - - 0 1',
    // 车吃受保护的子（吃不吃由搜索决定，这里只验生成）
    '4k3/8/8/8/8/8/3n4/R3K3 w - - 0 1',
  ];
  let bad: string | null = null;
  for (const fen of fens) {
    const game = new Chess(fen);
    const expected = new Set(
      game.moves({ verbose: true })
        .filter((m) => m.captured)
        .map((m) => `${m.from}${m.to}${m.promotion ?? ''}`),
    );
    const actual = new Set(captureMoveList(fen));
    const missing = [...expected].filter((m) => !actual.has(m));
    const extra = [...actual].filter((m) => !expected.has(m));
    if (missing.length > 0 || extra.length > 0) {
      bad =
        `${fen} → 引擎缺 [${missing.join(',')}] 多出 [${extra.join(',')}]` +
        `（chess.js ${expected.size} 个吃子着法，引擎 ${actual.size} 个）`;
      break;
    }
    if (expected.size === 0) {
      bad = `${fen} → 这个局面本来就没有子可吃，用例选错了`;
      break;
    }
  }
  if (bad) {
    fail('E13', bad);
  } else {
    pass('E13', `${fens.length} 个含吃子的局面，吃子着法生成与 chess.js 完全一致`);
  }
}

/* ------------------------------------------------------------------ *
 * E14：有子可吃时，引擎必须看得见（静态搜索那条路径）
 * ------------------------------------------------------------------ */

// E13 只验了「着法生成本身对不对」；
// 这里验「吃子着法真的进了搜索」——白送一个兵，引擎必须抓住。
{
  const cases: { fen: string; expect: string }[] = [
    // 白车 a1，黑车 a8 隔空无保护 → a1a8 白吃一车
    { fen: 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 1', expect: 'a1a8' },
    // 白车 d1，黑车 d8 同线 → d1d8
    { fen: '3r1k2/8/8/8/8/8/8/3R1K2 w - - 0 1', expect: 'd1d8' },
  ];
  let bad: string | null = null;
  for (const c of cases) {
    const { uci, best } = search(c.fen, 1500);
    if (!uci.includes(c.expect)) {
      bad = `${c.fen} → 候选列表里没有 ${c.expect}`;
      break;
    }
    if (best !== c.expect) {
      bad = `${c.fen} → 引擎没吃白送的子，best=${best}`;
      break;
    }
  }
  if (bad) {
    fail('E14', bad);
  } else {
    pass('E14', '有子可吃时引擎都抓住了');
  }
}

/* ------------------------------------------------------------------ *
 * E15：PVS 路径与精确路径必须选出同一着法
 * ------------------------------------------------------------------ */

// 这是**辅助下棋真正用的那条路径**（默认不开 exactRootScores，走 PVS + 空窗试探）。
//
// PVS 只是省时间的技巧，**不允许改变选着的结论**：
// 同深度下，PVS 路径的 best 必须与「每个根着法独立全窗口搜」的精确路径一致。
//
// 守的是根节点那半段 PVS：
//   曾经空窗试探之后**没有重搜精确分**，试探拿到的只是「界」，
//   于是排序完全失真（20 个着法分值挤在一起，引擎等于只会走第一个）。
//   那条 bug 在别的用例上不一定看得出来（best 常常还是对的），
//   但只要碰到「试探界刚好卡在 alpha 边界」的局面，选着就会翻车。
{
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    '4k3/8/8/8/8/2n5/4P3/4K1N1 w - - 0 1',
    '4k3/8/8/3n4/8/8/1P6/4K1N1 w - - 0 1',
  ];
  let bad: string | null = null;
  for (const fen of fens) {
    const pvs = searchPosition(fen, { timeMs: 4000, maxDepth: 4 });
    const exact = searchPosition(fen, { timeMs: 4000, maxDepth: 4, exactRootScores: true });
    const pb = pvs.best ? uciOf(pvs.best) : '-';
    const eb = exact.best ? uciOf(exact.best) : '-';
    if (pvs.depth !== exact.depth) {
      bad = `${fen} → 两条路径深度不同（${pvs.depth} vs ${exact.depth}），没法比`;
      break;
    }
    if (pb !== eb) {
      bad = `${fen} → PVS 路径选 ${pb}，精确路径选 ${eb}——PVS 改变了选着结论`;
      break;
    }
    if (Math.abs(pvs.score - exact.score) > 0.5) {
      bad = `${fen} → 同一着法分值不一致（PVS=${pvs.score.toFixed(1)} exact=${exact.score.toFixed(1)}）`;
      break;
    }
  }
  if (bad) {
    fail('E15', bad);
  } else {
    pass('E15', `${fens.length} 个局面下 PVS 路径与精确路径选出同一着法且分值一致`);
  }
}

/* ------------------------------------------------------------------ *
 * E16：PVS 路径的非首项分值不能被抬平到 best
 * ------------------------------------------------------------------ */

// quiescence 曾经在结尾 `return alpha` —— 返回的是**继承来的窗口边界**，
// 不是本节点自己的分值。后果是：非首项着法拿到的分值被系统性地抬到
// 「当前最好的那个值」，根节点列表变成 111.4/111.4/111.4/111.4，
// 排序信息彻底消失。
//
// 注意这跟 E1 不矛盾：E1 用的是**精确根分**模式（每个着法独立全窗口搜），
// 那条路径上分值本来就该分得开；这里守的是 **PVS 路径**。
// PVS 下「非首项与首项同分」本身是合法语义（界值相同），
// 但「**所有**非首项都恰好等于 best」不是——那是界被当成了事实。
{
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    '4k3/8/8/8/8/2n5/4P3/4K1N1 w - - 0 1',
    '4k3/8/8/3n4/8/8/1P6/4K1N1 w - - 0 1',
  ];
  const flat: string[] = [];
  const details: string[] = [];
  for (const fen of fens) {
    const outcome = searchPosition(fen, { timeMs: 3000, maxDepth: 5 });
    const best = outcome.score;
    const others = outcome.moves.slice(1).map((m) => m.score);
    // 「非首项严格低于 best」= 至少有一个着法被分出了层次
    const lows = others.filter((s) => s < best - 1.0).length;
    if (lows === 0) {
      flat.push(fen);
      details.push(
        `${fen} → 非首项分值 ${others.slice(0, 4).map((s) => s.toFixed(1)).join('/')} 全都不低于 best(${best.toFixed(1)})`,
      );
    }
  }
  // PVS 下「某个非首项与首项同分」本身是合法语义（界值相同），
  // 但「**一个都分不出来**」不是 —— 那说明所有非首项都拿到了同一个值，
  // 典型的成因就是 quiescence 把窗口边界当成了本节点分值。
  if (flat.length > 0) {
    fail(
      'E16',
      `${flat.length}/${fens.length} 个局面里所有非首项分值都被抬平到 best —— quiescence 很可能在返回窗口边界：\n     ${details.join('\n     ')}`,
    );
  } else {
    pass('E16', `${fens.length}/${fens.length} 个局面里非首项分值都能被分出层次`);
  }
}

/* ------------------------------------------------------------------ */

if (failed > 0) {
  console.log(`\n❌ 引擎战术门禁失败：${failed} 条未通过`);
  process.exit(1);
}
console.log('\n✅ 引擎战术门禁全部通过（E1~E16）');
