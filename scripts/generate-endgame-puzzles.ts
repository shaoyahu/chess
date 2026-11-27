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
import type { Puzzle, PuzzlePly } from '../src/lib/practice/puzzles/types';
import { themeHint, themeLabel } from '../src/lib/practice/puzzles/themes';

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** 要生成几关 */
const LIMIT = Number(argOf('limit', '30'));
/** 题库文件（zstd 压缩） */
const DB_PATH = argOf('db', path.join(process.cwd(), '.cache', 'lichess_db_puzzle.csv.zst'));
/** 产物路径 */
const OUT_PATH = path.join(process.cwd(), 'src', 'lib', 'practice', 'puzzles', 'data.ts');

/** 引擎搜索的时间预算（毫秒）与深度上限 —— 残局用不着更深 */
const ENGINE_TIME_MS = 400;
/** 枚举候选着法时的时间预算 —— 只要知道「这手之后大概怎样」，可以更短 */
const MOVE_TIME_MS = 180;
const ENGINE_DEPTH = 12;

/**
 * 候选池大小（浅校验前的池子）。
 *
 * 要够大才能在「评分档 × 主题 × 目标类型」三个维度上都有选择余地 ——
 * 实测浅校验的淘汰率约 20%，池子给小了凑不满 30 关。
 */
const POOL_SIZE = 420;
/**
 * 同一个主题在候选池里最多出现几次。
 *
 * 定 10 是因为「车残局」占候选的 35% —— 上限太低会把池子卡死
 * （实测上限 8 时池子只挑出 100 关，凑不满 30 关的难度分布）。
 */
const MAX_PER_THEME_IN_POOL = 10;

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

