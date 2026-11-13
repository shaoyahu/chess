/**
 * 门禁分组工具 —— **按「机制」分组的通用零件**。
 *
 * ## 为什么要分组
 *
 * 原来的验收规矩是「**每条变异都跑完全部门禁**」：
 *
 * ```
 * 一条变异 = build(10s) + 停/起服务(2.3s) + 跑全部 23 条门禁(28s) ≈ 49s
 * 24 条变异 ≈ 20 分钟起步；再叠上 arrow 那套 40 条 → 全项目一次验收 1 小时往上，
 * 而且**每加一个功能就多 2~3 条门禁 + 等量变异**，线性滚雪球。
 *
 * 实测拆账（chess-game，2026-11-11）：
 *
 * | 环节                 | 耗时 | 能不能省 |
 * |--------------------|------|---------|
 * | build（变异态）      | 10s  | 不能（源码变了必须重编） |
 * | 停 + 起服务          | 2.3s | 基本不能 |
 * | **跑全部门禁**       | 28s  | **能 —— 每条变异只期望 1 条红** |
 * | tsx 启动门禁脚本     | ~2s  | 能（常驻进程） |
 *
 * → **单条变异里有 20 秒是纯浪费**（22 条与本次变异无关的门禁在陪跑）。
 *
 * ## 分组的三条规则
 *
 * 1. **按机制分，不按控件分。** 「聊天」「战利品」「落子权」是机制；
 *    「按钮」「下拉框」是控件 —— 按控件分组会让一条变异跨好几组。
 * 2. **有状态依赖的门禁必须同组，且在组内保持脚本里的先后顺序。**
 *    反例（本项目踩过）：`V19`（HUD 变高后棋盘别被挤没）依赖 `V18` 先造出战利品，
 *    分组时漏了 `V18` → 跑 `V19` 时 HUD 是矮的，测的根本不是那件事。
 * 3. **跳过不等于失败。** 不在本次分组里的门禁**不计入结果**，
 *    也不能让脚本退出码变成非 0（否则变异脚本会误判成「抓到了」）。
 *
 * ## 为什么放在共享文件里
 *
 * 分组表是「同一个量写两遍」的高危区（本项目已经栽过一次：
 * 布局估算在 JS 常量和 CSS 变量各写了一份，改一个忘另一个就出 bug）。
 * 分组表、门禁编号、组的定义**只能有一处**，两边都从这里读。
 */

/** 一个门禁组的名字。 */
export type GateGroup = string;

/**
 * 门禁分组表：`组名 → 该组包含的门禁编号`。
 *
 * 每套门禁脚本**各有自己的一份**（机制不同），但**格式与工具一致**。
 * 门禁编号允许出现在多个组里 —— 那是为了表达「这条门禁依赖组内的前置门禁」。
 */
export type GroupTable = Record<GateGroup, string[]>;

/**
 * 从门禁 label 里提取编号。
 *
 * 门禁脚本的 label 一律是「编号 + 说明」（`V1 下拉框接管原生外观`、
 * `G1 2D 箭头几何与方向`），所以**不用改任何调用点**就能知道这条门禁是谁。
 *
 * 提取不到编号的（例：`准备 造一个对手让对局进入 playing`）是**准备步骤**，
 * 不属于任何组 —— 它的语义是「把环境准备好」，任何分组下都要跑。
 */
export function gateIdFromLabel(label: string): string {
  const m = label.match(/^\s*([A-Z]{1,2}\d+[a-z]?)\b/);
  return m ? m[1] : '';
}

/** 某条门禁属于哪些组（可能属于多个）。 */
export function groupsOfGate(table: GroupTable, gateId: string): GateGroup[] {
  const out: GateGroup[] = [];
  for (const [group, ids] of Object.entries(table)) {
    if (ids.includes(gateId)) out.push(group);
  }
  return out;
}

/**
 * 解析 `--group=a,b` 参数。
 *
 * - 不传 / 传 `all` → 返回 `null`，意思是「全跑」。
 * - 传了 → 返回组名数组；**不认识的组名直接报错**（拼错组名静默全跑 = 假绿）。
 */
