/**
 * **残局关卡题库生成器** —— 从 Lichess 开放题库（CC0）里挑出 30 道残局题，
 * 用引擎逐个校验，产出 `src/lib/practice/puzzles/data.ts`。
 *
 * ## 为什么是「挑 + 校验」而不是「随机生成」
 *
 * 随机撒子产出的局面九成是垃圾（一秒杀 / 无解 / 白送子），
 * 而「可达性」「唯一解」「难度可控」三件事都只能靠引擎算出来。
 * 与其自己造题，不如从**已经被几百万玩家验过**的题库里挑，
 * 再用引擎把质量关再过一遍。
 *
 * ## 数据源
 *
 * `https://database.lichess.org/lichess_db_puzzle.csv.zst` —— **CC0**（公共领域贡献）。
 * 里面每行是一道题：FEN、UCI 着法串、评分、主题标签、原对局链接。
 *
 * ## 一个坑：FEN 是「对手走子之前」
 *
 * CSV 里的 `Moves` **第一手是对手的着法**，之后才是玩家的解法；
 * `FEN` 是对手走这手**之前**的局面。
 *
 * 所以玩家的起始局面 = FEN + Moves[0]，玩家解法 = Moves[1]、Moves[3]……
 * 直接把 FEN 当起始局面会把整道题错一步 —— 这是最容易踩的地方。
 *
 * ## 产物是**固化**的
 *
 * 生成出来的 `data.ts` 里，每一关都存着走通的着法线与每个节点的可接受着法集合。
 * 运行时**不碰引擎**：判定纯靠 chess.js 走线，难度可复现，浏览器零延迟。
 *
 * 用法：
 *   npx tsx scripts/generate-endgame-puzzles.ts [--limit=30] [--db=.cache/lichess_db_puzzle.csv.zst]
 *
 * 前置：本地要有题库文件（CC0，可自由下载）与 stockfish。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { StockfishBackend } from '../src/lib/engine/uci-backend';
import type { Puzzle, PuzzlePly, PuzzleOpponentNote } from '../src/lib/practice/puzzles/types';
import { isOpponentHopeless } from '../src/lib/practice/puzzles/types';
import { themeHint, themeLabel } from '../src/lib/practice/puzzles/themes';
import { materialCp } from '../src/lib/practice/puzzles/notes';

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** 要生成几关 */
const LIMIT = Number(argOf('limit', '300'));
/** 题库文件（zstd 压缩） */
const DB_PATH = argOf('db', path.join(process.cwd(), '.cache', 'lichess_db_puzzle.csv.zst'));
/** 产物路径 */
const OUT_PATH = argOf('out', path.join(process.cwd(), 'src', 'lib', 'practice', 'puzzles', 'data.ts'));

/**
 * **引擎搜索参数** —— 全是**固定深度**，不用时间预算。
 *
 * ## 为什么不用 `timeMs`
 *
 * `go depth N movetime M` 里引擎取**先到者**为准 ——
 * 深度先到就按深度走，所以 `timeMs` 实际上是个「上限」而不是「预算」。
 *
 * 实测 `timeMs=400, depth=12` 在残局上 **8ms 就返回**（深度先到），
 * 于是结果取决于**机器有多快**：换台电脑、同一个局面能给出不同的着法。
 *
 * ## 为什么必须可复现
 *
 * `data.ts` 是**提交进仓库**的产物。同一份题库跑两次必须得到同一份文件 ——
 * 否则每次重新生成都是一次无意义的 diff，还可能悄悄改掉关卡难度。
 *
 * 实测：**清哈希（`ucinewgame`）+ 固定 depth + 单线程** → 三次结果逐字相同；
 * 不清哈希则分数能漂二十几厘兵、着法也会变。
 */
const ENGINE_DEPTH = 12;
/**
 * 枚举候选着法时的深度。
 *
 * 比主搜索浅一档：枚举只需要「这手之后大概怎样」的**相对**排序。
 */
const MOVE_DEPTH = 10;
/**
 * 一次搜索里同时返回几个候选着法（MultiPV）。
 *
 * 取 16 是因为残局局面的合法着法极少（实测 5~9 个），
 * 一次搜索就能把**所有**选择都拿到手 —— 于是各着法的分值
 * 出自同一棵搜索树，**互相可比**。
 *
 * 这正是解说需要的：「这手比那手好多少」必须拿同一把尺子量。
 */
const MULTI_PV = 16;

/**
 * 候选池大小（浅校验前的池子）。
 *
 * 要够大才能在「评分档 × 主题 × 目标类型」三个维度上都有选择余地 ——
 * 实测浅校验的淘汰率约 20%，池子给小了凑不满 300 关。
 *
 * 300 关需要 ~1200 关的池子；给 6000 是因为**按难度分桶**之后
 * 还要再按主题配额筛一遍，池子小了某些主题会挑不出想要的难度。
 */
const POOL_SIZE = 6000;
/**
 * 同一个主题在候选池里最多出现几次。
 *
 * 30 关时这个上限是 10，扩到 300 关后必须放宽 ——
 * 「车残局」占候选的 33%，上限太低会把这个池子卡死。
 */
const MAX_PER_THEME_IN_POOL = 220;
/**
 * **同一个主题最多出几关**（最终选题时）。
 *
 * 30 关时是 2（几乎每关一个新主题）。300 关不可能每关一个新主题 ——
 * 38 个主题平均每类 8 关，但有些主题候选极少。
 *
 * 定 40 的理由：300 关里允许某个主题占到 13%，
 * 同时保证没有任何主题能吃掉整个题库。
 */
const MAX_PER_THEME = 40;

/**
 * **多步将杀关卡的下限**。
 *
 * 用户诉求：「有些残局是多步将杀」。
 *
 * 「多步」的口径：**玩家要走两步以上才能将死**（`mateIn >= 2`）。
 * 一步杀是「找到那一步」，多步杀是「连起来走对」—— 后者才是真正的训练价值。
 *
 * 没有这个下限，光靠主题抽样的话多步杀只占小头，
 * 玩家翻几关就全是「一步杀」，感觉不到「多步」这件事。
 */
const MIN_MULTI_MATE = 60;

/**
 * **多步将杀的最少手数**。
 *
 * `mateIn >= 3` 才是真正的「多步杀」—— 底线杀、闷杀大多是 3 手以上。
 */
const MATE_AT_LEAST_3 = 25;

/**
 * 「算走对」的三个阈值。
 *
 * - `MOVE_TOLERANCE` —— 候选着法比参考解差多少厘兵还算对（30 厘兵 ≈ 半兵）；
 * - `WIN_MIN_ADVANTAGE` —— 取胜目标下，玩家至少还得领先多少才算「还在赢」（100）；
 * - `DRAW_MAX_ADVANTAGE` —— 守和目标下，对手最多能领先多少还算「还守得住」（100）。
 */
