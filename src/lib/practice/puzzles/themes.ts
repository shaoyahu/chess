/**
 * **残局主题表** —— 主题键 → 中文标签 + 一句教学要点。
 *
 * 主题键沿用 Lichess 开放题库（CC0）的主题词，这样每关的来源都查得到，
 * 也方便按主题筛选题库。
 *
 * 这里的要点是**通关后才显示**的教学内容，不是答案：
 * 提前印出来就把题做完了（用户 2026-10-09 拍板：界面不要提前摊开系统的内部状态）。
 */

/** 一个主题的中文标签与教学要点 */
export interface PuzzleThemeInfo {
  /** 中文标签（界面上显示） */
  label: string;
  /** 通关后显示的要点 */
  hint: string;
}

/**
 * 残局关卡用到的主题。
 *
 * 键 = Lichess 题库的主题词（CC0）。
 */
export const PUZZLE_THEMES: Record<string, PuzzleThemeInfo> = {
  /* ---------- 残局类型 ---------- */
  rookEndgame: {
    label: '车残局',
    hint: '车残局里决定胜负的往往不是子力，而是**车的位置**：车占住底线或第七横线，就等于给王和兵撑起一条路。',
  },
  pawnEndgame: {
    label: '兵残局',
    hint: '兵残局的第一件事是**数兵** —— 通路兵、叠兵、落后兵，哪一兵值钱决定了计划。',
  },
  bishopEndgame: {
    label: '象残局',
    hint: '象残局最容易和棋：单象对单象几乎不可能赢，要靠**逼对方王走进角**。',
  },
  knightEndgame: {
    label: '马残局',
    hint: '马残局里王不能像别的子那样被直接保护 —— 马的「保护」得靠**挡住对方的马**。',
  },
  queenEndgame: {
    label: '后残局',
    hint: '后残局是最容易出战术的残局：后的机动性太强，一不留神就被将死或丢子。',
  },
  queenRookEndgame: {
    label: '后车残局',
    hint: '后车残局子力重，要警惕**丢后** —— 一旦被将死，什么计划都没了。',
  },

  /* ---------- 残局手法 ---------- */
  zugzwang: {
    label: '逼和',
    hint: '「逼和」是**轮到自己走反而更糟**的局面 —— 逼对方先动，你就能占便宜。',
  },
  stalemate: {
    label: '僵局',
    hint: '僵局不是和棋的好看版本，而是**走一步就输**：宁可直接换和棋，也别给对方逼和的机会。',
  },
  promotion: {
    label: '升变',
    hint: '升变不只是「兵到底线就变后」—— 什么时候变、变什么、变完还有没有第二步，都要先算过。',
  },
  underPromotion: {
    label: '升马升车',
    hint: '升马或升车不是花活：后太大反而挡路，**用马困住对方的王**是残局里的老手艺。',
  },
  advancedPawn: {
    label: '通路兵',
    hint: '通路兵是残局里最硬的子力 —— 但要记住五十回合规则，别赢了个寂寞。',
  },
  trappedPiece: {
    label: '困子',
    hint: '困住对方的子比吃掉它更实用：被围住的子会**挡住自己王的活动空间**。',
  },
  defensiveMove: {
    label: '防守',
    hint: '防守的第一步是**找到唯一能活的那格** —— 逼和、兑子、躲进角落，都是活路。',
  },
  quietMove: {
    label: '安静着法',
    hint: '安静着法不将军、不吃子，但**把对方的路堵死** —— 残局里这种着法最狠。',
  },
  interference: {
    label: '阻塞',
    hint: '阻塞：把对方王和子之间的联系**切断**，对方就自己把自己困住了。',
  },
  deflection: {
    label: '引离',
    hint: '引离：把对方的关键防守子**赶走**，然后再动手吃它。',
  },
  clearance: {
    label: '腾空',
    hint: '腾空：先把自己的子挪开，让出一条给重子用的线 —— 顺序错了就不成立。',
  },
  attraction: {
    label: '吸引',
    hint: '吸引：把对方的王**拉到你要它站的位置**，再动手。',
  },
  intermezzo: {
    label: '插入',
    hint: '插入：在对方「该走的一步」之前插一手 —— 顺序抢对了，计划就成立。',
  },
  xRayAttack: {
    label: '穿线',
    hint: '穿线攻击：隔着对方的子打后面的目标 —— 对方一挡，你就顺势得子。',
  },

  /* ---------- 杀法 ---------- */
  backRankMate: {
    label: '底线杀',
    hint: '底线杀：王躲在底线，前方被自己的兵堵死 —— 逼它走出来的那一手才是关键。',
  },
  operaMate: {
    label: '歌剧院杀',
    hint: '歌剧院杀：一条斜线将军，王无处可去 —— 堵住逃格的那一步比将军本身更重要。',
  },
  smotheredMate: {
    label: '闷杀',
    hint: '闷杀：将军的马是**唯一**的活路，王躲不开 —— 先断马腿。',
  },
  bodenMate: {
    label: '博登杀',
    hint: '博登杀：两条斜线交叉将军，王被自己的兵挤死。',
  },
  hookMate: {
    label: '钩杀',
    hint: '钩杀：车从旁边钩进底线，将死的同时把王封死。',
  },
  killBoxMate: {
    label: '杀盒',
    hint: '杀盒：马和后配合，把王的活动范围压成几个格子 —— 一步步挤进去。',
  },
  dovetailMate: {
    label: '鸽尾杀',
    hint: '鸽尾杀：后在底线配合车将军，王的两边都被自己子堵着。',
  },
  epauletteMate: {
    label: '肩章杀',
    hint: '肩章杀：王的左右各有自己的子像肩章一样卡着，只能往前走。',
  },
  cornerMate: {
    label: '角杀',
    hint: '角杀：把王赶到角落，再用车或后封住逃格。',
  },
  anastasiaMate: {
    label: '安娜丽莎杀',
    hint: '安娜丽莎杀：马和车夹击，黑王身边还有自己的兵挡着逃路。',
  },
  balestraMate: {
    label: '弩炮杀',
    hint: '弩炮杀：后像弩一样架住对方，车从旁边开出致命一枪。',
  },
  arabianMate: {
    label: '阿拉伯杀',
    hint: '阿拉伯杀：马从上方压住王，后在远处收网。',
  },
  blindSwineMate: {
    label: '盲猪杀',
    hint: '盲猪杀：两辆车在一条线上夹住王，中间没有子挡着 —— 先把中间清干净。',
  },
  doubleBishopMate: {
    label: '双象杀',
    hint: '双象杀：两条斜线交叉，王被自己的兵挤在边上。',
  },
  morphysMate: {
    label: '墨菲杀',
    hint: '墨菲杀：车闪开通路将军，车本身却还在原地封着逃格。',
  },
  swallowstailMate: {
    label: '燕尾杀',
    hint: '燕尾杀：后与车配合，把王逼到角落再将军。',
  },
  triangleMate: {
    label: '三角杀',
    hint: '三角杀：车在三角形的三个顶点之间转换位置，逼王无处可去。',
  },
  vukovicMate: {
    label: '武科维奇杀',
    hint: '武科维奇杀：车在边上配合马将军，王被自己的子堵死退路。',
  },
};

/** 主题的中文标签（没登记过的主题退回键本身） */
export function themeLabel(theme: string): string {
  return PUZZLE_THEMES[theme]?.label ?? theme;
}

/** 主题的教学要点（没登记过的主题给一句通用的话） */
export function themeHint(theme: string): string {
  return PUZZLE_THEMES[theme]?.hint ?? '先把对方的王赶到最难受的位置，再动手。';
}