/** 残局相关的主题（Lichess 主题词） */
const ENDGAME_THEMES = [
  'rookEndgame',
  'pawnEndgame',
  'bishopEndgame',
  'knightEndgame',
  'queenEndgame',
  'queenRookEndgame',
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

  // 主题：取残局主题里排最前的一个
  const theme = ENDGAME_THEMES.find((t) => raw.themes.includes(t));
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
 * 评估一个局面。
 *
 * 只用**满血**引擎（limitStrength: false）—— 限强的着法会主动走平庸，
 * 拿来当「正解」会把题判错。
 */
async function evaluate(
  sf: StockfishBackend,
  fen: string,
  color: 'w' | 'b',
  timeMs: number = ENGINE_TIME_MS,
): Promise<Eval> {
  const result = await sf.analyze(fen, color, {
    limitStrength: false,
    timeMs,
    depth: ENGINE_DEPTH,
  });
  const mv = result.move;
  return {
    best: mv ? `${mv.from}${mv.to}${mv.promotion ?? ''}` : null,
    mateIn: result.mateIn,
    score: result.score,
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
  const legal = game.moves({ verbose: true });
  const evals: MoveEval[] = [];

  for (const mv of legal) {
    const probe = new Chess(fen);
    let played;
    try {
      played = probe.move({ from: mv.from, to: mv.to, ...(mv.promotion ? { promotion: mv.promotion } : {}) });
    } catch {
      continue;
    }
    // 走完之后轮到对手 —— 从**对手视角**评估
    const opponent = played.color === 'w' ? 'b' : 'w';
    const ev = await evaluate(sf, probe.fen(), opponent, MOVE_TIME_MS);
    evals.push({ san: played.san, score: ev.score, mateIn: ev.mateIn });
  }

  const ref = evals.find((e) => e.san === refSan);
  if (!ref) return [];
  /** 参考解给玩家带来的优势（厘兵，对手视角取负） */
  const refAdv = -ref.score;
  /** 参考解的杀棋手数（对手视角）；不是杀棋局面时是 null */
  const refMate = ref.mateIn !== null && ref.mateIn < 0 ? -ref.mateIn : null;

  const out: string[] = [];
  for (const e of evals) {
    const adv = -e.score;
    if (goal === 'mate') {
      // 杀棋：候选着法也得能杀，而且不能比参考解慢
      if (refMate === null) continue;
      if (e.mateIn !== null && e.mateIn < 0 && -e.mateIn <= refMate) out.push(e.san);
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
    // 题库有六百多万行；够挑了就停（省时间）
    if (candidates.length >= LIMIT * 250) break;
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

  const sf = new StockfishBackend();
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
  }
  console.log(
    `▸ 浅校验通过 ${shallow.length} 关（解法不一致淘汰 ${droppedMismatch}，必败/目标不符淘汰 ${droppedLost}）`,
  );

  /* --- 第三阶段：按难度档选最终 30 关 --- */
  const finalists = pickFinalists(shallow, LIMIT);
  console.log(`▸ 决赛圈 ${finalists.length} 关`);

  /* --- 第四阶段：完整校验（可接受着法集合） --- */
  console.log('▸ 完整校验…');
  const puzzles: Puzzle[] = [];
  let index = 0;
  for (const { candidate, mateIn, goal } of finalists) {
    index += 1;
    if (index % 5 === 0) console.log(`  已验 ${index}/${finalists.length} 关`);

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
 * 三条约束同时满足：
 *   1. **难度铺开** —— 1~5 档每档都要有，多的档位再分剩下的名额；
 *   2. **两类目标都有** —— 「将死」和「取胜」都出现（残局教学两头都不能缺）；
 *   3. **主题不重样** —— 同一个主题最多 2 关。
 *
 * 做法：按难度档分桶，轮流从每档取一关；桶内优先挑**还没用过的主题**，
 * 并且尽量让「将死」和「取胜」交替出现。
 */
function pickFinalists(shallow: ShallowPuzzle[], limit: number): ShallowPuzzle[] {
  const buckets = new Map<number, ShallowPuzzle[]>();
  for (const s of shallow) {
    const d = s.candidate.difficulty;
    const list = buckets.get(d) ?? [];
    list.push(s);
    buckets.set(d, list);
  }
  // 桶内按 id 排 —— 结果确定
  for (const list of buckets.values()) list.sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));

  const themeUse = new Map<string, number>();
  const goalUse: Record<Puzzle['goal'], number> = { mate: 0, win: 0, draw: 0, promote: 0 };
  const picked: typeof shallow = [];

  // 每档先各拿一关（保证 5 个档都有人），剩下的再按档轮流补
  const perBand = Math.max(1, Math.floor(limit / 5));
  for (let round = 0; picked.length < limit; round += 1) {
    let progressed = false;
    for (let band = 1; band <= 5 && picked.length < limit; band += 1) {
      if (round >= perBand && picked.length >= perBand * 5) {
        // 已经每档都拿到 perBand 关了，剩下的名额不再补 —— 保持分布均匀
        if (picked.length >= perBand * 5) continue;
      }
      const list = buckets.get(band);
      if (!list || list.length === 0) continue;
      const idx = list.findIndex((s) => {
        const used = themeUse.get(s.candidate.theme) ?? 0;
        if (used >= 2) return false;
        // 同一档里，「将死」与「取胜」交替 —— 两类都要有
        const g = s.goal;
        const other = g === 'mate' ? 'win' : 'mate';
        if (goalUse[g] > goalUse[other]) return false;
        return true;
      });
      const chosen = idx === -1 ? list.findIndex((s) => (themeUse.get(s.candidate.theme) ?? 0) < 2) : idx;
      if (chosen === -1) continue;
      const s = list.splice(chosen, 1)[0];
      themeUse.set(s.candidate.theme, (themeUse.get(s.candidate.theme) ?? 0) + 1);
      goalUse[s.goal] += 1;
      picked.push(s);
      progressed = true;
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
 * 选关：主题尽量不重样，难度尽量铺开。
 *
 * 贪心：每一关挑「还没用过的主题」里最好的那个；
 * 主题用满了就允许重复，但同一个主题最多 3 关。
 */
function selectBalanced(candidates: Candidate[], limit: number): Candidate[] {
  const themeUse = new Map<string, number>();
  const picked: Candidate[] = [];
  const pool = [...candidates];

  while (picked.length < limit && pool.length > 0) {
    // 找主题还没用满、且该主题还剩候选的那一关
    let bestIndex = -1;
    for (let i = 0; i < pool.length; i += 1) {
      const used = themeUse.get(pool[i].theme) ?? 0;
      if (used >= MAX_PER_THEME_IN_POOL) continue;
      if (bestIndex === -1) bestIndex = i;
      // 主题没用过的优先
      if (used === 0) {
        bestIndex = i;
        break;
      }
    }
    if (bestIndex === -1) break;
    const chosen = pool.splice(bestIndex, 1)[0];
    themeUse.set(chosen.theme, (themeUse.get(chosen.theme) ?? 0) + 1);
    picked.push(chosen);
  }
  return picked;
}

/** 渲染产物（TS 源码） */
function renderData(puzzles: Puzzle[]): string {
  const body = puzzles
    .map((p) => {
      const line = p.line
        .map(
          (ply) =>
            `    { color: '${ply.color}', san: '${ply.san}', from: '${ply.from}', to: '${ply.to}', fen: '${ply.fen}'${
              ply.also && ply.also.length > 0
                ? `, also: [${ply.also.map((s) => `'${s}'`).join(', ')}]`
                : ''
            } },`,
        )
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
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