const MOVE_TOLERANCE = 30;
const WIN_MIN_ADVANTAGE = 100;
const DRAW_MAX_ADVANTAGE = 100;

/**
 * **对手「已经守不住」的分值门槛**（对手视角，厘兵）。
 *
 * 阈值与判定规则都在 `src/lib/practice/puzzles/types.ts` ——
 * 生成器与单测共用同一份，避免两边写出两套不一样的标准。
 */

/** 题库筛选门槛 */
const MIN_PLAYS = 200;
const MIN_POPULARITY = 0;
const MIN_RATING = 800;
const MAX_RATING = 2600;
/**
 * 非王棋子数上限 —— 真正的残局不该还剩一大堆子。
 *
 * 定 7 是实测出来的：放到 10 时选出来的东西有一半是 8~10 子的**中残局**，
 * 那种局面子力还多、能靠子力直接赢，学不到「残局」的东西。
 */
const MAX_NON_KING_PIECES = 7;

/**
 * **残局主题（Lichess 主题词）** —— 用来挑题。
 *
 * ## 为什么这里是 38 个而不是 21 个
 *
 * 原来这份表只有 21 个「残局类型 / 残局手法」类主题，
 * 于是 **17 个杀法主题（底线杀、歌剧院杀、闷杀…）一关都选不上** ——
 * 它们在题库里有标签，但生成器的筛选表里没有，永远轮不到。
 *
 * 后果不只是「少几类主题」：
 * 杀法主题恰恰就是**多步将杀**的那些题（底线杀通常要三四手），
 * 不选它们 = 多步将杀关卡天生偏少。
 *
 * 现在这份表跟 `themes.ts` 的 38 个键**保持一致**。
 */
const ENDGAME_THEMES = [
  /* ---------- 残局类型 ---------- */
  'rookEndgame',
  'pawnEndgame',
  'bishopEndgame',
  'knightEndgame',
  'queenEndgame',
  'queenRookEndgame',
  /* ---------- 残局手法 ---------- */
  'zugzwang',
  'stalemate',
  'promotion',
  'underPromotion',
  'advancedPawn',
  'trappedPiece',
  'defensiveMove',
  'quietMove',
  'interference',
  'deflection',
  'clearance',
  'attraction',
  'intermezzo',
  'xRayAttack',
  /* ---------- 杀法（多步将杀的主力） ---------- */
  'backRankMate',
  'operaMate',
  'smotheredMate',
  'bodenMate',
  'hookMate',
  'killBoxMate',
  'dovetailMate',
  'epauletteMate',
  'cornerMate',
  'anastasiaMate',
  'balestraMate',
  'arabianMate',
  'blindSwineMate',
  'doubleBishopMate',
  'morphysMate',
  'swallowstailMate',
  'triangleMate',
  'vukovicMate',
];

/**
 * **选主题时的优先级** —— 一道题可能同时带多个主题标签，选哪个？
 *
 * ## 判据：**杀法 > 手法 > 类型**
 *
 * 一道「底线杀」的题，同时也可能带 `rookEndgame`。
 * 归到「车残局」没错，但归到「底线杀」**更具体** ——
 * 玩家按主题找题时，想找的是「底线杀」，不是「车残局」。
 *
 * 所以按这个顺序取**第一个命中**的主题。
 */
const THEME_PRIORITY = [
  /* 杀法最具体，排最前 */
  'backRankMate', 'operaMate', 'smotheredMate', 'bodenMate', 'hookMate',
  'killBoxMate', 'dovetailMate', 'epauletteMate', 'cornerMate', 'anastasiaMate',
  'balestraMate', 'arabianMate', 'blindSwineMate', 'doubleBishopMate',
  'morphysMate', 'swallowstailMate', 'triangleMate', 'vukovicMate',
  /* 其次是手法 */
  'underPromotion', 'stalemate', 'zugzwang', 'trappedPiece', 'defensiveMove',
  'quietMove', 'interference', 'deflection', 'clearance', 'attraction',
  'intermezzo', 'xRayAttack', 'advancedPawn', 'promotion',
  /* 最后才是宽泛的残局类型 */
  'queenRookEndgame', 'queenEndgame', 'rookEndgame', 'knightEndgame',
  'bishopEndgame', 'pawnEndgame',
];

/* ------------------------------------------------------------------ *
 * CSV 读取
 * ------------------------------------------------------------------ */

/**
 * 解析一行 CSV。
 *
 * 自己写而不用引库：题库的列固定（11 列），唯一要处理的就是**引号**——
 * `GameUrl` 之类字段可能带逗号。
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** CSV 的列序（见 database.lichess.org 的说明） */
const COL = {
  id: 0,
  fen: 1,
  moves: 2,
  rating: 3,
  ratingDeviation: 4,
  popularity: 5,
  nbPlays: 6,
  themes: 7,
  gameUrl: 8,
} as const;

/** 题库里的一行 */
interface RawPuzzle {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  popularity: number;
  nbPlays: number;
  themes: string[];
  gameUrl: string;
}

/** 流式读题库（zstd → CSV 行） */
async function* readRawPuzzles(dbPath: string): AsyncGenerator<RawPuzzle> {
  if (!existsSync(dbPath)) {
    throw new Error(`找不到题库文件：${dbPath}\n请先从 https://database.lichess.org/ 下载（CC0）。`);
  }
  // zstd -dc 流式解压：不落 1.1GB 的中间文件
  const proc = spawn('zstd', ['-dc', dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

  let header: string[] | null = null;
  try {
    for await (const line of rl) {
      if (!header) {
        header = parseCsvLine(line);
        continue;
      }
      if (!line) continue;
      const cols = parseCsvLine(line);
      if (cols.length < 9) continue;
      const themes = cols[COL.themes].split(' ').filter(Boolean);
      yield {
        id: cols[COL.id],
        fen: cols[COL.fen],
        moves: cols[COL.moves],
        rating: Number(cols[COL.rating]),
        popularity: Number(cols[COL.popularity]),
        nbPlays: Number(cols[COL.nbPlays]),
        themes,
        gameUrl: cols[COL.gameUrl],
      };
    }
    await new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          // 截断的题库切片也会走到这里 —— 那是**预期内**的，不算失败
          console.log(`  （题库读到末尾，zstd exit=${code}）`);
        }
        resolve();
      });
    });
  } finally {
    // 提前 break 时也要把 zstd 收掉 —— 否则它会一直占着管道
    proc.kill('SIGTERM');
  }
}

/* ------------------------------------------------------------------ *
 * 纯逻辑：把题库的一行变成一关
 * ------------------------------------------------------------------ */

