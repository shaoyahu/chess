/**
 * **残局关卡**的纯逻辑守卫。
 *
 * 重点守五件事：
 *  1. **题库的每一关都自洽** —— FEN 合法、着法真能走、局面与记录一致；
 *  2. **目标真的达成了** —— 说「几步杀」就真的是将死，不是走到一半就停；
 *  3. **判定逻辑对** —— 走对了推进、走错了不推进、等价正解也算对；
 *  4. **难度与来源没丢** —— 难度档齐、来源标了 CC0；
 *  5. **存档坏了不炸** —— 读不出来就当没通关过，绝不把页面卡死。
 *
 * 第 2 条最容易出事：题是生成的，生成器改了一处就可能造出
 * 「线走完了但目标没达成」的关卡 —— 那种关卡在界面上会显示通关，
 * 实际上一手都没解完。
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  PUZZLES,
  applyPlayerMove,
  currentPlayerPly,
  emptyProgress,
  goalReached,
  hintFor,
  isAcceptedMove,
  isOpponentHopeless,
  isSolved,
  loadProgress,
  markCurrent,
  markSolved,
  materialCp,
  opponentNoteText,
  playerMoveCount,
  saveProgress,
  sessionPosition,
  startSession,
  themeHint,
  themeLabel,
  type Puzzle,
} from '@/lib/practice/puzzles';

describe('残局关卡 · 题库', () => {
  it('题库不为空，且关卡 id 唯一', () => {
    expect(PUZZLES.length).toBeGreaterThan(0);
    const ids = new Set(PUZZLES.map((p) => p.id));
    expect(ids.size, '关卡 id 有重复').toBe(PUZZLES.length);
  });

  it('每一关的起始局面都是合法 FEN，且轮到玩家走', () => {
    for (const p of PUZZLES) {
      const game = new Chess(p.fen);
      expect(game.turn(), `关卡 ${p.id} 的起始局面不是轮到玩家走`).toBe(p.side);
    }
  });

  it('每一关的着法线都真能走通，且局面记录与实际一致', () => {
    for (const p of PUZZLES) {
      let fen = p.fen;
      for (const ply of p.line) {
        const game = new Chess(fen);
        let played;
        try {
          played = game.move(ply.san);
        } catch {
          throw new Error(`关卡 ${p.id} 的着法 ${ply.san} 不合法`);
        }
        expect(played.san, `关卡 ${p.id} 的 ${ply.san} 记谱不一致`).toBe(ply.san);
        expect(game.fen(), `关卡 ${p.id} 走完 ${ply.san} 后的局面记录不一致`).toBe(ply.fen);
        expect(ply.from, `关卡 ${p.id} 的 ${ply.san} 缺起点`).toBe(played.from);
        expect(ply.to, `关卡 ${p.id} 的 ${ply.san} 缺终点`).toBe(played.to);
        expect(ply.color, `关卡 ${p.id} 的 ${ply.san} 走子方记录错了`).toBe(played.color);
        fen = game.fen();
      }
    }
  });

  it('着法线从玩家那手开始，之后玩家与对手交替', () => {
    for (const p of PUZZLES) {
      expect(p.line.length, `关卡 ${p.id} 的线是空的`).toBeGreaterThan(0);
      expect(p.line[0].color, `关卡 ${p.id} 的第一步不是玩家走的`).toBe(p.side);
      for (let i = 1; i < p.line.length; i += 1) {
        expect(
          p.line[i].color,
          `关卡 ${p.id} 的第 ${i + 1} 手没有与上一手交替`,
        ).not.toBe(p.line[i - 1].color);
      }
    }
  });

  it('每一关走完线之后，目标真的达成了', () => {
    for (const p of PUZZLES) {
      const finalFen = p.line[p.line.length - 1].fen;
      expect(
        goalReached(p, finalFen),
        `关卡 ${p.id}（${p.goal}）走完线但目标没达成`,
      ).toBe(true);
    }
  });

  it('杀棋关卡标的杀棋手数与着法线对得上', () => {
    for (const p of PUZZLES) {
      if (p.goal !== 'mate') continue;
      const playerMoves = p.line.filter((x) => x.color === p.side).length;
      expect(
        p.mateIn,
        `关卡 ${p.id} 标的杀棋手数与实际着法步数不符`,
      ).toBe(playerMoves);
    }
  });

  it('等价正解（also）本身也都是合法着法', () => {
    for (const p of PUZZLES) {
      let fen = p.fen;
      for (const ply of p.line) {
        if (ply.color === p.side && ply.also && ply.also.length > 0) {
          const game = new Chess(fen);
          const legal = new Set(
            game.moves({ verbose: true }).map((m) => m.san),
          );
          for (const san of ply.also) {
            expect(legal.has(san), `关卡 ${p.id} 的等价正解 ${san} 不是合法着法`).toBe(true);
            expect(san, `关卡 ${p.id} 的等价正解 ${san} 与正解重复`).not.toBe(ply.san);
          }
        }
        fen = ply.fen;
      }
    }
  });

  it('目标没达成时不能算通关', () => {
    /*
     * 这条是**反向断言** —— 上面那些都是「应该 true」，
     * 少了它，「目标判定恒真」这种回退就抓不到。
     *
     * 做法：拿一关杀棋题，把目标改成别的，终局对不上就该判 false。
     */
    const mate = PUZZLES.find((p) => p.goal === 'mate');
    expect(mate, '题库里没有杀棋关卡').toBeTruthy();
    if (!mate) return;
    const finalFen = mate.line[mate.line.length - 1].fen;

    // 目标本身是「将死」，终局确实是绝杀 → 达成
    expect(goalReached(mate, finalFen)).toBe(true);
    // 目标改成「守和」，而终局是绝杀 → 不该算达成
    expect(goalReached({ ...mate, goal: 'draw' }, finalFen)).toBe(false);

    const win = PUZZLES.find((p) => p.goal === 'win');
    expect(win, '题库里没有取胜关卡').toBeTruthy();
    if (!win) return;
    const winFinal = win.line[win.line.length - 1].fen;
    // 取胜题改成「将死」，而终局不是绝杀 → 不该算达成
    expect(goalReached({ ...win, goal: 'mate' }, winFinal)).toBe(false);
  });

  it('难度档在 1~5 之间，且五档都有题', () => {
    const bands = new Set(PUZZLES.map((p) => p.difficulty));
    for (const p of PUZZLES) {
      expect(p.difficulty).toBeGreaterThanOrEqual(1);
      expect(p.difficulty).toBeLessThanOrEqual(5);
    }
    expect(bands.size, '难度档没有铺开（1~5 档都该有题）').toBe(5);
  });

  it('每一关都标了出处与授权', () => {
    for (const p of PUZZLES) {
      expect(p.source.name.length, `关卡 ${p.id} 缺来源`).toBeGreaterThan(0);
      expect(p.source.license, `关卡 ${p.id} 缺授权`).toBe('CC0');
      expect(p.source.url, `关卡 ${p.id} 缺来源链接`).toBeTruthy();
    }
  });

  it('每一关都有通关后显示的要点', () => {
    for (const p of PUZZLES) {
      expect(p.points.length, `关卡 ${p.id} 没有要点`).toBeGreaterThan(0);
      for (const point of p.points) {
        expect(point.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('每一关的主题都在主题表里登记过', () => {
    for (const p of PUZZLES) {
      expect(themeLabel(p.theme), `关卡 ${p.id} 的主题没登记：${p.theme}`).not.toBe(p.theme);
      expect(themeHint(p.theme).trim().length).toBeGreaterThan(0);
    }
  });

  it('关卡数量达到 300 关', () => {
    expect(PUZZLES.length, '残局关卡少于 300 关').toBeGreaterThanOrEqual(300);
  });

  it('主题分类铺开：至少覆盖 12 个类别，且没有任何一类吃掉题库', () => {
    const counts = new Map<string, number>();
    for (const p of PUZZLES) counts.set(p.theme, (counts.get(p.theme) ?? 0) + 1);
    expect(counts.size, '主题类别太少（分类就没意义了）').toBeGreaterThanOrEqual(12);
    // 任何一类不超过总数的 20%
    const max = Math.max(...counts.values());
    expect(max / PUZZLES.length, '某一类主题占比过高').toBeLessThan(0.2);
  });

  it('有多步将杀的关卡（玩家要走两步以上）', () => {
    const multi = PUZZLES.filter((p) => p.goal === 'mate' && (p.mateIn ?? 0) >= 2);
    expect(multi.length, '多步将杀的关卡太少').toBeGreaterThanOrEqual(30);
    // 其中还得有真正「多手」的（3 手以上）
    const deep = PUZZLES.filter((p) => p.goal === 'mate' && (p.mateIn ?? 0) >= 3);
    expect(deep.length, '3 手以上的将杀太少').toBeGreaterThanOrEqual(10);
  });

  it('每个对手节点都带解说，且数据自洽', () => {
    for (const p of PUZZLES) {
      // 重放主线，记下每个节点的局面
      const game = new Chess(p.fen);
      let nodeIndex = 0;
      for (const ply of p.line) {
        if (ply.color !== p.side) {
          /*
           * **对手节点**：note 是在「这个局面」上算的，
           * 所以 note.legalCount 必须等于**这个局面**的合法着法数。
           *
           * 这条断言能抓住「note 算在了错局面上」这类真 bug ——
           * 光检查字段非空是抓不住的。
           */
          const note = ply.note;
          expect(note, `关卡 ${p.id} 的对手着法 ${ply.san} 没有解说`).toBeTruthy();
          const legalCount = game.moves().length;
          expect(note!.legalCount, `关卡 ${p.id} 的 ${ply.san} 合法着法数对不上`).toBe(legalCount);
          expect(note!.legalCount).toBeGreaterThanOrEqual(1);
          /*
           * 分值与杀棋距离**至少有一个**。
           *
           * 杀棋局面里引擎给的是「几手后被将死」，没有分值（null）——
           * 所以不能一律要求 bestScoreAfter 非空，
           * 但也不能两个都没有（那就什么事实都没算出来）。
           */
          expect(
            note!.bestScoreAfter !== null || note!.bestMateInAfter !== null,
            `关卡 ${p.id} 的 ${ply.san} 既没有最佳着法分值也没有杀棋距离`,
          ).toBe(true);
          expect(note!.sacrificedCp).toBeGreaterThanOrEqual(0);
          // 最优着法的分值必须真的最优
          if (note!.scoreAfter !== null && note!.bestScoreAfter !== null) {
            expect(note!.bestScoreAfter).toBeGreaterThanOrEqual(note!.scoreAfter);
          }
        }
        // 走完这手，局面推进
        game.move(ply.san);
        nodeIndex += 1;
      }
      void nodeIndex;
    }
  });

  it('解说文本不是空话：有实质信息', () => {
    for (const p of PUZZLES) {
      for (const ply of p.line) {
        if (ply.color === p.side || !ply.note) continue;
        const text = opponentNoteText(ply.note);
        expect(text, `关卡 ${p.id} 的 ${ply.san} 解说是空的`).toBeTruthy();
        expect(text!.length, `关卡 ${p.id} 的 ${ply.san} 解说太短`).toBeGreaterThan(6);
      }
    }
  });

  it('非最优的着法，解说要老实说「不是最优」', () => {
    // 造一个「非最优」的事实，解说必须如实反映
    const fake = {
      legalCount: 5,
      hopeless: false,
      isBest: false,
      mateInAfter: null,
      scoreAfter: -500,
      bestSan: 'Kh6',
      bestScoreAfter: -300,
      bestMateInAfter: null,
      sacrificedCp: 0,
    };
    const text = opponentNoteText(fake) ?? '';
    expect(text, '非最优的着法没有说清楚').toContain('不是最优');
    expect(text).toContain('Kh6');
  });

  it('唯一合法着法，解说要说明「只有这一着」', () => {
    const fake = {
      legalCount: 1,
      hopeless: false,
      isBest: true,
      mateInAfter: null,
      scoreAfter: -100,
      bestSan: null,
      bestScoreAfter: -100,
      bestMateInAfter: null,
      sacrificedCp: 0,
    };
    const text = opponentNoteText(fake) ?? '';
    expect(text).toContain('只有这一着');
  });

  it('已败局面下要说清「在拖时间」，别让玩家以为对手在犯傻', () => {
    const fake = {
      legalCount: 7,
      hopeless: true,
      isBest: true,
      mateInAfter: 11,
      scoreAfter: null,
      bestSan: null,
      bestScoreAfter: null,
      bestMateInAfter: 11,
      sacrificedCp: 0,
    };
    const text = opponentNoteText(fake) ?? '';
    expect(text, '已败局面下没说明是在拖时间').toContain('最能拖');
    expect(text).toContain('无解');
  });

  it('弃子要按棋子说（「丢了一车」而不是「3.2 个兵」）', () => {
    const fake = {
      legalCount: 6,
      hopeless: true,
      isBest: true,
      mateInAfter: 7,
      scoreAfter: -800,
      bestSan: null,
      bestScoreAfter: -800,
      bestMateInAfter: 7,
      sacrificedCp: 500,
    };
    const text = opponentNoteText(fake) ?? '';
    expect(text).toContain('丢了一车');
  });

  it('子力计算：局面里每方的总子力', () => {
    // 白方一后一车一兵（a7 后、e7 车、g1 兵），黑方一王
    const fen = '8/8/8/8/8/8/Q3R3/4K1P1 w - - 0 1';
    expect(materialCp(fen, 'w')).toBe(900 + 500 + 100);
    expect(materialCp(fen, 'b')).toBe(0);
  });

  it('note 的数据与它声称的结论一致', () => {
    for (const p of PUZZLES) {
      for (const ply of p.line) {
        if (ply.color === p.side || !ply.note) continue;
        const note = ply.note;

        // 声称「不是最优」时，必须真的给出更好的着法
        if (!note.isBest) {
          expect(note.bestSan, `${p.id} ${ply.san} 声称不是最优却没给更好的着法`).toBeTruthy();
        }
        // 声称「最优」时，bestSan 就不该另有其人
        if (note.isBest && note.bestSan) {
          throw new Error(
            `${p.id} ${ply.san} 声称最优，bestSan 却指向另一手（${note.bestSan}）—— 自相矛盾`,
          );
        }
        // 声称「无解」（被将死）时，必须有杀棋距离
        if (note.hopeless && note.mateInAfter !== null) {
          expect(note.mateInAfter, `${p.id} ${ply.san} 声称无解却没有杀棋距离`).toBeGreaterThan(0);
        }
        // 杀棋距离必须是正数（几步能杀）
        if (note.mateInAfter !== null) {
          expect(note.mateInAfter).toBeGreaterThan(0);
        }
        if (note.bestMateInAfter !== null) {
          expect(note.bestMateInAfter).toBeGreaterThan(0);
        }
      }
    }
  });

  it('「已败」的判定规则：被杀棋，或子力大劣', () => {
    /*
     * 这条规则**生成器与单测共用同一份实现**（`isOpponentHopeless`）。
     *
     * 为什么要单独测：
     * 判据里但凡有一处符号写反（`score <= -500` 写成 `score <= 500`），
     * 后果是**几乎每一条解说都变成「对手已经输定了」** ——
     * 而单测如果自己写一套判据，测的就是单测自己的写法，抓不到生成器的错。
     */
    // 被杀棋 = 无解
    expect(isOpponentHopeless({ mateInAfter: 7, scoreAfter: -100 })).toBe(true);
    // 子力大劣（对手视角：负数越大，对手越惨）= 输定
    expect(isOpponentHopeless({ mateInAfter: null, scoreAfter: -500 })).toBe(true);
    expect(isOpponentHopeless({ mateInAfter: null, scoreAfter: -900 })).toBe(true);
    // 还没到那个程度 = 还在拉锯
    expect(isOpponentHopeless({ mateInAfter: null, scoreAfter: -499 })).toBe(false);
    expect(isOpponentHopeless({ mateInAfter: null, scoreAfter: 300 })).toBe(false);
    // 没有分值就下不了结论
    expect(isOpponentHopeless({ mateInAfter: null, scoreAfter: null })).toBe(false);
  });

  it('每条解说的「已败」标志都跟它自己的事实对得上', () => {
    for (const p of PUZZLES) {
      for (const ply of p.line) {
        if (ply.color === p.side || !ply.note) continue;
        const note = ply.note;
        expect(
          note.hopeless,
          `${p.id} ${ply.san} 的「已败」标志与事实对不上` +
            `（mateInAfter=${note.mateInAfter} scoreAfter=${note.scoreAfter}）`,
        ).toBe(
          isOpponentHopeless({
            mateInAfter: note.mateInAfter,
            scoreAfter: note.scoreAfter,
          }),
        );
      }
    }
  });
});

describe('残局关卡 · 判定逻辑', () => {
  /*
   * 判定逻辑用**题库里的真实关卡**来测，不用手编的假局面。
   *
   * 原因：手编局面最容易在「哪着算将死」「哪着合法」上出错
   *（第一版就把后从 a2 误当成能攻击第 8 横线，写出来的测试是错的）。
   * 真实关卡的着法合法性由上面那组题库守卫兜着，
   * 这里只管「判定逻辑对不对」。
   */

  /** 某关第一手之外、但**合法**的着法（用来测「走错」）；没有就返回 null */
  function aWrongButLegalMove(puzzle: Puzzle): string | null {
    const game = new Chess(puzzle.fen);
    const legal = game.moves({ verbose: true }).map((m) => m.san);
    const right = puzzle.line[0];
    return legal.find((san) => san !== right.san && !(right.also ?? []).includes(san)) ?? null;
  }

  it('走对了推进，走错了不推进', () => {
    /*
     * 挑一关**有**「错但合法」的着法来测。
     *
     * 不是每一关都有 —— 有的残局每一步都算对
     *（比如对手只有一着可走、玩家也只有一着能走通），
     * 拿那种关卡测「走错」根本测不到东西。
     */
    const puzzle = PUZZLES.find((p) => aWrongButLegalMove(p) !== null);
    if (!puzzle) throw new Error('题库里没有一关能测「走错」');
    const session = startSession(puzzle);

    const wrong = applyPlayerMove(session, aWrongButLegalMove(puzzle) as string);
    expect(wrong.ok, '走错的一步不该被判对').toBe(false);
    expect(wrong.session.ply, '走错了不该推进').toBe(0);
    expect(wrong.session.lastWrong).not.toBeNull();

    const right = applyPlayerMove(session, puzzle.line[0].san);
    expect(right.ok).toBe(true);
    expect(right.session.ply).toBeGreaterThan(0);
    expect(right.session.lastWrong, '走对了不该还留着错的着法').toBeNull();
  });

  it('等价正解（also）算走对', () => {
    /*
     * 这里用**手造局面**，不用题库里的关卡 ——
     * 题库这 30 关恰好都是「只有一着解」（引擎算下来别的着法都不成立），
     * 拿它测不出「多解也算对」这条。
     *
     * 局面：白车 a1、白后 e1、白王 h1，黑王 h8 带 g7/h7 两个兵。
     * 车走到 a8、后走到 e8 都是底线绝杀（第 8 横线只有黑王，
     * g8 被横线罩住、g7/h7 是黑方自己的兵）—— 天然有多个正解。
     */
    const fen = '7k/6pp/8/8/8/8/8/R3Q2K w - - 0 1';
    const mates: Array<{ san: string; from: string; to: string; fen: string }> = [];
    for (const mv of new Chess(fen).moves({ verbose: true })) {
      const probe = new Chess(fen);
      const played = probe.move({ from: mv.from, to: mv.to });
      if (probe.isCheckmate()) {
        mates.push({ san: played.san, from: played.from, to: played.to, fen: probe.fen() });
      }
    }
    expect(mates.length, '这个局面应该有多于一个绝杀着法').toBeGreaterThan(1);

    const ref = mates[0];
    const also = mates.slice(1).map((m) => m.san);
    const puzzle: Puzzle = {
      id: 'multi-solution',
      name: '多解局面',
      en: 'multi-solution',
      theme: 'rookEndgame',
      difficulty: 2,
      fen,
      side: 'w',
      goal: 'mate',
      line: [{ color: 'w', san: ref.san, from: ref.from, to: ref.to, fen: ref.fen, also }],
      points: [],
      source: { name: 'test', license: 'CC0' },
    };

    const session = startSession(puzzle);
    expect(isAcceptedMove(session, ref.san)).toBe(true);
    for (const alt of also) {
      expect(isAcceptedMove(session, alt), `等价正解 ${alt} 竟然不算走对`).toBe(true);
      expect(applyPlayerMove(session, alt).ok, `走等价正解 ${alt} 竟然被判错`).toBe(true);
    }
    // 不是正解的着法仍然要判错
    const wrong = new Chess(fen)
      .moves({ verbose: true })
      .map((m) => m.san)
      .find((san) => san !== ref.san && !also.includes(san));
    expect(wrong, '这个局面应该还有别的合法着法').toBeTruthy();
    expect(isAcceptedMove(session, wrong!), `非正解的 ${wrong} 竟然算走对`).toBe(false);
  });

  it('对手那手会自动走掉', () => {
    const puzzle = PUZZLES.find((p) => p.line.length >= 2);
    expect(puzzle).toBeTruthy();
    if (!puzzle) return;

    const session = applyPlayerMove(startSession(puzzle), puzzle.line[0].san).session;
    // 玩家走完，对手那手紧接着自动走掉
    const expectPly = puzzle.line.length >= 2 && puzzle.line[1].color !== puzzle.side ? 2 : 1;
    expect(session.ply).toBe(expectPly);
    expect(sessionPosition(session)).toBe(puzzle.line[session.ply - 1].fen);
  });

  it('走完整条线才算通关', () => {
    const puzzle = PUZZLES[0];
    let session = startSession(puzzle);
    expect(isSolved(session), '刚开始就通关了').toBe(false);
    for (const ply of puzzle.line) {
      if (ply.color !== puzzle.side) continue;
      const next = applyPlayerMove(session, ply.san);
      expect(next.ok, `关卡 ${puzzle.id} 的正解 ${ply.san} 竟然被判错`).toBe(true);
      session = next.session;
    }
    expect(session.solved, '走完整条线应该通关').toBe(true);
    expect(isSolved(session)).toBe(true);
  });

  it('通关后不能再走子', () => {
    const puzzle = PUZZLES[0];
    let session = startSession(puzzle);
    for (const ply of puzzle.line) {
      if (ply.color !== puzzle.side) continue;
      session = applyPlayerMove(session, ply.san).session;
    }
    expect(session.solved).toBe(true);
    expect(applyPlayerMove(session, puzzle.line[0].san).ok, '通关后不该还能走').toBe(false);
  });

  it('提示给的是当前该走的那一手', () => {
    const puzzle = PUZZLES[0];
    const session = startSession(puzzle);
    expect(hintFor(session)?.san).toBe(puzzle.line[0].san);
    expect(currentPlayerPly(session)?.color).toBe(puzzle.side);
  });

  it('玩家着法步数与线里的玩家着法数一致', () => {
    for (const p of PUZZLES) {
      const expected = p.line.filter((x) => x.color === p.side).length;
      expect(playerMoveCount(p)).toBe(expected);
    }
  });
});

describe('残局关卡 · 存档', () => {
  /** 假的 localStorage */
  function fakeStorage(): Storage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage & { data: Map<string, string> };
  }

  it('通关记录能存能读', () => {
    const store = fakeStorage();
    const progress = markSolved(markCurrent(emptyProgress(), 'abc'), 'abc');
    saveProgress(progress, store);
    const loaded = loadProgress(store);
    expect(loaded.solved).toContain('abc');
    expect(loaded.lastId).toBe('abc');
  });

  it('重复通关不会记两遍', () => {
    const progress = markSolved(emptyProgress(), 'abc');
    const again = markSolved(progress, 'abc');
    expect(again.solved.length).toBe(1);
  });

  it('存档坏了当成没通关过（不能把页面卡死）', () => {
    const store = fakeStorage();
    store.setItem('lan-chess.endgame-puzzles.v1', '{ 这不是 JSON');
    const loaded = loadProgress(store);
    expect(loaded.solved).toEqual([]);
    expect(loaded.lastId).toBeNull();
  });

  it('存档里字段类型不对也安全', () => {
    const store = fakeStorage();
    store.setItem('lan-chess.endgame-puzzles.v1', JSON.stringify({ solved: [1, 'x'], lastId: 42 }));
    const loaded = loadProgress(store);
    expect(loaded.solved).toEqual(['x']);
    expect(loaded.lastId).toBeNull();
  });
});
