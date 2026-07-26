import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Button, Space, Table, Alert, Statistic, Row, Col, Typography, Input, Select, InputNumber, message, Modal, Checkbox, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { compileStrategy, runStrategyOnRow, aggregateCheckStats, aggregateScoreStats,
         parseFactorCheck, buildStrategyVerdict, detectTimeReads } from '../lib/proAnalytics.js';
import { median, pearson, pearsonPValue, splitTrainTest } from '../lib/utils.js';
import { getFieldDesc } from '../lib/dictionary.js';
import { hasAllChecksArchitecture, buildAllChecksRow, insertIntoAllChecks, buildCampCheckLine,
         insertLineIntoStrategySrc, findFieldConflict, applyWeightsToSrc,
         removeCheckLineFromSrc, applyChangeSetToSrc, reAddFactorLine, removeCheckLineByField } from '../lib/campLibrary.js';
import { computeScoreReturnStats, computeScoreBuckets, campRangeText, campRangeBounds,
         FACTOR_WEIGHT_DEFAULT, suggestWeightAdjustment, factorVerdict, computeStrategyMetrics,
         crossDayVerdict, CROSS_DAY_MIN_STREAK } from '../lib/strategyReplayLogic.js';
import { loadBacktestReports, todayDateStr } from '../lib/backtestReports.js';
import { checkStrategySpec, applySpecFix, applyAllSpecFixes } from '../lib/strategySpec.js';
import { loadRemovedFactors, saveRemovedFactors, addRemovedFactor, dropRemovedFactor } from '../lib/removedFactors.js';
import { useGroupedFieldOptions, renderFieldOption, fieldFilterOption } from './fieldOptions.jsx';
import { HardConditionsTable, FactorEffectivenessTable } from './strategyReplay/ConditionTables.jsx';
import ScoreReturnPanel from './strategyReplay/ScoreReturnPanel.jsx';
import ScoreFactorPanel from './strategyReplay/ScoreFactorPanel.jsx';
import StrategyVersions from './strategyReplay/StrategyVersions.jsx';
import BacktestReports from './strategyReplay/BacktestReports.jsx';
import TodoList from './strategyReplay/TodoList.jsx';
import { plotColors } from '../theme.js';

const CODE_KEY = 'chart_strategy_diag_code_react';