/** 一个候选关卡（还没过引擎） */
interface Candidate {
  id: string;
  /** 玩家起始局面 */
  fen: string;
  /** 玩家执子 */
  side: 'w' | 'b';
  /** 主线（玩家着法与对手应手交替，从玩家那手开始） */
  line: PuzzlePly[];
  /** 主题（取残局主题里排最前的一个） */
  theme: string;
  nbPlays: number;
  popularity: number;
  gameUrl: string;
  /**
   * 终局的**原始提示**（非将死非和棋 = 'win'）。
   *
   * 注意这**不是**最终的目标标签 —— 最终目标由引擎按起始局面判定，
   * 见 `ShallowPuzzle.goal`。这里只用来做粗筛。
   */
  goal: 'mate' | 'win' | 'draw';
  /**
   * 难度档（1~5）—— **按 Lichess 的人类评分分档**。
   *
   * 为什么不用引擎给的评估分差当难度：
   * 引擎分差衡量的是「这着有多好」，不是「人有多难找到」。
   * 实测残局题里最优着法通常**压倒性**地好（分差几百厘兵），
   * 按分差分档的结果是 30 关里 25 关都落在同一档 —— 那不叫难度分级。
   *
   * Lichess 的评分（Glicko-2）是**几百万玩家实际做题成绩**算出来的，
   * 天生就是「人觉得难不难」。
   */
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** 题库给的原始评分 */
  rating: number;
  /** 终局局面 */
  finalFen: string;
}

/** 非王棋子数 */
function countNonKingPieces(game: Chess): number {
  let n = 0;
  for (const row of game.board()) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.type === 'k') continue;
      n += 1;
    }
  }
  return n;
}

/**
 * 把题库的一行解析成一关。
 *
 * 关键：**FEN 是对手走子之前** —— 先走掉对手那手，才轮到玩家。
 */
function toCandidate(raw: RawPuzzle): Candidate | null {
  const uciMoves = raw.moves.split(' ').filter(Boolean);
  if (uciMoves.length < 3) return null; // 至少：对手一步 + 玩家一步 + 对手一步

  let game: Chess;
  try {
    game = new Chess(raw.fen);
  } catch {
    return null; // 非法 FEN
  }
  if (game.turn() !== 'b' && game.turn() !== 'w') return null;
  if (countNonKingPieces(game) > MAX_NON_KING_PIECES) return null;

  // 对手那手（CSV 的 Moves[0]）
  const first = uciMoves[0];
  try {
    game.move(first);
  } catch {
    return null;
  }

  const side = game.turn();
  const startFen = game.fen();

  // 主线：玩家的着法与对手的应手交替
  const line: PuzzlePly[] = [];
  for (let i = 1; i < uciMoves.length; i += 1) {
    const uci = uciMoves[i];
    try {
      const played = game.move(uci);
      line.push({
        color: played.color,
        san: played.san,
        from: played.from,
        to: played.to,
        fen: game.fen(),
      });
    } catch {
      return null; // 这道题的着法串走不通 —— 丢弃
    }
  }

  // 主线必须从玩家那手开始
  if (line.length === 0 || line[0].color !== side) return null;

  // 终局类型
  let goal: Candidate['goal'];
  if (game.isCheckmate()) {
    goal = 'mate';
  } else if (game.isDraw()) {
    goal = 'draw';
  } else {
    goal = 'win';
  }

  // 主题：按**优先级**取第一个命中的（杀法 > 手法 > 类型）
  const theme = THEME_PRIORITY.find((t) => raw.themes.includes(t));
  if (!theme) return null;

  return {
    id: raw.id,
    fen: startFen,
    side,
    difficulty: difficultyBand(raw.rating),
    line,
    theme,
    rating: raw.rating,
    nbPlays: raw.nbPlays,
    popularity: raw.popularity,
    gameUrl: raw.gameUrl,
    goal,
    finalFen: game.fen(),
  };
}

/* ------------------------------------------------------------------ *
 * 引擎校验
 * ------------------------------------------------------------------ */

/** 引擎给的局面评估 */
interface Eval {
  /** 最佳着法（UCI） */
  best: string | null;
  /** 杀棋距离（手，走子方视角） */
  mateIn: number | null;
  /** 分值（厘兵，走子方视角） */
  score: number;
}

/**
 * **一个候选着法 + 它的评估**（MultiPV 的产物）。
 *
 * 所有候选出自**同一次搜索**，所以分值天然可比 ——
 * 这是解说（「这手比那手好多少」）和 `also` 判定共同的基础。
 */
interface ScoredMove {
  /** 着法（UCI） */
  uci: string;
  /** 标准记谱（SAN） */
  san: string;
  /** 分值（厘兵，走子方视角）；杀棋局面为 null */
  score: number | null;
  /** 杀棋距离（手，走子方视角）；不是杀棋局面时为 null */
  mateIn: number | null;
}

/**
 * 评估一个局面，返回**所有候选着法**及其分值。
 *
 * 只用**满血**引擎（limitStrength: false）—— 限强的着法会主动走平庸，
 * 拿来当「正解」会把题判错。
 *
 * `clearHash: true` —— 清哈希是为了**可复现**（见 ENGINE_DEPTH 的说明）。
 */
async function scoreMoves(
  sf: StockfishBackend,
  fen: string,
  color: 'w' | 'b',
  depth: number = ENGINE_DEPTH,
): Promise<ScoredMove[]> {
  const game = new Chess(fen);
  const rows = await sf.analyzeMulti(fen, color, {
    depth,
    multiPv: MULTI_PV,
    clearHash: true,
  });

  const out: ScoredMove[] = [];
  for (const row of rows) {
    const probe = new Chess(fen);
    let played;
    try {
      played = probe.move({
        from: row.move.from,
        to: row.move.to,
        ...(row.move.promotion ? { promotion: row.move.promotion } : {}),
      });
    } catch {
      continue;
    }
    out.push({
      uci: `${row.move.from}${row.move.to}${row.move.promotion ?? ''}`,
      san: played.san,
      score: row.scoreCp,
      mateIn: row.mateIn,
    });
  }
  return out;
}

/**
 * 评估一个局面（只要最佳着法与分值）。
 */
async function evaluate(
  sf: StockfishBackend,
  fen: string,
  color: 'w' | 'b',
  depth: number = ENGINE_DEPTH,
): Promise<Eval> {
  const rows = await scoreMoves(sf, fen, color, depth);
  const best = rows[0];
  return {
    best: best ? best.uci : null,
    mateIn: best ? best.mateIn : null,
    score: best?.score ?? 0,
  };
}

/** 把 SAN 反解成 UCI（用于跟引擎给的着法比对） */
function sanToUci(fen: string, san: string): string | null {
  const game = new Chess(fen);
  try {
    const played = game.move(san);
    return `${played.from}${played.to}${played.promotion ?? ''}`;
  } catch {
    return null;
  }
}