export function parseGroupFilter(table: GroupTable, argv: string[]): GateGroup[] | null {
  const arg = argv.find((a) => a.startsWith('--group='));
  if (!arg) return null;
  const raw = arg.slice('--group='.length).trim();
  if (!raw || raw === 'all') return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !(n in table));
  if (unknown.length > 0) {
    throw new Error(
      `不认识的门禁组：${unknown.join('、')}（可选：${Object.keys(table).join('、')}）`,
    );
  }
  if (names.length === 0) throw new Error('--group= 后面没写组名');
  return names;
}

/**
 * 造一个「这条门禁本次要不要跑」的判定器。
 *
 * 规则：
 * - 未指定分组（`selected === null`）→ **全跑**；
 * - 步骤 id **不像门禁编号**（例：`准备`）→ **总是跑**
 *   （它是准备步骤，负责把环境准备好，跳过它后面的门禁就没得测了）；
 * - 门禁属于选中的任一组 → 跑；
 * - 否则 → 跳过（**不算失败，也不计入结果**）。
 */
export function makeGateFilter(
  table: GroupTable,
  selected: GateGroup[] | null,
): (gateId: string) => boolean {
  return (stepId: string): boolean => {
    if (selected === null) return true;
    // 步骤 id 形如 `V1` / `G29e`；`准备` 这类不是门禁编号
    if (!/^[A-Z]{1,2}\d+[a-z]?$/.test(stepId)) return true;
    const groups = groupsOfGate(table, stepId);
    if (groups.length === 0) {
      throw new Error(
        `门禁「${stepId}」不属于任何组 —— 它在本次分组下会被跳过，等于没人守它。` +
          `请把它加进 ${Object.keys(table).join(' / ')} 里的某一组。`,
      );
    }
    return groups.some((g) => selected.includes(g));
  };
}

/**
 * 门禁编号列表（去重、按组内首次出现顺序）。
 * 用于「组覆盖自检」和覆盖报告。
 */
export function allGateIds(table: GroupTable): string[] {
  const seen = new Set<string>();
  for (const ids of Object.values(table)) for (const id of ids) seen.add(id);
  return [...seen];
}

/**
 * 组覆盖自检 —— **「按组强制」这条规矩的执行点**。
 *
 * 规矩：新功能不要求「每个门禁都配一条变异」，而是要求
 * **每个组（机制）至少有一条变异** —— 否则这一组的门禁是「没人验证过它会不会红」的。
 *
 * @param table          分组表
 * @param mutations      变异元数据（至少要有 `expect` 与它跑的组）
 * @param mutationGroups 每条变异实际覆盖的组（`mutationId → 组名[]`）
 * @returns 问题清单；空数组 = 通过
 */
export function checkGroupCoverage(
  table: GroupTable,
  mutations: Array<{ id: string; expect: string }>,
  mutationGroups: Map<string, string[]>,
): string[] {
  const problems: string[] = [];

  // ① 每个组至少有一条变异，且那条变异的 expect 门禁**属于该组**
  for (const [group, ids] of Object.entries(table)) {
    const covering = mutations.filter((m) => {
      const gs = mutationGroups.get(m.id) ?? [];
      return gs.includes(group) && ids.includes(m.expect);
    });
    if (covering.length === 0) {
      problems.push(`组「${group}」没有任何变异守着（它的门禁：${ids.join('、')}）`);
    }
  }

  // ② 每条变异的 expect 门禁，必须落在它声明要跑的组里（自洽）
  for (const m of mutations) {
    const gs = mutationGroups.get(m.id) ?? [];
    const expectGroups = groupsOfGate(table, m.expect);
    if (expectGroups.length === 0) {
      problems.push(`变异「${m.id}」期望的「${m.expect}」不属于任何组`);
      continue;
    }
    if (!expectGroups.some((g) => gs.includes(g))) {
      problems.push(
        `变异「${m.id}」期望「${m.expect}」变红，但它跑的是「${gs.join('、')}」—— ` +
          `「${m.expect}」属于「${expectGroups.join('、')}」，两者对不上，这条变异永远抓不到`,
      );
    }
  }

  return problems;
}