export default function StrategyReplay({ rows, fields = [], light, onLabel, onExclude, pendingLines, onConsumePendingLines }) {
  const [src, setSrc] = useState(() => localStorage.getItem(CODE_KEY) || '');
  const [sampleResults, setSampleResults] = useState([]); // 逐样本原始回放结果，供下面的明细表+条形图钻取用
  // 记录"产出当前 sampleResults 的那份代码"。下面所有统计表（硬性条件/因子/打分）都是这份代码
  // 真跑一遍 emit 出来的，不是对 src 做静态解析。所以只要 src 改了还没重跑，表里显示的就是
  // 上一版代码的结果——用它跟 src 比对，能明确提示"表格已过期"，避免"表里怎么有当前策略里
  // 没有的硬性条件"这种困惑（那些其实是上一次回放留下的）。
  const [ranCode, setRanCode] = useState(null);
  const [drillDown, setDrillDown] = useState(null); // 当前点开查看因子明细的那一行
  const [factorDrillName, setFactorDrillName] = useState(null); // 当前点开查看具体样本的那个打分因子名（勇者/邪恶阵营表）
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // 记"手动点过至少一次回放"这件事——判断要不要自动重跑，不能看 sampleResults.length：
  // run() 一开始就会把 sampleResults 清空成 []，运行期间这个数组本来就是空的，用它当判断
  // 依据会在重跑的瞬间误判成"从没跑过"。ref 不参与渲染，纯粹记一个状态标记用。
  const hasRunOnce = useRef(false);
  const [insField, setInsField] = useState();
  const [insOp, setInsOp] = useState('>');
  const [insVal, setInsVal] = useState(2);
  const [insCamp, setInsCamp] = useState('none'); // none=普通布尔条件 / hero=勇者(加分) / evil=危险区(扣分)
  // 调权建议"先试算再决定"的暂存：openPreview 算好前后指标后放这里，弹窗展示；确认才真写回代码
  const [preview, setPreview] = useState(null); // { title, before, after, next, removedLines, adjustedCount }
  // 已删因子回收站（持久化）——删掉的因子行原文留一份，可"加回来"
  const [removedFactors, setRemovedFactors] = useState(loadRemovedFactors);
  const fieldOptions = useGroupedFieldOptions(fields);
  // 存了一份回测报告后 +1，传给 TodoList 触发它重新算"哪天还没存档"——两个组件各自独立读
  // localStorage，不共享 state，用这个计数器当轻量的"该重新读一次了"信号。
  const [reportsVersion, setReportsVersion] = useState(0);

  // 把一条 check 追加到策略代码里。
  // 生成 f('字段') 形式——分析字段（features）在策略里要通过 f 访问，不能写 ctx.xxx
  //（很多字段是算出来的、ctx 里根本没有）。
  // 选了阵营（勇者/危险区）时，不再插入普通布尔 AND 条件，而是插入一条打分因子——
  // expect 文案按 parseFactorCheck 认得的格式写（"满分 lo~hi 权重 w" / "危险区 lo~hi 权重 w"），
  // 这样加完之后回放看板会自动把它归到对应阵营的因子表里。权重先统一用 FACTOR_WEIGHT_DEFAULT，
  // 别一个个纠结该给几分——等有真实回测数据了再回来统一校准（code-score.js 那次的教训：
  // 权重从来不是随手拍准的）。
  function insertCheck() {
    if (!insField) return;
    // 这个字段要是已经加过 check 了（不管是硬性条件还是已有的打分项/普通条件），都不让再加——
    // 已经是硬否决的话，能跑到打分环节的样本必然全满足它，当因子用没有区分度；已经加过打分项/
    // 普通条件的话，重复加只会撞出两行同名/同字段的 check，行为以谁在数组里更靠后生效为准，
    // 容易让人以为改了权重/区间却没生效。想调整的话，先用对应表格的"删除"按钮删掉旧的再重加。
    const conflict = findFieldConflict(src, insField);
    if (conflict) {
      message.warning(conflict.isVeto
        ? `「${insField}」已经是硬性条件（源码里的「${conflict.name}」一票否决），不能再加成打分项——能走到打分环节的样本必然全满足它，当因子用没有区分度`
        : `「${insField}」已经加过 check 了（源码里的「${conflict.name}」），不能重复添加——想改权重/区间，先用对应表格的"删除"按钮删掉旧的再重加`);
      return;
    }
    const label = (getFieldDesc(insField) || insField).replace(/[，。：（）"']/g, '').slice(0, 20) || insField;
    const cond = `f('${insField}') ${insOp} ${insVal}`;

    // 选了阵营、且这份策略本身是 ALL_CHECKS + VETO_NAMES 架构（code-score.js 那一路）时，
    // 不能走下面"独立 tuple"那条路——那种 tuple 只是 push 进 checks 数组给界面展示用，
    // 不会被这份策略自己的 for 循环读到，代码真跑起来对 total 贡献恒为 0（这正是上一轮
    // "总分为什么还是 0"那个问题的根源）。检测到这个架构就直接往 ALL_CHECKS 里插一行，
    // 不在 VETO_NAMES 里，天然走这份策略自己 for 循环的"打分"分支，真实计入 total。
    if (insCamp !== 'none' && hasAllChecksArchitecture(src)) {
      const bounds = campRangeBounds(insOp, insVal);
      if (!bounds) {
        message.warning('"!=" 没有自然对应的打分区间，阵营模式下不支持——改选"无(布尔条件)"，或换个操作符');
        return;
      }
      // 不传 label——让 buildAllChecksRow 用【完整字段名】当标签。截断成中文描述的话，打分因子
      // 表里查不回字段描述、删除/去重的字段匹配也对不上，得不偿失。
      const row = buildAllChecksRow({ field: insField, camp: insCamp, lo: bounds.lo, hi: bounds.hi, weight: FACTOR_WEIGHT_DEFAULT });
      const next = insertIntoAllChecks(src, row);
      save(next);
      setInsField(undefined);
      message.success(`已把「${insField}」加进 ALL_CHECKS（没放进 VETO_NAMES，走打分路径，真实计入 total）`);
      if (rows.length) run(next);
      return;
    }

    let line;
    if (insCamp === 'none') {
      line = `  ["${label}", ${cond}, f('${insField}'), "${insOp} ${insVal}"],`;
    } else {
      const range = campRangeText(insOp, insVal);
      if (!range) {
        message.warning('"!=" 没有自然对应的打分区间，阵营模式下不支持——改选"无(布尔条件)"，或换个操作符');
        return;
      }
      const prefix = insCamp === 'evil' ? '危险区' : '满分';
      const sign = insCamp === 'evil' ? '-' : '';
      line = `  ["${label}(分)", ${cond}, (f('${insField}')==null?'缺失':f('${insField}')) + ' → ' + (${cond} ? ${sign}${FACTOR_WEIGHT_DEFAULT} : 0).toFixed(1) + '分', "${prefix} ${range} 权重 ${FACTOR_WEIGHT_DEFAULT}"],`;
    }
    // 插入逻辑（找 var/const/let checks 声明插进去，找不到就补最小骨架）跟阵营库共用同一个
    // insertLineIntoStrategySrc——包括"插入行后必须换行，不能粘住原来紧跟 [ 的内容（比如收尾的
    // ]）"这条教训，两处各写一份很容易改一处忘了另一处。
    const next = insertLineIntoStrategySrc(src, line);
    save(next);
    setInsField(undefined);   // 加完清空选择，给个"已加入"的反馈
    if (rows.length) run(next);   // 加完立刻真跑一遍——用真实执行结果说话，不猜
  }

  // codeOverride：加/删/改权重这些操作改完代码后想立刻拿新代码重新回放，但 setSrc 是异步的，
  // 这一帧里 src 状态还没更新——直接把新代码传进来跑，不依赖 state 是否已经 flush。
  // 不省略这一步的话，"加一个条件就该自动回测"就会看到的是上一次的旧结果，等于白加。
  // 只认字符串——按钮 onClick 若不小心直接传了 run（而不是 () => run()），React 会把原生
  // event 对象塞进第一个参数，之前踩过这个坑：event 不是字符串，compileStrategy 内部
  // src.replace(...) 直接抛错且没被兜住，整个回放静默失败、连报错都看不到。
  async function run(codeOverride) {
    hasRunOnce.current = true;
    const code = typeof codeOverride === 'string' ? codeOverride : src;
    setErr(''); setSampleResults([]); setDrillDown(null);
    const compiled = compileStrategy(code);
    if (compiled.error) { setErr('策略编译失败：' + compiled.error); return; }
    if (!compiled.capturedDecl) {
      setErr('没能在策略里找到 checks 声明。请确保代码里有 const checks = [...]，否则只能看到最终通过与否，看不到逐条明细。');
    }
    setBusy(true); await new Promise(r => setTimeout(r, 0));
    try {
      // 不做任何"总分"校正/独立重算——这里的 res 就是策略代码真实执行出来的原样结果。
      // 之前试过在这里按 checks 数组自己重新求和覆盖"总分"，图的是让手插的因子行也能计入分数，
      // 但那是拿工具自己的假设（简单加总）去猜策略实际怎么算分——策略完全可能有非线性组合、
      // 封顶、四舍五入等真实执行里才有的行为，猜出来的数字未必和真跑一遍一样，反而不可信。
      // 正确做法是这里：加/删/改权重之后【自动重新真跑一遍】（见 insertCheck/removeCheckFromCode/
      // applyRecommendedWeights 里的 run(next) 调用），看到的永远是这份代码本身算出来的东西。
      const results = rows.map(row => ({ input: row.tokenAddress, row, res: runStrategyOnRow(compiled, row) }));
      setSampleResults(results); // 留原始逐行结果，供下面的统计聚合、"逐样本打分明细"表钻取
      setRanCode(code); // 记下产出这批结果的代码，供"表格是否已过期"比对

    } finally { setBusy(false); }
  }

  // 手动改代码框（直接输入、或整段粘贴替换成新版本）不会自动触发上面这几个按钮各自带的
  // run(next) 调用——之前的真实反馈："更新策略字段后这个（统计面板）没有更新"，因为
  // 用户是直接编辑/粘贴代码框，不是走"按字段追加条件"这类会自动重跑的入口。这里补一个
  // 通用兜底：只要已经手动点过至少一次回放（hasRunOnce），代码改动后就自动重新跑一遍，
  // 不用每次改完还要记得再点按钮。防抖 800ms 而不是每次按键都跑——不然连续打字/粘贴的
  // 中间态语法通常是不完整的，逐键触发编译只会闪一堆假的"策略编译失败"。
  useEffect(() => {
    if (!hasRunOnce.current || !rows.length) return;
    const timer = setTimeout(() => { run(); }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // 人工把某个 CA 标"垃圾"后，applyLabels 会把它的 returnMax 降级成 1.0x（见 labels.js），
  // 这里透传的 rows 就是标注生效之后的最新版本。checks/score 只读 ctx，不依赖 returnMax，
  // 不需要为了让胜率/中位数吃到最新标注就重新跑一遍策略（那才是真正耗时的部分）——
  // 只要把已经跑过的每条结果里的 row 换成 rows 里同一个 tokenAddress 的最新对象即可。
  const freshResults = useMemo(() => {
    if (!sampleResults.length) return sampleResults;
    const byAddr = new Map(rows.map(r => [r.tokenAddress, r]));
    return sampleResults.map(r => {
      const fresh = byAddr.get(r.row.tokenAddress);
      return fresh ? { ...r, row: fresh } : r;
    });
  }, [sampleResults, rows]);

  const agg = useMemo(() => (freshResults.length ? aggregateCheckStats(freshResults) : null), [freshResults]);
  // 打分版策略（checks 里有 '总分' + '满分 a~b 权重 w' 因子行）额外做得分口径的聚合
  const scoreAgg = useMemo(() => (freshResults.length ? aggregateScoreStats(freshResults) : null), [freshResults]);
  // 按名字（而不是直接存整个因子对象）记录当前钻取的是哪个因子——这样标垃圾之后 scoreAgg
  // 重新聚合，这里能自动拿到重新算过的最新样本列表（含最新 returnMax/label），不会停在
  // 点开那一刻的旧快照上（那样标完垃圾，弹窗里显示的还是没降级前的倍数，看着像没生效）。
  const factorDrill = useMemo(() => scoreAgg?.factors.find(f => f.name === factorDrillName) ?? null,
    [scoreAgg, factorDrillName]);

  // 硬性条件清单：agg.ranked 里 expect 文案不含"权重"字样的就是硬否决项（打分因子的 expect
  // 固定是"满分 x~y 权重 w"格式，见 SCORE_FACTOR_EXPECT_RE）。哪怕策略全是硬条件、一个打分项
  // 都没有（比如现在这份 v1.0.1 field 集全平移过来的版本），这里也能正常列出来——不依赖
  // scoreAgg（那个只在识别到打分因子时才非空），单纯读 agg 就够。
  const hardConditions = useMemo(() => {
    if (!agg) return [];
    return agg.ranked.filter(st => st.name !== '总分' && !/权重/.test(String(st.expect || '')));
  }, [agg]);

  // 因子有效性一键分析：不管一项现在是硬条件还是打分项，只要它的"实际值"能解析出一个
  // 有限数字，就把它跟 log(收益) 算单变量相关性——这是判断"这项该不该挪进打分池、
  // 该给多大权重"的直接依据，之前几轮都是手写 node 脚本干这件事，现在收进工具里。
  // 硬条件的 value 是纯数字字符串（比如"1800"）；打分因子的 value 是"25 → 1.0分"这种带
  // 箭头的格式；平台/AO 这类值本身不是单个数字（地址、"5.00e+0/3.00e+0"）解析不出来就跳过，
  // 不强算一个没意义的数字。
  const factorEffectiveness = useMemo(() => {
    if (!freshResults.length) return [];
    const byName = new Map();
    for (const r of freshResults) {
      const res = r.res;
      if (!res || res.error || !Array.isArray(res.checks)) continue;
      const ret = Number(r.row.returnMax);
      if (!Number.isFinite(ret) || ret <= 0) continue;
      const logRet = Math.log(ret);
      for (const c of res.checks) {
        if (c.name === '总分') continue;
        const isFactor = /权重/.test(String(c.expect || ''));
        const rawName = isFactor ? c.name.replace(/\(分\)$/, '') : c.name;
        const valStr = String(c.value);
        let val = null;
        const arrowMatch = valStr.match(/^(-?[\d.]+)\s*→/);
        if (arrowMatch) val = parseFloat(arrowMatch[1]);
        else if (Number.isFinite(Number(valStr)) && valStr.trim() !== '') val = Number(valStr);
        if (val === null) continue;
        if (!byName.has(rawName)) byName.set(rawName, { pairs: [], isFactor, expect: c.expect });
        byName.get(rawName).pairs.push([val, logRet]);
      }
    }
    const out = [];
    for (const [name, { pairs, isFactor, expect }] of byName) {
      if (pairs.length < 20) continue;
      const r = pearson(pairs);
      out.push({ name, n: pairs.length, r, p: pearsonPValue(r, pairs.length), isFactor, expect });
    }
    out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    return out;
  }, [freshResults]);

  // 推荐权重：只给"当前已经是打分项"的字段算——硬条件字段就算相关性再强，权重改了也不生效
  // （还在 VETO_NAMES 里），要不要把它挪进打分组是判断题，工具不替你做这个决定，
  // 只负责把已经在打分池里的这些字段，权重按 |r| 等比例缩放（最强的那个给 10，其余按比例，
  // 下限 1——不能有字段权重变 0，见 code-score.js 那次"占位 0 没人记得改"的教训）。
  const recommendedWeights = useMemo(() => {
    const factorRows = factorEffectiveness.filter(f => f.isFactor);
    if (!factorRows.length) return [];
    const maxAbsR = Math.max(...factorRows.map(f => Math.abs(f.r)));
    if (!(maxAbsR > 0)) return [];
    return factorRows.map(f => ({ ...f, recommended: Math.max(1, Math.round(10 * Math.abs(f.r) / maxAbsR)) }));
  }, [factorEffectiveness]);

  // 一键把推荐权重写回代码框：在源码文本里找 ['字段名', ... , 权重数字, ... 这一行，替换权重数字。
  // 只动权重（第 3 个数字），不碰区间/lo0/lo1/hi1/hi0——区间形状改动风险更高，这次先不做。
  function applyRecommendedWeights() {
    if (!recommendedWeights.length) return;
    const { next, appliedCount } = applyWeightsToSrc(src, recommendedWeights.map(f => ({ name: f.name, weight: f.recommended })));
    if (appliedCount === 0) {
      message.warning('代码里没能匹配到这些字段对应的行，可能是数组写法跟预期的 [\'字段名\', 值, 权重, ...] 不一样，需要手动改');
      return;
    }
    save(next);
    message.success(`已把 ${appliedCount} 个字段的权重更新到代码里，重新回放看效果`);
    if (rows.length) run(next);
  }

  // 跨天累计判定：把今天这次回放的实时判定接到历史报告的逐日判定前面，连续 N 天同向才算数。
  // reportsVersion 变（存了新报告）就重新读一次存档，保证攒的天数是最新的。
  // 回放时间基准的自动检测：数策略里几处"读当前时间"（回放时已全部冻结到信号买入时刻），
  // 并挑出可能被当成"现在"用的快照导出时刻字段（未来函数隐患）。给下方看板备注用。
  const timeReads = useMemo(() => detectTimeReads(src), [src]);

  // 策略代码规范校验：实时扫编辑框代码，列出违规（error/warn），可自动修的给「修正」按钮。
  // 逻辑在 lib/strategySpec.js（同一套供单测和 lint 脚本复用），见 策略代码规范.md。
  const specViolations = useMemo(() => checkStrategySpec(src), [src]);
  const applyOneFix = (id) => { const next = applySpecFix(src, id); save(next); if (rows.length) run(next); };
  const applyAllFixes = () => { const next = applyAllSpecFixes(src); save(next); if (rows.length) run(next); };

  const reports = useMemo(() => loadBacktestReports(), [reportsVersion]);
  const crossDayOf = useMemo(() => (f) => crossDayVerdict({
    name: f.name, todayStats: f, reports, todayDate: todayDateStr(), minStreak: CROSS_DAY_MIN_STREAK,
  }), [reports]);

  // 把一批因子按各自的调权建议拼成一个 changeSet（要调的权重 + 要删的因子）——单条应用传一个因子，
  // 批量应用传全部因子。判定走跨天累计（crossDayOf）：没连够 N 天同向的（hold）自然不进 changeSet，
  // insufficient/none 的也不进。这样"试算全部"只会动那些连续几天都判反向/有效的因子。
  function buildSuggestionChangeSet(factorList) {
    const adjusts = [], removes = [];
    for (const f of factorList) {
      const { verdict } = crossDayOf(f);
      const suggestion = suggestWeightAdjustment(verdict, f.weight);
      if (suggestion.action === 'adjust') adjusts.push({ name: f.name, weight: suggestion.newWeight });
      // scoreAgg.factors 的条目全部是打分因子，候选标签跟 removeCheckFromCode 一致（可能带 "(分)"）
      else if (suggestion.action === 'remove') removes.push({ name: f.name, candidates: [`${f.name}(分)`, f.name] });
    }
    return { adjusts, removes };
  }

  // 「先试算再决定」核心：把 changeSet 套进代码得到 next，但【不写回】——先拿旧代码和 next
  // 各在当前样本上跑一遍算顶层指标（命中率/中位数/r(log)/单调性），并排放进弹窗给人看。
  // 确认了才 confirmPreview 真写回。这样删/调之前先看到"提升还是变差"，杜绝盲目一键掏空策略。
  function openPreview(changeSet, title) {
    if (!changeSet.adjusts.length && !changeSet.removes.length) {
      message.info('当前没有需要调整的因子（都是 有效/分不出真假/样本不够，没有建议）');
      return;
    }
    if (!rows.length) { message.warning('还没有样本数据，无法试算——先在上方选数据回放'); return; }
    const { next, adjustedCount, removedLines } = applyChangeSetToSrc(src, changeSet);
    if (adjustedCount === 0 && removedLines.length === 0) {
      message.warning('代码里没能匹配到这些因子对应的行，可能数组写法不是预期的 ALL_CHECKS 形状，需要手动改');
      return;
    }
    const before = computeStrategyMetrics(src, rows);
    const after = computeStrategyMetrics(next, rows);
    // 样本外落地闸门（用户选的 B 方案）：把工作集按时间切 70/30，只在【测试段】（样本外、没参与
    // 调参的那批）复算一遍 ρ。因子建议是拿全量判出来的，测试段是它没见过的时间段——如果这次改动
    // 在测试段上把 ρ 搞差了，多半是过拟合到了训练段的噪声，就该被拦下（confirmPreview 里 gate）。
    // 测试段太小（<30 条）时 ρ 本身就不可信，不硬拦，只在弹窗里注明"样本外验证不了"。
    const OOS_MIN_TEST = 30;
    const { test: testRows } = splitTrainTest(rows, 'time', 0.7, 'swapBeginTime');
    const oos = (testRows.length >= OOS_MIN_TEST)
      ? { n: testRows.length, before: computeStrategyMetrics(src, testRows), after: computeStrategyMetrics(next, testRows) }
      : { n: testRows.length, tooSmall: true };
    setPreview({ title, before, after, oos, next, removedLines, adjustedCount, changeSet });
  }

  // 确认应用试算：真写回代码 + 把删掉的因子塞进回收站 + 重跑
  function confirmPreview() {
    if (!preview) return;
    save(preview.next);
    if (preview.removedLines.length) {
      let list = removedFactors;
      for (const r of preview.removedLines) list = addRemovedFactor(list, r);
      setRemovedFactors(list); saveRemovedFactors(list);
    }
    message.success(`已应用：调整 ${preview.adjustedCount} 个、删除 ${preview.removedLines.length} 个，已重新回放`);
    if (rows.length) run(preview.next);
    setPreview(null);
  }

  // 单条 / 批量都走试算弹窗（用户选的是"先试算再决定"）
  function previewWeightSuggestion(factor) {
    openPreview(buildSuggestionChangeSet([factor]), `试算调权建议：${factor.name}`);
  }
  function previewAllWeightSuggestions() {
    if (!scoreAgg) return;
    openPreview(buildSuggestionChangeSet(scoreAgg.factors), '试算全部调权建议');
  }

  // 加回来：把回收站里某条被删的因子行原样塞回代码 + 重跑 + 从回收站移除
  function restoreRemovedFactor(item) {
    const next = reAddFactorLine(src, item.line);
    save(next);
    const list = dropRemovedFactor(removedFactors, item.id);
    setRemovedFactors(list); saveRemovedFactors(list);
    message.success(`已把「${item.name}」加回策略代码，重新回放看效果`);
    if (rows.length) run(next);
  }

  // 因子有效性表格里直接删掉某个 check：按行匹配 ["标签", ... 开头的这一行（跟 insertCheck/
  // applyRecommendedWeights 生成代码的格式一致，都是单行一条 check）。打分因子的标签
  // 带 "(分)" 后缀（factorEffectiveness 里的 name 已经把这个后缀剥掉了，删的时候要补回来
  // 才能匹配上源码里的真实标签）。
  // 不能简单删掉整行——旧版本插入逻辑有过一个真实事故：插入新 check 时紧跟在 "[" 后面的
  // 内容（比如 const checks = [] 这种空数组场景下收尾的 "]"）会被粘到插入行的行尾，
  // 之后这里按整行删除就把那个收尾的 "]" 也一起删了，数组从此不闭合，编译直接报错
  // Unexpected token 'for'。插入逻辑已经修了（保证换行不再粘连），但这里也做防御：
  // 按括号计数找到这条 check tuple 自己的收尾 "]"，只删 tuple 本身，tuple 之后如果还粘着
  // 别的内容（哪怕只是一个孤零零的 "]"），保留下来，不能陪葬。
  // 打分因子在源码里可能是两种完全不同的写法，标签形态还不一样，得都试一遍：
  //   (a) 独立 tuple（insertCheck/阵营库的老路径）：源码里字面量就带 "(分)" 后缀，双引号——
  //       ["标签(分)", ...]
  //   (b) ALL_CHECKS 行（insertCheck 检测到 ALL_CHECKS 架构后走的新路径）：源码里没有 "(分)"
  //       后缀（那是运行时 name + '(分)' 拼出来的，不在源码字面量里），单引号——['标签', ...]
  // 引号种类用字符类兼容，不用管到底是哪种——重点是先用宽松规则定位到这一行，
  // 真正严谨的"找到这条 tuple 自己的收尾括号"交给下面的括号计数扫描。
  function removeCheckFromCode(f) {
    const candidates = f.isFactor ? [`${f.name}(分)`, f.name] : [f.name];
    const { next, removedLine } = removeCheckLineFromSrc(src, candidates);
    if (removedLine == null) {
      message.warning('代码里没能找到这一行（可能格式跟预期的 [\'标签\'/"标签", ...] 不一致），需要手动删');
      return;
    }
    save(next);
    // 删掉的因子进回收站，可"加回来"——手动删的（因子有效性表）跟建议删的（试算确认）都记，口径一致
    const list = addRemovedFactor(removedFactors, { name: f.name, line: removedLine });
    setRemovedFactors(list); saveRemovedFactors(list);
    message.success(`已从代码里删除「${f.name}」这条 check，重新回放看效果`);
    if (rows.length) run(next);
  }

  // score vs 收益：不依赖 scoreAgg（那个要求打分池非空才非 null）——只要 checks 里能找到
  // "总分"这一行就取，哪怕像现在这份 v2.0.0（12 项全是硬条件、打分池是空的）score 恒为
  // 占位的 100，也应该老实展示出来"没有变化，算不出相关性"，而不是这个面板直接消失，
  // 不然会让人以为"没显示=还没测"，而不是"当前架构下这个指标根本没意义"。
  const scoreReturnPairs = useMemo(() => {
    const out = [];
    for (const r of freshResults) {
      const res = r.res;
      if (!res || res.error || !Array.isArray(res.checks)) continue;
      const totalCheck = res.checks.find(c => c.name === '总分');
      if (!totalCheck) continue;
      const score = parseFloat(totalCheck.value);
      const ret = Number(r.row.returnMax);
      if (!Number.isFinite(score) || !Number.isFinite(ret) || ret <= 0) continue;
      out.push({ score, ret, symbol: r.row.symbol, addr: r.row.tokenAddress, swapBeginTime: r.row.swapBeginTime });
    }
    return out;
  }, [freshResults]);

  const scoreReturnStats = useMemo(() => computeScoreReturnStats(scoreReturnPairs), [scoreReturnPairs]);

  // 北极星提示：单调性 ρ（score↔returnMax 的 spearman，就是散点图底下那个 ρ）是这个项目的
  // 唯一北极星指标。用户要求"以后有改动就提示我"——不只调权建议试算，任何触发重跑的改动
  // （手动改代码、加条件、应用推荐权重、标垃圾改 returnMax、切过滤条件……）只要让 ρ 变了，
  // 就弹一个 toast 报"ρ 前→后、变强/变弱"。变化 <0.005 不打扰（浮点抖动/无实质变化）；
  // 第一次算出来没有对比基准，也不提示。ρ 变强用 success（绿）、变弱用 warning（黄）提醒。
  const prevRhoRef = useRef(null);
  useEffect(() => {
    const rho = (scoreReturnStats && !scoreReturnStats.constant && Number.isFinite(scoreReturnStats.rho))
      ? scoreReturnStats.rho : null;
    if (rho == null) return;
    const prev = prevRhoRef.current;
    prevRhoRef.current = rho;
    if (prev == null || Math.abs(rho - prev) < 0.005) return;
    const up = rho > prev;
    const txt = `北极星·单调性 ρ ${prev.toFixed(3)} → ${rho.toFixed(3)}（${up ? '↑ 变强，高倍更集中到高分' : '↓ 变弱，注意别把图搞散了'}）`;
    if (up) message.success(txt); else message.warning(txt);
  }, [scoreReturnStats]);

  // score 分位桶 vs 胜率：调 CUTOFF 之前先看这个表——不单调就别调阈值（见 computeScoreBuckets 注释）
  const scoreBuckets = useMemo(
    () => (scoreReturnStats && !scoreReturnStats.constant ? computeScoreBuckets(scoreReturnPairs) : null),
    [scoreReturnStats, scoreReturnPairs]);

  // 样本外验证：按买入前的开盘时间切 70/30（跟"强势盘"权重调优那次用的同一个切分口径），
  // 训练集显著不代表数——之前调权重时训练集看着都不错，测试集才暴露出哪些是真信号。
  const [oosEnabled, setOosEnabled] = useState(false);
  const scoreReturnOOS = useMemo(() => {
    if (!oosEnabled || scoreReturnPairs.length < 20) return null;
    const { train, test } = splitTrainTest(scoreReturnPairs, 'time', 0.7, 'swapBeginTime');
    return { train: computeScoreReturnStats(train), test: computeScoreReturnStats(test) };
  }, [oosEnabled, scoreReturnPairs]);

  const scoreScatterFig = useMemo(() => {
    if (!scoreReturnStats || scoreReturnStats.constant) return null;
    const c = plotColors(!light);
    const sorted = scoreReturnPairs;
    return {
      traces: [{
        type: 'scatter', mode: 'markers',
        x: sorted.map(p => p.score), y: sorted.map(p => p.ret),
        text: sorted.map(p => `${p.symbol || ''}  score=${p.score.toFixed(1)}  ${p.ret.toFixed(2)}x`),
        hovertemplate: '%{text}<extra></extra>',
        marker: { color: '#0a84ff', opacity: 0.65, size: 7 },
      }],
      layout: {
        height: 340, margin: { t: 20, b: 40, l: 55, r: 20 },
        paper_bgcolor: c.paperBg, plot_bgcolor: c.paperBg, font: { color: c.textColor, size: 12 },
        xaxis: { title: { text: '总分 score' }, ...c.axis },
        yaxis: { title: { text: 'returnMax（对数轴）' }, type: 'log', ...c.axis },
      },
    };
  }, [scoreReturnStats, scoreReturnPairs, light]);

  // 逐样本表的数据源：只有识别为打分版（scoreAgg 非空）才有意义展示"总分"这一列。
  // 这张表理应只包含硬否决已经通过的样本（"通过"栏本该等价于纯粹的 score>=cutoff）——
  // 但不做静默过滤：一旦真的出现硬条件没过的样本混进来（vetoOk===false），不藏起来，
  // 而是把 vetoOk 带出去让表格用红色整行标出来，这样"63.9分通过、61.1分未过"这种异常
  // 一眼就能看出是"被硬条件拦了"而不是分数逻辑本身有问题（跟 aggregateScoreStats 同一套判定）。
  const sampleRows = useMemo(() => {
    if (!scoreAgg) return [];
    const out = [];
    for (const r of freshResults) {
      const res = r.res;
      if (!res || res.error || !Array.isArray(res.checks)) continue;
      const totalCheck = res.checks.find(c => c.name === '总分');
      if (!totalCheck) continue;
      const score = parseFloat(totalCheck.value);
      if (!Number.isFinite(score)) continue;
      let vetoOk = true;
      for (const c of res.checks) {
        if (c === totalCheck) continue;
        if (!parseFactorCheck(c) && !c.ok) { vetoOk = false; break; }
      }
      out.push({
        id: r.row.id, symbol: r.row.symbol, addr: r.row.tokenAddress,
        ret: Number(r.row.returnMax), score, passed: !!res.passed, vetoOk, checks: res.checks,
        label: r.row.label || null,
      });
    }
    return out;
  }, [freshResults, scoreAgg]);

  // 点开一行看到的条形图：按贡献升序排列后交给 Plotly 画横向条，配合 autorange:'reversed'
  // 让贡献最大的排在最上面；勇者阵营贡献恒 >=0、邪恶阵营恒 <=0，按符号上色天然对应两个阵营
  const barFigure = useMemo(() => {
    if (!drillDown) return null;
    const c = plotColors(!light);
    const items = drillDown.checks.map(c2 => parseFactorCheck(c2)).filter(f => f && Number.isFinite(f.contrib))
      .sort((a, b) => a.contrib - b.contrib);
    if (!items.length) return null;
    return {
      traces: [{
        type: 'bar', orientation: 'h',
        x: items.map(f => f.contrib),
        y: items.map(f => f.name),
        marker: { color: items.map(f => (f.contrib >= 0 ? '#30d158' : '#ff453a')) },
        text: items.map(f => (f.missing ? '缺失 · ' : '') + (f.contrib >= 0 ? '+' : '') + f.contrib.toFixed(1)),
        textposition: 'outside', textfont: { color: c.textColor },
      }],
      layout: {
        height: Math.max(220, items.length * 30 + 60),
        margin: { l: 170, r: 50, t: 10, b: 40 },
        paper_bgcolor: c.paperBg, plot_bgcolor: c.paperBg, font: { color: c.textColor, size: 12 },
        xaxis: { title: { text: '得分贡献（正=勇者阵营加分，负=邪恶阵营减分）' }, zeroline: true,
                 zerolinecolor: c.axis.zerolinecolor, zerolinewidth: 2, ...c.axis },
        yaxis: { ...c.axis },
      },
    };
  }, [drillDown, light]);

  // 点开一行时，如果这条样本是被硬否决拦下的（vetoOk===false），把具体是哪几条硬条件没过
  // 列出来——parseFactorCheck 认不出打分因子的 check 才是硬条件（排除总分行），跟 sampleRows
  // 计算 vetoOk 用的是同一套判定，保证"整行标红的原因"和这里列出来的原因一定对得上。
  const failedVetoes = useMemo(() => {
    if (!drillDown) return [];
    return drillDown.checks.filter(c => c.name !== '总分' && !parseFactorCheck(c) && !c.ok);
  }, [drillDown]);

  const save = v => { setSrc(v); try { localStorage.setItem(CODE_KEY, v); } catch { /* 隐私模式 */ } };

  // 从策略版本库加载一份存档：覆盖编辑框内容，跟"直接手动粘贴一份新代码"是同一件事，
  // 所以复用同一套自动重跑逻辑——已经跑过一次的话（hasRunOnce）改 src 会触发上面那个
  // 800ms 防抖的 useEffect 自动重新回放，这里不用再手动调一次 run()。
  function loadVersion(code) {
    save(code);
    message.success('已加载到编辑框');
  }

  // 阵营库"发送到策略"落地的地方：外层(App.jsx)把待插入的原始收藏记录（{field,camp,lo,hi,weight}）
  // 放进 pendingLines 这个队列传进来，这里消费掉、插进代码框、再让外层清空队列。不能指望外层
  // 直接改这个组件的 localStorage 生效——这个组件常驻挂载（App.jsx 用了
  // destroyInactiveTabPane={false}），src 是它自己的 state，不会因为别处写了 localStorage 就
  // 重新读取；用 props 传队列才是可靠的跨组件通信方式。
  // 传的是原始记录而不是提前拼好的字符串——插到 ALL_CHECKS 还是插独立 tuple，取决于这份策略
  // 自己是什么架构（只有这个组件自己拿得到当前的 src），拼字符串这一步不能提前在 App.jsx 做。
  useEffect(() => {
    if (!pendingLines || !pendingLines.length) return;
    let next = src;
    let inserted = 0, updated = 0;
    const vetoSkipped = []; // 已是硬性条件的字段：改成打分项没意义（能进打分环节的样本必满足它），跳过
    for (const entry of pendingLines) {
      const conflict = findFieldConflict(next, entry.field);
      // 已经是硬否决 → 跳过（加成打分项无区分度）；已是打分项 → upsert：先删旧行再插新行（更新区间/权重）；
      // 不存在 → 直接插入。这样阵营库里"修正"后再发送，策略里的打分项会被更新，而不是撞出重复行。
      if (conflict && conflict.isVeto) { vetoSkipped.push(entry.field); continue; }
      if (conflict) { next = removeCheckLineByField(next, entry.field).next; updated++; }
      else inserted++;
      next = hasAllChecksArchitecture(next)
        ? insertIntoAllChecks(next, buildAllChecksRow(entry))
        : insertLineIntoStrategySrc(next, buildCampCheckLine(entry));
    }
    save(next);
    if (inserted || updated) message.success(`已从阵营库${inserted ? `插入 ${inserted} 条` : ''}${inserted && updated ? '、' : ''}${updated ? `更新 ${updated} 条` : ''} check，重新回放看效果`);
    if (vetoSkipped.length) message.warning(`${vetoSkipped.join('、')} 已是硬性条件（一票否决），未改成打分项`);
    onConsumePendingLines?.();
    if ((inserted || updated) && rows.length) run(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLines]);

  return (
    <Card size="small" title="策略回放看板"
      extra={<Space>
        <Button onClick={() => save('')}>清空</Button>
        <Button type="primary" loading={busy} onClick={() => run()} disabled={!src.trim() || !rows.length}>
          在当前数据源回放（{rows.length} 条）</Button>
      </Space>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        把策略代码在当前工作集的每条样本上逐条重跑。Date 会被冻结在各样本的买入时刻、ctx 用浅拷贝——
        策略里读到的是"当时"而不是"现在"，不会有未来函数。
      </Typography.Paragraph>
      {/* 回放时间基准备注：把"当前时间已冻结到信号买入时刻"这件事在看板上显式说清楚，
          并顺带自动检测策略里读当前时间的写法数 + 可能的未来函数字段。 */}
      <Alert type="info" showIcon style={{ marginBottom: 8 }}
        message={<span style={{ fontSize: 12 }}>
          ⏱ <b>回放时间基准</b>：策略里所有「当前时间」读取（<code>Date.now()</code> / <code>new Date()</code> / <code>getTime()</code>
          {timeReads.count > 0 ? <>，本策略检测到 <b>{timeReads.count}</b> 处</> : '（本策略未检测到）'}）
          在回放时已<b>自动冻结到每个样本的「信号买入时刻」</b>——只在编译时注入，<b>不改动你的代码一个字</b>，
          贴到线上照常用 <code>Date.now()</code> 也不会有 bug。
        </span>}
        description={timeReads.lookaheadFields.length > 0 ? (
          <span style={{ fontSize: 12 }}>
            ⚠️ 另检测到策略读了 <code>{timeReads.lookaheadFields.join('、')}</code>——这些是<b>快照导出时刻</b>（晚于买入），
            若当成「现在」用属于未来函数，冻结 Date 纠正不了，请人工核对是不是拿它跟买入时刻做时间差。
          </span>
        ) : null} />
      <TodoList refreshKey={reportsVersion} />
      <Space wrap style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>按字段追加条件：</Typography.Text>
        <Select showSearch placeholder="选字段" style={{ width: 300 }} value={insField} onChange={setInsField}
          options={fieldOptions} optionRender={renderFieldOption} filterOption={fieldFilterOption} listHeight={420} />
        <Select value={insOp} onChange={setInsOp} style={{ width: 80 }}
          options={['>', '>=', '<', '<=', '==', '!='].map(o => ({ value: o, label: o }))} />
        <InputNumber value={insVal} onChange={v => setInsVal(v ?? 0)} style={{ width: 110 }} />
        <Select value={insCamp} onChange={setInsCamp} style={{ width: 150 }}
          title="选阵营就不再插入普通布尔条件，改成插入一条打分因子（权重先统一给同一个数，等有回测数据再校准）"
          options={[
            { value: 'none', label: '无（布尔条件）' },
            { value: 'hero', label: '🛡 勇者（加分）' },
            { value: 'evil', label: '☠ 危险区（扣分）' },
          ]} />
        <Button icon={<PlusOutlined />} onClick={insertCheck} disabled={!insField}>加进策略代码</Button>
      </Space>
      <Input.TextArea value={src} onChange={e => save(e.target.value)} rows={10} spellCheck={false}
        style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
        placeholder={'const checks = [\n  ["买家数", ctx.buyer_count > 100, ctx.buyer_count, "> 100"],\n];\nreturn checks.every(c => c[1]);'} />

      {/* 策略代码规范校验：贴/改代码后实时提示违规，可自动修的一键修正（详见 策略代码规范.md）。 */}
      {src.trim() && specViolations.length > 0 && (
        <Alert type={specViolations.some(v => v.level === 'error') ? 'error' : 'warning'} showIcon style={{ marginTop: 8 }}
          message={
            <span style={{ fontSize: 12 }}>
              策略规范校验：{specViolations.filter(v => v.level === 'error').length} 个错误、
              {specViolations.filter(v => v.level === 'warn').length} 个警告
              {specViolations.some(v => v.fixable) && (
                <Button size="small" type="primary" ghost style={{ marginLeft: 10 }} onClick={applyAllFixes}>
                  一键全修（可自动修的）
                </Button>
              )}
            </span>
          }
          description={
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {specViolations.map(v => (
                <div key={v.id} style={{ marginBottom: 6, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <Tag color={v.level === 'error' ? 'error' : 'warning'} style={{ margin: 0, flexShrink: 0 }}>
                    {v.level === 'error' ? '错误' : '警告'}
                  </Tag>
                  <span>
                    <b>{v.title}</b>
                    {v.extra && v.extra.length ? <span style={{ color: 'var(--muted,#8e8e93)' }}>（{v.extra.join('、')}）</span> : null}
                    <br /><span style={{ opacity: .75 }}>{v.detail}</span>
                    {v.fixable && (
                      <Button size="small" type="link" style={{ padding: '0 6px' }} onClick={() => applyOneFix(v.id)}>修正这条</Button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          } />
      )}

      <StrategyVersions code={src} onLoad={loadVersion} />
      <BacktestReports agg={agg} scoreAgg={scoreAgg} scoreReturnStats={scoreReturnStats} scoreBuckets={scoreBuckets}
        code={src} light={light} onSaved={() => setReportsVersion(v => v + 1)} />
      {err && <Alert type="warning" showIcon style={{ marginTop: 12 }} message={err} />}

      {/* 表格已过期提示：src 改了但还没重跑（ranCode 是上一次回放的代码）。下面所有表都是 ranCode
          跑出来的，跟当前 src 不一致时明说，免得把上一版策略的硬性条件/因子误当成"当前策略里的"。 */}
      {agg && ranCode !== null && ranCode !== src && (
        <Alert type="warning" showIcon style={{ marginTop: 12 }}
          message={busy ? '代码已改动，正在按新代码重新回放…' : '⚠️ 代码已改动，下面的表格还是上一次回放的结果（不是当前代码）'}
          description={busy ? null : <span style={{ fontSize: 12 }}>
            下面的硬性条件/因子/打分表都是<b>上一次真实回放</b> emit 出来的，不是对当前代码做静态解析。
            稍候会自动重新回放；想立即刷新，点右上角「在当前数据源回放」。
          </span>} />
      )}

      {agg && (
        <>
          <Row gutter={16} style={{ marginTop: 16 }}>
            <Col><Statistic title="回放样本" value={agg.total} /></Col>
            {scoreAgg && Number.isFinite(scoreAgg.cutoff) && (
              <Col><Statistic title="打分阈值" value={scoreAgg.cutoff} suffix="分通过"
                valueStyle={{ color: '#ff9f0a' }} /></Col>
            )}
            <Col><Statistic title="策略命中" value={agg.hits} valueStyle={{ color: '#0a84ff' }} /></Col>
            <Col><Statistic title="命中率" value={agg.valid ? (agg.hits / agg.valid * 100).toFixed(1) : '-'} suffix="%" /></Col>
            <Col><Statistic title="命中中位数" value={agg.hitRets.length ? median(agg.hitRets).toFixed(2) : '-'} suffix="x" /></Col>
            <Col><Statistic title="未命中中位数" value={agg.missRets.length ? median(agg.missRets).toFixed(2) : '-'} suffix="x" /></Col>
            {agg.errored > 0 && <Col><Statistic title="回放报错" value={agg.errored} valueStyle={{ color: '#ff453a' }} /></Col>}
          </Row>
          <HardConditionsTable hardConditions={hardConditions} />
          <FactorEffectivenessTable factorEffectiveness={factorEffectiveness} recommendedWeights={recommendedWeights}
            onApplyRecommendedWeights={applyRecommendedWeights} onRemoveCheck={removeCheckFromCode} />
          {/* 提前退出诊断：策略在 checks 赋值前 return 的样本没有逐条明细。
              直接说清楚原因，回答"就算没命中也要有拦截日志"。 */}
          {agg.noChecks > 0 && (
            <Alert type={agg.withChecks === 0 ? 'warning' : 'info'} showIcon style={{ marginTop: 12 }}
              message={
                <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                  <b>{agg.noChecks}</b> 条样本【在 checks 赋值前就 return 了】（其中未命中 {agg.noChecksMiss} 条），所以没有逐条 check 明细。
                  {agg.withChecks === 0 && <> 这就是下方"暂无数据"的原因——不是没跑，是策略在建 checks 数组前的前置判断（<code>if(...) return false</code>）就退出了。</>}
                  <br />常见原因：策略依赖的字段在当前数据源里缺失（比如 <code>ao_bars / chip_analysis</code> 没有），前置条件直接不满足。
                  {agg.noCheckReasons.length > 0 && (
                    <><br />退出原因样例：
                      {agg.noCheckReasons.map((x, i) => (
                        <div key={i} style={{ opacity: .75, paddingLeft: 8 }}>· {x.symbol}（{Number(x.ret).toFixed(2)}x）：{x.reason}</div>
                      ))}
                    </>
                  )}
                  <br />提示：这些样本已按未命中计入胜率/中位数。想看逐条明细，把策略里前置的 <code>return false</code> 改成把该条件也放进 checks 数组。
                </div>
              } />
          )}
          {/* 未命中的账拆开——回答"单点否决合计为什么对不上未命中数"：
              命中 + 只卡1条（= 各条单点否决之和）+ 卡≥2条 = 总数。
              差额就是被多条 check 同时拦掉的样本，放宽任何单一条件都还是过不了。 */}
          {agg.multiBlocked > 0 && (
            <Alert type="info" style={{ marginTop: 12 }} message={
              <span style={{ fontSize: 12 }}>
                未命中 {agg.valid - agg.hits} 条拆开看：只卡 1 条的 <b>{agg.soleBlocked}</b> 条
                （= 下方各条「单点否决」之和），被 ≥2 条同时拦掉的 <b>{agg.multiBlocked}</b> 条。
                后者放宽任何单一条件都还是过不了，所以不计入任何一条的单点否决——这就是单点否决合计
                （{agg.soleBlocked}）小于未命中数（{agg.valid - agg.hits}）的原因。
              </span>
            } />
          )}
          {agg.hitRets.length > 0 && agg.missRets.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12 }}
              dangerouslySetInnerHTML={{ __html: buildStrategyVerdict(agg.hitRets, agg.missRets) }} />
          )}
          <ScoreReturnPanel
            scoreReturnStats={scoreReturnStats} factorEffectiveness={factorEffectiveness}
            scoreScatterFig={scoreScatterFig} scoreBuckets={scoreBuckets}
            scoreReturnPairsLength={scoreReturnPairs.length}
            oosEnabled={oosEnabled} onOosEnabledChange={setOosEnabled} scoreReturnOOS={scoreReturnOOS} />
          <ScoreFactorPanel
            scoreAgg={scoreAgg} sampleRows={sampleRows} onLabel={onLabel} onExclude={onExclude}
            drillDown={drillDown} setDrillDown={setDrillDown} barFigure={barFigure} failedVetoes={failedVetoes}
            factorDrill={factorDrill} setFactorDrillName={setFactorDrillName}
            onApplyWeightSuggestion={previewWeightSuggestion}
            onApplyAllWeightSuggestions={previewAllWeightSuggestions}
            crossDayOf={crossDayOf}
            removedFactors={removedFactors} onRestoreFactor={restoreRemovedFactor} />
        </>
      )}
      <WeightSuggestionPreview preview={preview} onCancel={() => setPreview(null)} onConfirm={confirmPreview} />
    </Card>
  );
}

// 调权建议"试算"弹窗：把改动前后的顶层指标并排列出来——命中率、命中/未命中中位数、
// score-收益 r(log)、单调性ρ。绿色=这次调整让它变好，红色=变差，灰色=基本没动。
// 关键判断口径：这几个指标全是"越大越好"（命中率高、命中中位数高、r(log) 越正说明分数越能
// 排序收益、单调性越接近 1 越说明分越高越容易赢），所以 after>before 一律算改善。
// 用户可以据此决定到底确认应用还是取消——这就是"删了到底提升没有"的答案，也是删除是否
// 合理的验证：删完指标不降反升（或持平）才是合理的删除。
function WeightSuggestionPreview({ preview, onCancel, onConfirm }) {
  // 样本外闸门没过时，允许勾"仍要强制应用"覆盖——闸门是默认拦，但不剥夺你硬要落地的权利。
  // 每次换一次试算（preview 变化）都要重置这个勾，不能把上一次的强制状态带过来。
  const [forceApply, setForceApply] = useState(false);
  useEffect(() => { setForceApply(false); }, [preview]);
  if (!preview) return null;
  const { title, before, after, oos, removedLines, adjustedCount } = preview;
  const err = (before && !before.ok) ? before.error : (after && !after.ok ? after.error : null);
  const fmtPct = v => (v == null ? '-' : (v * 100).toFixed(1) + '%');
  const fmtX = v => (v == null ? '-' : v.toFixed(2) + 'x');
  const fmtR = v => (v == null ? '-' : v.toFixed(3));
  // 判定北极星＝score↔倍率的强单调性（spearman ρ），跟散点图底下那个 ρ 同口径：高倍集中高分、
  // 低倍落低分，越强越好。高倍率命中率（>2x/>5x/>10x）是"高倍有没有真的落到高分侧"的体现，共同判据。
  // 通过率中性不上色；r(log) 佐证。
  const hasRemoves = removedLines.length > 0;
  const fmtRho = v => (v == null ? '-' : v.toFixed(3));
  // 样本外闸门：测试段 ρ 前→后。可算（测试段够大、两头 ρ 都非空）时才纳入判定。
  const oosOk = oos && !oos.tooSmall && oos.before?.ok && oos.after?.ok
    && oos.before.spearmanRho != null && oos.after.spearmanRho != null;
  const dOosRho = oosOk ? oos.after.spearmanRho - oos.before.spearmanRho : null;
  const OOS_EPS = 1e-4;
  const oosWorse = oosOk && dOosRho < -OOS_EPS;   // 样本外明确变差 → 闸门拦下
  const metricRows = [
    { key: 'spearmanRho', label: '单调性 spearman ρ（分数↔倍率·核心）', b: before?.spearmanRho, a: after?.spearmanRho, fmt: fmtRho, strong: true },
    ...(oosOk ? [{ key: 'oosRho', label: `样本外·测试段单调性 ρ（落地闸门，n=${oos.n}）`, b: oos.before.spearmanRho, a: oos.after.spearmanRho, fmt: fmtRho, strong: true }] : []),
    { key: 'decileRho', label: '十分位单调性 ρ', b: before?.decileRho, a: after?.decileRho, fmt: fmtRho },
    { key: 'hit2', label: '通过组 >2x 命中率', b: before?.hit2, a: after?.hit2, fmt: fmtPct },
    { key: 'hit5', label: '通过组 >5x 命中率', b: before?.hit5, a: after?.hit5, fmt: fmtPct },
    { key: 'hit10', label: '通过组 >10x 命中率', b: before?.hit10, a: after?.hit10, fmt: fmtPct },
    { key: 'hitMedian', label: '通过组中位数', b: before?.hitMedian, a: after?.hitMedian, fmt: fmtX },
    { key: 'passRate', label: '通过率（触发占比·中性）', b: before?.passRate, a: after?.passRate, fmt: fmtPct, neutral: true },
    { key: 'rLog', label: 'score-收益 r(log)·佐证', b: before?.rLog, a: after?.rLog, fmt: fmtR, faint: true },
  ];
  const color = (row) => {
    if (row.neutral) return 'var(--muted, #8e8e93)';
    const { b, a, lowerBetter } = row;
    if (b == null || a == null) return 'inherit';
    const d = a - b;
    if (Math.abs(d) < 1e-9) return 'var(--muted, #8e8e93)';
    const good = lowerBetter ? d < 0 : d > 0;
    return good ? '#30d158' : '#ff453a';
  };
  const arrow = (b, a) => {
    if (b == null || a == null || Math.abs(a - b) < 1e-9) return '';
    return a > b ? ' ↑' : ' ↓';
  };
  // 结论主看单调性 spearman ρ 有没有变强（高倍更集中到高分）；高倍率命中率（>2x）作为共同判据一起看。
  // 原则：验证不了"更单调"就别改——尤其是删除，没让 ρ 变强就建议留着。ρ 算不出（样本<5/打分池空）
  // 时退回只看 >2x 高倍率命中率。
  const netHint = (() => {
    if (err || !before?.ok || !after?.ok) return null;
    const EPS = 1e-4; // ρ 的有效变化门槛，避免把 0.0001 的浮动也算成"变强/变弱"
    const dRho = (before.spearmanRho != null && after.spearmanRho != null)
      ? after.spearmanRho - before.spearmanRho : null;
    const d2 = (after.hit2 ?? 0) - (before.hit2 ?? 0);
    if (dRho != null) {
      if (dRho > EPS && d2 >= -1e-9) return { type: 'success', text: `单调性变强了（ρ ${before.spearmanRho.toFixed(3)}→${after.spearmanRho.toFixed(3)}，高倍更集中到高分），高倍率命中率没变差——方向对，可以应用。` };
      if (dRho > EPS) return { type: 'warning', text: `单调性变强了（ρ↑）但通过组高倍率有降——逐项看清楚再决定，拿不准就留着。` };
      if (dRho < -EPS) return { type: 'error', text: hasRemoves
        ? `单调性反而变弱了（ρ ${before.spearmanRho.toFixed(3)}→${after.spearmanRho.toFixed(3)}）——删了让图更不单调，按"验证不了更单调就留着"的原则，建议保留（取消）。`
        : `单调性反而变弱了（ρ ${before.spearmanRho.toFixed(3)}→${after.spearmanRho.toFixed(3)}）——这次调权把图搞得更不单调，建议取消。` };
      // ρ 基本没动
      return { type: hasRemoves ? 'warning' : 'info', text: hasRemoves
        ? '删掉这些因子对单调性（分数↔倍率）没有任何影响——既然验证不出删了更单调，按原则建议留着（取消）。'
        : '单调性没变化——调权影响很小，应用与否都行。' };
    }
    // ρ 算不出（样本太少/打分池空），退回看 >2x 高倍率命中率
    if (d2 > 1e-9) return { type: 'success', text: '样本不够算单调性 ρ，退回看高倍率命中率：>2x 提升了，可以应用。' };
    if (d2 < -1e-9) return { type: 'error', text: '样本不够算单调性 ρ，退回看高倍率命中率：>2x 变差了，建议取消。' };
    return { type: hasRemoves ? 'warning' : 'info', text: '样本不够算单调性 ρ，且高倍率命中率也没变——按原则建议留着（取消）。' };
  })();
  const gated = oosWorse && !forceApply;   // 样本外没过且没勾强制 → 禁用确认
  return (
    <Modal open width={680} onCancel={onCancel} onOk={onConfirm}
      okText="确认应用" cancelText="取消" title={title || '试算调权建议'}
      okButtonProps={{ disabled: !!err || gated }}>
      {err
        ? <Alert type="error" showIcon message="试算失败" description={`改完的代码编译不过：${err}`} />
        : (
        <>
          <Typography.Paragraph style={{ fontSize: 13, marginBottom: 8 }}>
            将 <b>调整 {adjustedCount}</b> 个因子权重、<b>删除 {removedLines.length}</b> 个因子
            {removedLines.length > 0 && <span style={{ color: 'var(--muted,#8e8e93)' }}>（{removedLines.map(r => r.name).join('、')}）</span>}。
            核心目标是让 <b>分数↔倍率更单调</b>（高倍集中高分、低倍落低分）——主看第一行 spearman ρ 有没有变强，
            确认更单调（或至少不变弱）再应用；删掉的因子之后可以在"已删因子"里加回来。
          </Typography.Paragraph>
          <Table size="small" pagination={false} rowKey="key" dataSource={metricRows}
            columns={[
              { title: '指标', dataIndex: 'label', width: 240,
                render: (v, r) => <span style={{ opacity: (r.faint || r.neutral) ? .6 : 1, fontWeight: r.strong ? 700 : 400 }}>{v}</span> },
              { title: '当前', width: 100, align: 'right', render: (_, r) => r.fmt(r.b) },
              { title: '应用后', width: 120, align: 'right',
                render: (_, r) => <b style={{ color: color(r) }}>{r.fmt(r.a)}{arrow(r.b, r.a)}</b> },
            ]} />
          {netHint && <Alert style={{ marginTop: 12 }} type={netHint.type} showIcon message={netHint.text} />}
          {oosWorse && (
            <Alert style={{ marginTop: 8 }} type="error" showIcon
              message={`样本外落地闸门没通过：测试段 ρ ${oos.before.spearmanRho.toFixed(3)} → ${oos.after.spearmanRho.toFixed(3)}（变差）`}
              description={
                <>
                  <div style={{ fontSize: 12 }}>全量看着变好、但在没参与调参的测试段上单调性反而变差——大概率是过拟合到了训练段的噪声，默认不让落地。</div>
                  <Checkbox style={{ marginTop: 6 }} checked={forceApply} onChange={e => setForceApply(e.target.checked)}>
                    我知道样本外没过，仍要强制应用
                  </Checkbox>
                </>
              } />
          )}
          {oos && oos.tooSmall && (
            <Alert style={{ marginTop: 8 }} type="warning" showIcon
              message={`样本外验证不了：按时间切分后测试段只有 ${oos.n} 条（<30），ρ 不可信，这次不做样本外拦截`} />
          )}
          {oosOk && !oosWorse && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#30d158' }}>
              ✓ 样本外闸门通过：测试段 ρ {oos.before.spearmanRho.toFixed(3)} → {oos.after.spearmanRho.toFixed(3)}（没变差）
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