/**
 * 算出这一手之后，**还有哪些着法也算走对**。
 *
 * ## 判据：以**参考解**为基准
 *
 * 一个着法算走对，当且仅当：
 *   1. 走完这手之后，**目标仍然成立**（还是取胜 / 还是守得住 / 还是能杀）；
 *   2. 走完这手之后的局面**不比参考解更差**（容差 30 厘兵）。
 *
 * ## 为什么用「相对参考解」而不是「绝对阈值」
 *
 * 绝对阈值（像「玩家还得领先 300 厘兵」）有两个致命问题：
 *   - 阈值定高了，**连参考解自己都过不了** —— 实测 30 关里 83 个玩家节点，
 *     可接受着法集合**全是空的**（正解自己被排除）；
 *   - 阈值定低了，白送子的着法也会被算对。
 *
 * 相对判据没有这个问题：参考解跟它自己比，一定通过。
 *
 * @param refSan 参考解（这一手「正确」的着法）
 */
async function acceptedMoves(
  sf: StockfishBackend,
  fen: string,
  goal: Puzzle['goal'],
  refSan: string,
): Promise<string[]> {
  const game = new Chess(fen);
  const side = game.turn();
  /*
   * 一次 MultiPV 搜索拿到**所有**合法着法及其分值。
   *
   * 旧写法是「逐个着法单独 evaluate」—— 慢，而且更糟：
   * 每次单独搜索都带着上一遍残留的哈希表，
   * 同一着法两次评估能差二十几厘兵，于是「比参考解差不差 30 厘兵」
   * 这个判据在噪声上做比较，结果不可靠。
   *
   * MultiPV 的所有分值出自**同一棵搜索树**，判定才站得住。
   */
  const rows = await scoreMoves(sf, fen, side, MOVE_DEPTH);
  if (rows.length === 0) return [];

  /*
   * MultiPV 给的是**走子方视角**的评估。
   * 判定要用**玩家视角**（玩家走完这手之后占优多少），所以取负。
   */
  const ref = rows.find((e) => e.san === refSan);
  if (!ref) return [];
  /** 参考解给玩家带来的优势（厘兵） */
  const refAdv = -(ref.score ?? 0);
  /** 参考解的杀棋手数（玩家视角）；不是杀棋局面时是 null */
  const refMate = ref.mateIn !== null && ref.mateIn > 0 ? ref.mateIn : null;

  const out: string[] = [];
  for (const e of rows) {
    const adv = -(e.score ?? 0);
    if (goal === 'mate') {
      // 杀棋：候选着法也得能杀，而且不能比参考解慢
      if (refMate === null) continue;
      if (e.mateIn !== null && e.mateIn > 0 && e.mateIn <= refMate) out.push(e.san);
      continue;
    }
    if (goal === 'draw') {
      // 守和：走完之后对方不能占优
      if (adv > DRAW_MAX_ADVANTAGE) continue;
    } else if (adv < WIN_MIN_ADVANTAGE) {
      // 取胜：走完之后玩家还得有优势
      continue;
    }
    // 不比参考解差
    if (adv >= refAdv - MOVE_TOLERANCE) out.push(e.san);
  }
  return out;
}

/**
 * 算出**对手这一手**的解说数据。
 *
 * ## 为什么需要它
 *
 * 残局里对手已败时，它的「最优应手」往往就是**看着像白送、
 * 其实能把杀棋拖最久**的那手 —— 不解释的话，玩家会以为对手在犯傻
 * （用户原话：「有些走棋在我看来简直就是让我白白将杀」）。
 *
 * ## 算什么
 *
 * 用**一次 MultiPV 搜索**拿到这个局面下对手的所有着法及分值，
 * 于是能同时回答：
 *   - 对手有几手可选（`legalCount`，来自 chess.js，不是引擎）；
 *   - 对手是不是已经必败（引擎给的杀棋距离）；
 *   - 这一手是不是最优（跟最佳着法比分值）；
 *   - 这一手把杀棋拖到几手（跟最佳着法比杀棋距离）；
 *   - 这一手牺牲了多少子力（走前走后的子力差）。
 *
 * **不做任何着法替换** —— 对手走什么就是什么，这里只解释。
 */
async function opponentNote(
  sf: StockfishBackend,
  fen: string,
  opponentSide: 'w' | 'b',
  playedSan: string,
): Promise<PuzzleOpponentNote | null> {
  const game = new Chess(fen);
  const legal = game.moves({ verbose: true });

  /* 对手在这个局面的所有着法及分值（对手视角） */
  const rows = await scoreMoves(sf, fen, opponentSide, ENGINE_DEPTH);
  if (rows.length === 0) return null;

  const best = rows[0];
  const played = rows.find((r) => r.san === playedSan);

  /*
   * 杀棋距离的符号约定：
   *   MultiPV 给的是**走子方视角** —— 对手是走子方，
   *   所以 `mateIn > 0` = 对手 N 手内能杀玩家；`mateIn < 0` = 对手 N 手内被杀。
   *
   * 解说里说的是「玩家几步能杀」= 对手被杀的步数 = -mateIn。
   */
  const playedKill = played?.mateIn !== null && played?.mateIn !== undefined && played.mateIn < 0 ? -played.mateIn : null;
  const bestKill = best.mateIn !== null && best.mateIn < 0 ? -best.mateIn : null;

  /*
   * 对手是不是已经守不住了 —— **以对手走完这一手之后的局面为准**。
   *
   * 两种「守不住」：
   *   1. **被杀棋**（`playedKill !== null`）—— 硬性的，几手内就要死；
   *   2. **子力层面已败**（分值大劣）—— 软性的，说不准几步，但已经输定了。
   *
   * 只认第 1 种会漏掉很多场景：残局里「必败」常常是子力问题，
   * 没有强制杀，但玩家已经稳稳赢 —— 那时对手的最优应手同样像在拖延。
   *
   * **为什么按「走完之后」而不是「最优着法之后」**：
   * note 里的字段全都描述**对手走完这一手之后**的局面。
   * 混进「引擎最佳着法之后」的局面，标志就跟事实对不上了 ——
   * 比如对手这手逃掉了杀棋（`playedKill` 为空），
   * 但引擎的最佳着法仍在那条杀棋线上，
   * 那时局面既不是「无解」也不是「输定」，标志是假的。
   *
   * 判定走**共享实现**（`isOpponentHopeless`）——
   * 生成器与单测必须用同一份规则，否则单测等于拿生成器的错当标准。
   */
  const hopeless = isOpponentHopeless({
    mateInAfter: playedKill,
    scoreAfter: played?.score ?? null,
  });

  /*
   * 这一手是不是最优 —— **必须按「对手视角」比**，不是走子方视角。
   *
   * 这里是「拖时间」的关键：杀棋线上对手的着法分值全是 mate，
   * 光看分值分不出「拖 7 手」和「拖 3 手」。
   * 对手越能把杀棋拖久越好 —— 所以比较时取反（走子方越差 = 对手越好）。
   *
   * **分值口径带 30 厘兵容差**（跟 `MOVE_TOLERANCE` 同一个尺子）：
   * 引擎给的是近似分值，几十厘兵的差异是搜索噪声而不是真实差距 ——
   * 不带容差的话，几乎每一手都会被判成「不是最优」，解说满屏都是
   * 「更好的走法是 X」，反而没有信息量。
   */
  const isBest = played ? isBestForOpponent(played, best) : false;

  /* 这一手牺牲了多少子力：走之前 vs 走之后的对手子力 */
  const before = materialCp(fen, opponentSide);
  const probe = new Chess(fen);
  let after = before;
  try {
    probe.move(playedSan);
    after = materialCp(probe.fen(), opponentSide);
  } catch {
    /* 着法走不通就当没牺牲 */
  }
  const sacrificedCp = Math.max(0, before - after);

  return {
    legalCount: legal.length,
    hopeless,
    isBest,
    mateInAfter: playedKill,
    scoreAfter: played?.score ?? null,
    /*
     * `bestSan` = 「另一手更好」—— 只在**这一手确实不是最优**时才有意义。
     *
     * 判成最优（容差内）时它必须是 null：
     * 一边说「这一手是最优的」，一边又指出「更好的走法是 Kf2」，
     * 数据自己跟自己打架（单测会当场报「自相矛盾」）。
     */
    bestSan: !isBest && best.san !== playedSan ? best.san : null,
    bestScoreAfter: best.score,
    bestMateInAfter: bestKill,
    sacrificedCp,
  };
}

