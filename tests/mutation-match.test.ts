import { describe, expect, it } from 'vitest';
import { gateTurnedRed } from '../scripts/lib/gate-match';

/**
 * 变异脚本判断「这条门禁变红了没」的规则。
 *
 * 这个判定出过**两次**事故，都是因为规则写得太随意：
 *   · 用纯 `includes` → 「期望 U2」被「❌ U20 …」冒充成抓到（假绿）；
 *   · 用纯词边界 `\bU9\b` → 「❌ U9b …」认不出来（假阴性）。
 */
describe('gateTurnedRed', () => {
  it('认得出期望编号自己的红行', () => {
    const out = ['❌ U7 棋谱记谱卡内容正确（步数 / 回合行 / 真实 SAN / 复制 PGN） —— 着法数=2'];
    expect(gateTurnedRed(out.join('\n'), 'U7')).toBe(true);
  });

  it('**不**把别的编号当成它（U2 不能被 U20 冒充）', () => {
    const out = ['❌ U20 没有 navigator.clipboard 时复制走兜底、并且成功 —— 兜底被调用=0 次'];
    expect(gateTurnedRed(out.join('\n'), 'U2')).toBe(false);
    expect(gateTurnedRed(out.join('\n'), 'U20')).toBe(true);
  });

  it('**不**把 U14 当成 U1（数字后缀是另一个编号）', () => {
    const out = ['❌ U14 设置里有棋子风格（4 选 1）与棋子材质（3 选 1）'];
    expect(gateTurnedRed(out.join('\n'), 'U1')).toBe(false);
    expect(gateTurnedRed(out.join('\n'), 'U14')).toBe(true);
  });

  it('认得出**子编号**（U9a / U9b 属于 U9 这一条判据）', () => {
    const out = [
      '❌ U9a 辅助下棋开着也不自动显示下一步（且 HUD 里冒出「提示」按钮） —— 执行出错：超时',
      '❌ U9b 点「提示」→ 出现蓝色指引箭头（且 3 秒后仍在） —— svg=0',
    ];
    expect(gateTurnedRed(out.join('\n'), 'U9')).toBe(true);
  });

  it('绿行不算红（只有带 ❌ 的行才算）', () => {
    const out = ['✅ U7 棋谱记谱卡内容正确', '✅ U19 宽屏棋谱常驻左栏、没有遮罩、也不压棋盘'];
    expect(gateTurnedRed(out.join('\n'), 'U7')).toBe(false);
    expect(gateTurnedRed(out.join('\n'), 'U19')).toBe(false);
  });

  it('编号在别的词中间不算（不能被无关文本命中）', () => {
    const out = ['❌ 门禁 U9 说明：这条其实是 U90 的问题'];
    expect(gateTurnedRed(out.join('\n'), 'U9')).toBe(false);
  });
});