/**
 * 这一手对对手是不是**（近似）最优**。
 *
 * ## 视角
 *
 * 对手是**走子方**，所以 `mateIn` 的符号含义是：
 *   - `mateIn > 0` = 对手 N 手内能杀玩家；
 *   - `mateIn < 0` = 对手 N 手内**被杀**。
 *
 * 分值同理：`score` 是**对手视角** —— 负数越大 = 对手越惨。
 *
 * ## 杀棋距离优先，而且不带容差
 *
 * 杀棋局面里 `score cp` 是 null —— 「3 手被杀」和「7 手被杀」在分值上长得一样。
 * 而对防守方来说，「7 手被杀」好得多 —— 这正是「对手在拖时间」的量化含义。
 *
 * 「拖 7 手」和「拖 3 手」是真的差 4 手，不是噪声，所以这一段不带容差。
 *
 * ## 为什么分值那段要容差
 *
 * 引擎给的是**近似**分值：同一个局面搜两次，分数能差十几厘兵
 * （搜索树的剪枝路径不完全相同）。
 * 用严格比较的话，几乎每一手都会被判成「不是最优」——
 * 解说会变成满屏「更好的走法是 X」，反而没有信息量。
 */
function isBestForOpponent(played: ScoredMove, best: ScoredMove): boolean {
  const pm = played.mateIn;
  const bm = best.mateIn;

  // ---- 杀棋距离：差几手是真的差 ----
  if (pm !== null && bm !== null) {
    /*
     * 都是被杀：对手被拖得越久越好。
     *
     * `mateIn` 越负 = 死得越晚（-7 手后死 比 -3 手后死 更「好」），
     * 所以对手更偏好 `mateIn` **更小**的那个。
     */
    if (pm < 0 && bm < 0) return pm <= bm;
    // 都能杀：杀得越快越好
    if (pm > 0 && bm > 0) return pm <= bm;
    // 一个能杀、一个被杀：能杀的当然更好
    return pm > 0;
  }
  // 只有一边是杀棋局面：分值不可比，直接按「谁在杀」判断
  if (pm !== null) return pm > 0;
  if (bm !== null) return bm < 0;

  // ---- 普通局面：分值差在容差内就算一样好 ----
  const gap = (played.score ?? 0) - (best.score ?? 0); // 对手视角：越大越好
  if (gap >= 0) return true;
  return Math.abs(gap) <= MOVE_TOLERANCE;
}

/** 浅校验通过的一关 */
interface ShallowPuzzle {
  candidate: Candidate;
  /** 杀棋手数；不是杀棋局面时是 null */
  mateIn: number | null;
  /** 由引擎判定的目标 */
  goal: Puzzle['goal'];
}

/** 终局是不是和棋 */
function isDrawFen(fen: string): boolean {
  try {
    return new Chess(fen).isDraw();
  } catch {
    return false;
  }
}

/** 终局是不是绝杀 */
function isCheckmateFen(fen: string): boolean {
  try {
    return new Chess(fen).isCheckmate();
  } catch {
    return false;
  }
}

/** 一个着法之后的评估 */
interface MoveEval {
  san: string;
  /** 分值（对手视角，厘兵） */
  score: number;
  /** 杀棋距离（对手视角，手） */
  mateIn: number | null;
}

/**
 * 人类评分 → 难度档。
 *
 * 档位边界实测过：候选池里 5 档的分布是
 * 969 / 1545 / 1329 / 1084 / 515 —— 每档都够挑。
 */
function difficultyBand(rating: number): 1 | 2 | 3 | 4 | 5 {
  if (rating < 1100) return 1;
  if (rating < 1500) return 2;
  if (rating < 1900) return 3;
  if (rating < 2300) return 4;
  return 5;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('▸ 读题库…');
  const candidates: Candidate[] = [];
  let scanned = 0;

  for await (const raw of readRawPuzzles(DB_PATH)) {
    scanned += 1;
    if (raw.nbPlays < MIN_PLAYS) continue;
    if (raw.popularity < MIN_POPULARITY) continue;
    if (raw.rating < MIN_RATING || raw.rating > MAX_RATING) continue;
    const candidate = toCandidate(raw);
    if (!candidate) continue;
    candidates.push(candidate);
    /*
     * 题库有六百多万行；够挑了就停（省时间）。
     *
     * 300 关要用的候选远多于 30 关 —— 光靠「前 N 个被玩最多的」不够，
     * 因为那些题集中在中低难度、少数几个主题上。
     * 所以要多扫（20 倍的候选量），把选择余地留给后面的分桶。
     */
    if (candidates.length >= LIMIT * 20) break;
    if (scanned % 500_000 === 0) console.log(`  已扫 ${scanned} 行，候选 ${candidates.length}`);
  }

  console.log(`▸ 扫了 ${scanned} 行，候选 ${candidates.length} 关`);

  if (candidates.length === 0) {
    throw new Error('没有候选 —— 题库格式或筛选条件变了');
  }

  /*
   * 排序要**确定**：同一份题库跑两次必须得到同样的 30 关。
   * 先按「被玩次数」降序（质量信号），再按 id 升序（打破并列）。
   */
  candidates.sort((a, b) => (b.nbPlays - a.nbPlays) || a.id.localeCompare(b.id));

  /* --- 第一阶段：候选池（主题分散） --- */
  const pool = selectBalanced(candidates, POOL_SIZE);
  console.log(`▸ 候选池 ${pool.length} 关（目标 ${LIMIT} 关）`);

  /*
   * **单线程**是硬要求 —— 可复现的前提。
   *
   * 多线程搜索的剪枝顺序取决于线程调度，同一深度会给出不同的分数与着法。
   * 实测 `threads: 2` 时同一局面连搜三次，分数在 -433 ~ -450 之间漂、
   * 着法在 g6h6 / g6g7 之间跳；`threads: 1` + 清哈希则**逐字相同**。
   *
   * 离线生成慢一点无所谓（跑一次几十分钟），但产物必须每次一样。
   */
  const sf = new StockfishBackend({ threads: 1 });
  await sf.start();

  /* --- 第二阶段：浅校验（每关一次引擎搜索） --- *
   * 只做两件事：确认引擎的最佳着法就是题库的解（不一致就淘汰），
   * 以及拿到杀棋手数。这一步便宜，能把大半不合格的候选刷掉。
   */
  console.log('▸ 浅校验…');
  const shallow: ShallowPuzzle[] = [];
  let droppedLost = 0;
  let droppedMismatch = 0;
  for (const candidate of pool) {
    /*
     * 线必须存在，且**从玩家那手开始**。
     *
     * 题库 CSV 的第一手就是玩家的正解，但这条线后面被当成
     * 「玩家走一步 → 对手应一步」交替使用 ——
     * 第一手不是玩家的话，解说会挂到错误的局面上（对手节点的局面算错）。
     */
    if (!candidate.line || candidate.line.length === 0) continue;
    if (candidate.line[0].color !== candidate.side) continue;
    const startEval = await evaluate(sf, candidate.fen, candidate.side);

    const firstUci = sanToUci(candidate.fen, candidate.line[0].san);
    if (!firstUci) continue;
    // 引擎有更好的着法 —— 这一关的「正解」存疑，淘汰
    if (startEval.best && startEval.best !== firstUci) {
      droppedMismatch += 1;
      continue;
    }

    /*
     * 目标由**引擎**说了算。
     *
     * 这里曾经埋过一个很隐蔽的错：目标只按「终局是不是将死/和棋」来分，
     * 于是「非将死非和棋」一律算「取胜」—— 可玩家明明是**必败**的那一方。
     * 那种关卡界面上写着「黑方取胜」，实际走到底玩家是被将死的。
     *
     * 所以现在按**起始局面**的引擎评估来定：
     *   - 能杀   → 'mate'（记杀棋手数）；
     *   - 占优   → 'win'；
     *   - 均势   → 'draw'（守和）；
     *   - 必败 / 被将死 → 直接淘汰（练习题不该是必败局）。
     */
    const playerMates = startEval.mateIn !== null && startEval.mateIn > 0;
    const playerMated = startEval.mateIn !== null && startEval.mateIn < 0;
    if (playerMated || startEval.score <= -WIN_MIN_ADVANTAGE) {
      droppedLost += 1;
      continue;
    }

    let goal: Puzzle['goal'];
    let mateIn: number | null = null;
    if (playerMates) {
      goal = 'mate';
      mateIn = startEval.mateIn;
    } else if (startEval.score >= WIN_MIN_ADVANTAGE) {
      goal = 'win';
    } else {
      goal = 'draw';
    }

    // 'draw' 目标要求终局**真的是和棋**（客户端的 goalReached 就按这个判）
    if (goal === 'draw' && !isDrawFen(candidate.finalFen)) {
      droppedLost += 1;
      continue;
    }
    // 'win' 目标要求终局不是和棋（否则目标标签与终局对不上）
    if (goal === 'win' && isDrawFen(candidate.finalFen)) {
      droppedLost += 1;
      continue;
    }
    // 'mate' 目标要求终局真的是绝杀
    if (goal === 'mate' && !isCheckmateFen(candidate.finalFen)) {
      droppedMismatch += 1;
      continue;
    }

    shallow.push({ candidate, mateIn, goal });

    /*
     * 进度输出 —— 这一步要跑二十几分钟，**没有进度就像卡死了**。
     *
     * 只打到 stdout，**不进产物**，所以不影响 `data.ts` 的可复现性。
     */
    if (shallow.length % 200 === 0) {
      console.log(`  浅校验 ${shallow.length}/${pool.length}（已淘汰 ${droppedMismatch + droppedLost}）`);
    }
  }
  console.log(
    `▸ 浅校验通过 ${shallow.length} 关（解法不一致淘汰 ${droppedMismatch}，必败/目标不符淘汰 ${droppedLost}）`,
  );

  /* --- 第三阶段：按难度档选最终 30 关 --- */
  const finalists = pickFinalists(shallow, LIMIT);
  console.log(`▸ 决赛圈 ${finalists.length} 关`);

  /* --- 第四阶段：完整校验（可接受着法集合 + 对手解说） --- */
  console.log('▸ 完整校验…');
  const puzzles: Puzzle[] = [];
  let index = 0;
  for (const { candidate, mateIn, goal } of finalists) {
    index += 1;
    if (index % 10 === 0) console.log(`  已验 ${index}/${finalists.length} 关`);

    // 每个玩家节点算可接受着法集合
    const line: PuzzlePly[] = [];
    for (const ply of candidate.line) {
      const step: PuzzlePly = {
        color: ply.color,
        san: ply.san,
        from: ply.from,
        to: ply.to,
        fen: ply.fen,
      };
      if (ply.color === candidate.side) {
        // 这一手之后还剩几手预算（杀棋距离按「手」算，玩家每走一手减一）
        const nodeFen = line.length === 0 ? candidate.fen : line[line.length - 1].fen;
        const also = await acceptedMoves(sf, nodeFen, goal, ply.san);
        step.also = also.filter((san) => san !== ply.san);
      } else {
        /*
         * **对手这一手**：算解说数据。
         *
         * 局面 = 上一步走完的局面（玩家那手之后轮到对手）。
         * 第一次迭代时上一步还不存在，那节点就是起始局面。
         */
        const nodeFen = line.length === 0 ? candidate.fen : line[line.length - 1].fen;
        const opponentSide = ply.color;
        const note = await opponentNote(sf, nodeFen, opponentSide, ply.san);
        if (note) step.note = note;
      }
      line.push(step);
    }

    /*
     * 难度：以**人类评分档**为准。
     *
     * 杀棋题再取一个下限 —— 「几步杀」是题目的硬事实：
     * 一道 5 手杀的题不管评分多少，都不该被标成「入门」。
     */
    const difficulty: 1 | 2 | 3 | 4 | 5 =
      goal === 'mate' && mateIn !== null
        ? (Math.min(5, Math.max(candidate.difficulty, mateIn)) as 1 | 2 | 3 | 4 | 5)
        : candidate.difficulty;

    puzzles.push({
      id: candidate.id,
      name: puzzleName(candidate),
      en: candidate.id,
      theme: candidate.theme,
      difficulty,
      fen: candidate.fen,
      side: candidate.side,
      goal,
      ...(mateIn !== null ? { mateIn } : {}),
      line,
      points: buildPoints(candidate, mateIn),
      source: {
        name: 'Lichess 开放题库',
        url: candidate.gameUrl || `https://lichess.org/training/${candidate.id}`,
        license: 'CC0',
      },
    });
  }

  sf.close();
  console.log(`▸ 完整校验 ${puzzles.length} 关`);

  if (puzzles.length === 0) {
    throw new Error('引擎校验后一关都不剩 —— 判据太严了');
  }
  console.log(
    `▸ 最终 ${puzzles.length} 关 · 难度分布 ${JSON.stringify(difficultyHistogram(puzzles))}`,
  );

  /*
   * 按难度从易到难排。
   *
   * 候选是按「被玩次数」挑出来的，难度是乱的 —— 排序之后关卡才是**一条路**，
   * 玩家从第 1 关往后走，难度自然递增。
   * 同难度内按 id 排，保证**每次生成结果一样**。
   */
  puzzles.sort((a, b) => (a.difficulty - b.difficulty) || a.id.localeCompare(b.id));

  /* --- 写产物 --- */
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, renderData(puzzles), 'utf8');
  console.log(`▸ 已写出 ${OUT_PATH}（${puzzles.length} 关）`);
}

/** 难度分布直方图 */
function difficultyHistogram(puzzles: Puzzle[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of puzzles) out[p.difficulty] = (out[p.difficulty] ?? 0) + 1;
  return out;
}

/**
 * 定下最终的几关。
 *
 * ## 四条约束同时满足
 *
 *   1. **难度铺开** —— 1~5 档都要有，玩家从第 1 关往后走难度自然递增；
 *   2. **主题覆盖** —— 每个出现的类别都要有，且同一主题不能吃掉整个题库；
 *   3. **多步将杀配额** —— 至少 `MIN_MULTI_MATE` 关是「玩家要走两步以上」；
 *   4. **两类目标都有** —— 「将死」和「取胜」都出现（残局教学两头都不能缺）。
 *
 * ## 做法：三轮挑选
 *
 * - **第一轮**：按主题轮转，每个主题先各出一关 —— 保证「每个类别都有」，
 *   而不是「车残局占一半、其余三类各一关」。
 * - **第二轮**：把多步将杀的配额补足（不够就放宽主题上限）。
 * - **第三轮**：剩下的名额按难度档轮流补，凑满 limit。
 *
 * 每一轮内部都按「被玩次数」降序挑（被玩得多 = 质量高），
 * 相同则按 id 升序 —— 保证结果确定。
 */
function pickFinalists(shallow: ShallowPuzzle[], limit: number): ShallowPuzzle[] {
  const themeUse = new Map<string, number>();
  const goalUse: Record<Puzzle['goal'], number> = { mate: 0, win: 0, draw: 0, promote: 0 };
  const picked: ShallowPuzzle[] = [];
  const pickedIds = new Set<string>();

  /** 已经被选走的（按 id 记，防止重复选同一关） */
  const take = (s: ShallowPuzzle): boolean => {
    if (pickedIds.has(s.candidate.id)) return false;
    pickedIds.add(s.candidate.id);
    picked.push(s);
    themeUse.set(s.candidate.theme, (themeUse.get(s.candidate.theme) ?? 0) + 1);
    goalUse[s.goal] += 1;
    return true;
  };

  /*
   * 候选按「质量」排序：被玩次数降序（质量信号），再按 id 升序（打破并列）。
   * 排序确定 —— 同一份题库跑两次必须得到同样的结果。
   */
  const byQuality = [...shallow].sort(
    (a, b) =>
      (b.candidate.nbPlays - a.candidate.nbPlays) || a.candidate.id.localeCompare(b.candidate.id),
  );

  /* --- 第一轮：按主题轮转，每个主题先各出一关 --- */
  const byTheme = new Map<string, ShallowPuzzle[]>();
  for (const s of byQuality) {
    const list = byTheme.get(s.candidate.theme) ?? [];
    list.push(s);
    byTheme.set(s.candidate.theme, list);
  }
  // 主题顺序按**候选数降序** —— 先照顾候选多的类别，保证轮转一圈就能填满
  const themeOrder = [...byTheme.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([t]) => t);

  for (const theme of themeOrder) {
    if (picked.length >= limit) break;
    const list = byTheme.get(theme) ?? [];
    // 每个主题先出一关：挑「被玩最多」的那关
    for (const s of list) {
      if (take(s)) break;
    }
  }

  /* --- 第二轮：补足多步将杀配额 --- */
  const multiMate = (s: ShallowPuzzle): boolean =>
    s.goal === 'mate' && s.mateIn !== null && s.mateIn >= 2;
  const multiMate3 = (s: ShallowPuzzle): boolean =>
    s.goal === 'mate' && s.mateIn !== null && s.mateIn >= 3;

  let multiCount = picked.filter(multiMate).length;
  let multi3Count = picked.filter(multiMate3).length;

  for (const s of byQuality) {
    if (multiCount >= MIN_MULTI_MATE && multi3Count >= MATE_AT_LEAST_3) break;
    if (picked.length >= limit) break;
    if (pickedIds.has(s.candidate.id)) continue;
    const needMulti = multiCount < MIN_MULTI_MATE;
    const needMulti3 = multi3Count < MATE_AT_LEAST_3;
    if (!multiMate(s) && !multiMate3(s)) continue;
    // 主题上限在这里**放宽** —— 配额优先于均衡
    if ((themeUse.get(s.candidate.theme) ?? 0) >= MAX_PER_THEME) continue;
    if (take(s)) {
      if (multiMate(s)) multiCount += 1;
      if (multiMate3(s)) multi3Count += 1;
    }
  }

  /* --- 第三轮：按难度档轮流补满 --- */
  const buckets = new Map<number, ShallowPuzzle[]>();
  for (const s of byQuality) {
    if (pickedIds.has(s.candidate.id)) continue;
    const list = buckets.get(s.candidate.difficulty) ?? [];
    list.push(s);
    buckets.set(s.candidate.difficulty, list);
  }

  for (const list of buckets.values()) {
    list.sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
  }

  for (let round = 0; picked.length < limit; round += 1) {
    let progressed = false;
    for (let band = 1; band <= 5 && picked.length < limit; band += 1) {
      const list = buckets.get(band);
      if (!list || list.length === 0) continue;
      const idx = list.findIndex((s) => {
        if (pickedIds.has(s.candidate.id)) return false;
        if ((themeUse.get(s.candidate.theme) ?? 0) >= MAX_PER_THEME) return false;
        // 同一档里，「将死」与「取胜」交替 —— 两类都要有
        const g = s.goal;
        const other = g === 'mate' ? 'win' : 'mate';
        if (goalUse[g] > goalUse[other]) return false;
        return true;
      });
      const chosen = idx === -1
        ? list.findIndex(
            (s) =>
              !pickedIds.has(s.candidate.id) &&
              (themeUse.get(s.candidate.theme) ?? 0) < MAX_PER_THEME,
          )
        : idx;
      if (chosen === -1) continue;
      const s = list.splice(chosen, 1)[0];
      if (take(s)) progressed = true;
    }
    if (!progressed) break;
  }

  return picked;
}

/** 关卡名（中文） */
function puzzleName(candidate: Candidate): string {
  return `${themeLabel(candidate.theme)} · ${candidate.side === 'w' ? '白方' : '黑方'}行棋`;
}

/** 通关后显示的要点 */
function buildPoints(candidate: Candidate, mateIn: number | null): string[] {
  const points = [themeHint(candidate.theme)];
  if (mateIn !== null) {
    points.push(`这一关是 ${mateIn} 手内将死 —— 杀棋的关键往往是**先堵住对手王的逃格**，而不是急着将军。`);
  } else {
    points.push('这一关不用急着吃子 —— **把对方的王逼到角落**，子力优势才兑现得出来。');
  }
  return points;
}

/**
 * 选候选池：主题尽量均衡，**且要覆盖到稀有的主题**。
 *
 * ## 为什么不能只按「被玩次数」取前 N
 *
 * 实测（全量库 6.19M 行）：按被玩次数排序取前 10000 个，
 * 只覆盖到 **18 个主题**、难度 5 档只有 **2 个** ——
 * 高热度的题集中在「车残局/兵残局」和中低难度上。
 *
 * 直接这么取，后面再怎么分桶也补不出稀有主题。
 *
 * ## 做法：主题轮转
 *
 * 先把候选按主题分桶，**每个主题轮流出一关**，
 * 直到池子填满 —— 这样稀有主题（哪怕只有几十个候选）
 * 也能在池子里占到自己那份。
 *
 * 桶内按「被玩次数」降序 —— 同一主题里挑质量最高的。
 */
function selectBalanced(candidates: Candidate[], limit: number): Candidate[] {
  const picked: Candidate[] = [];
  const byTheme = new Map<string, Candidate[]>();

  for (const c of candidates) {
    const list = byTheme.get(c.theme) ?? [];
    list.push(c);
    byTheme.set(c.theme, list);
  }
  // 桶内按质量排序（被玩次数降序，再按 id 升序保证结果确定）
  for (const list of byTheme.values()) {
    list.sort((a, b) => (b.nbPlays - a.nbPlays) || a.id.localeCompare(b.id));
  }

  // 主题顺序：候选多的先来，但**稀有主题也必须轮到**
  const themeOrder = [...byTheme.keys()].sort((a, b) => {
    const la = byTheme.get(a)?.length ?? 0;
    const lb = byTheme.get(b)?.length ?? 0;
    return lb - la || a.localeCompare(b);
  });

  const cursor = new Map<string, number>();
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const theme of themeOrder) {
      if (picked.length >= limit) break;
      const list = byTheme.get(theme);
      if (!list) continue;
      const at = cursor.get(theme) ?? 0;
      // 每个主题在池子里的上限
      if (at >= MAX_PER_THEME_IN_POOL) continue;
      // 桶已经取完（上限比桶大小还大时会出现）—— 不能越界
      const chosen = list[at];
      if (!chosen) {
        cursor.set(theme, at + 1);
        continue;
      }
      cursor.set(theme, at + 1);
      picked.push(chosen);
      progressed = true;
    }
  }
  return picked;
}

/** 渲染产物（TS 源码） */
function renderData(puzzles: Puzzle[]): string {
  const body = puzzles
    .map((p) => {
      const line = p.line
        .map((ply) => {
          const note = ply.note
            ? `, note: { legalCount: ${ply.note.legalCount}, hopeless: ${ply.note.hopeless}, isBest: ${ply.note.isBest}, mateInAfter: ${ply.note.mateInAfter ?? 'null'}, scoreAfter: ${ply.note.scoreAfter ?? 'null'}, bestSan: ${ply.note.bestSan ? `'${ply.note.bestSan}'` : 'null'}, bestScoreAfter: ${ply.note.bestScoreAfter ?? 'null'}, bestMateInAfter: ${ply.note.bestMateInAfter ?? 'null'}, sacrificedCp: ${ply.note.sacrificedCp} }`
            : '';
          return `    { color: '${ply.color}', san: '${ply.san}', from: '${ply.from}', to: '${ply.to}', fen: '${ply.fen}'${
            ply.also && ply.also.length > 0
              ? `, also: [${ply.also.map((s) => `'${s}'`).join(', ')}]`
              : ''
          }${note} },`;
        })
        .join('\n');
      const points = p.points.map((pt) => `    '${pt.replace(/'/g, "\\'")}',`).join('\n');
      return `  {
    id: '${p.id}',
    name: '${p.name.replace(/'/g, "\\'")}',
    en: '${p.en}',
    theme: '${p.theme}',
    difficulty: ${p.difficulty},
    fen: '${p.fen}',
    side: '${p.side}',
    goal: '${p.goal}',
${p.mateIn !== undefined ? `    mateIn: ${p.mateIn},\n` : ''}    line: [
${line}
    ],
    points: [
${points}
    ],
    source: {
      name: '${p.source.name}',
      url: '${p.source.url ?? ''}',
      license: '${p.source.license ?? ''}',
    },
  },`;
    })
    .join('\n');

  return `/**
 * **残局关卡题库** —— 由 \`scripts/generate-endgame-puzzles.ts\` 生成，**不要手改**。
 *
 * 改了想重新生成：改生成器，然后跑
 *   npx tsx scripts/generate-endgame-puzzles.ts
 *
 * 数据来源：Lichess 开放题库（CC0）。
 *
 * ## 每关存的是什么
 *
 *   - \`fen\`     —— **玩家起始局面**（轮到玩家走）。注意：题库原始 FEN 是
 *                    「对手走子之前」的局面，生成器已经推进一步了。
 *   - \`line\`    —— 走通的着法线，玩家着法与对手应手交替，从玩家那手开始。
 *   - \`also\`    —— 玩家这一手的**等价正解**（走这些也算对）。
 *   - \`goal\`    —— 目标；\`mate\` 时 \`mateIn\` 是杀棋手数。
 *
 * 运行时**不依赖引擎**：判定全靠 chess.js 走线。
 */
import type { Puzzle } from './types';

export const PUZZLES: Puzzle[] = [
${body}
];
`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
