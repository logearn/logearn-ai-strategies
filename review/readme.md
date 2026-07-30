# 北极星单调性方案（score ↔ returnMax）

> 供下次直接读取，不用重新翻代码注释/memory 拼历史。核心代码在 `src/lib/factorLab.js`，
> 测试在 `tests/bucket-rho-optimize.test.js`，UI 入口在 `src/ui/factorLab/*.jsx`、
> `src/ui/strategyReplay/ScoreReturnPanel.jsx`。
> 整条"扫描 → 挑因子 → 配权 → 推荐 → 回测 → 生成上线代码"的全注释流程图与逐函数输入输出，
> 见 [找因子流程与函数说明.md](找因子流程与函数说明.md)（本文档只讲目标函数口径这一层的取舍）。

## 1. 总览：统一到分层秩相关后，又大回退到全程 ρ（2026-07-28 当天两次转向）

**当前状态（大回退之后，最新）**：候选边际贡献评估、因子推荐贪心搜索、配权，三步全部换回默认口径 **全程 ρ**（`scorePoolRho`/`optimizeWeightsForRho`，全样本点对点 spearman(score, returnMax)，不分档、不用命中率、不绑cutoff）。FactorLab「因子权重」卡片按钮是 🎯按 ρ 最优配权。**原因**：分层秩相关（BucketRho）在真实数据上试了一圈——先是饱和度惩罚、后来锯齿惩罚（还踩过一次归一化坑，见2.1节），配权效果始终不理想，用户直接决定放弃这条线，回到最早的全程ρ。

**历史沿革**（当天经历了"统一到BucketRho"→"大回退回全程ρ"两次方向调整）：

| 口径 | 打分函数 | 配权函数 | 曾经的适用场景 | 现状 |
|---|---|---|---|---|
| 全程 ρ | `scorePoolRho` | `optimizeWeightsForRho` | 默认，没特殊说明都走这个 | **当前唯一在用的口径**（大回退后重新启用） |
| 分层增益 TierGain | `scorePoolTierGain` | `optimizeWeightsForTierGain` | "筛垃圾/防踩雷"类策略（cutoff二分台阶） | **UI未使用该选项**，函数仍在代码里（未删，无调用方） |
| 分层秩相关 BucketRho | `scorePoolBucketRho` | `optimizeWeightsForBucketRho` | 曾短暂统一为"挑因子+配权"唯一口径 | **已从UI上摘掉，函数仍在代码里未删**（`recommendWorker.js`/`recommendWorkerNode.js` 的 `scoreMode:'bucketRho'` 分支还在、仍有测试覆盖，只是当前UI调用方都不传这个参数了）。锯齿惩罚等改动仍留在 `bucketRankRho` 里，没有撤销代码，只是没人调用。 |

**取舍记录（供以后参考，不代表结论）**：分层增益(TierGain)是专门为"筛垃圾"目标设计的——绑定cutoff、要求"过线/未过线两层命中率有台阶差"。BucketRho 不绑cutoff、只要求粗粒度分档递增。这两个口径跟全程ρ都是不同的目标函数，各自的适用场景判断（见第3节历史讨论）仍可参考，但当前实现已经不再按场景切换——全部统一用全程ρ。

## 2. 共享核心：`computeRankBuckets`（分位数分桶）

分层增益和分层秩相关都依赖同一套分桶逻辑（`bucketRankRho` 内部调用），设计要点：

- **同分不跨档**：切档边界推到"分数真正变化"处，饱和区不会被硬切出假单调。
- **档大小固定 15，K = floor(n/15)，K<5 直接返回 NaN**（宁可算不出来，不给不可信的数字）。
- **档内统计量用命中率**（returnMax > winThreshold 的比例），不用中位数——中位数对右偏的倍数分布不敏感（一大坨1~3x盘钉死中位数，尾部涨多猛都感受不到）。
- **饱和度惩罚**：额外算 `maxBucketFrac`（最大单桶样本占比），最终值 = 秩相关 × (1 − maxBucketFrac)。防止"桶间排序对、桶内一锅粥"（比如某因子梯形下界形同虚设，几乎所有样本不管输赢都挤在满分那一桶）被判成强信号。
- **锯齿惩罚**（2026-07-28 四订正，见下）：额外乘 (1 − zigzagPenalty)，防止"桶间大体排对、局部反复倒挂"被判成强信号。
- `bucketZigzag`：数出档序列里"命中率比前一档还低"的位置（inversions），标出具体跌在哪两档、跌了多少、对应哪段分数区间。原来只在 `recommendFactorPath` 贪心路径的导出诊断里用，2026-07-28 四订正后也接进了 `bucketRankRho` 的目标函数本身。

**这条线的演化史**（K 固定3~5 → 按命中数自适应算K → 档大小固定15+K下限提到5 → 加饱和度惩罚 → 加锯齿惩罚）——每一步都是被真实数据/真实回测图的具体撞车逼出来的，不是预先设计好的，细节见文末"迭代记录"。

### 2.1 锯齿惩罚（2026-07-28 四订正）

**触发**：用户在 FactorLab 回测图上肉眼看到"档命中率"紫线锯齿很重（好几处局部大幅跌落），但当时的配权结果看着还行——诊断出 spearman 只看整条序列"大体排没排对"，对局部倒挂完全"失明"：一条整体爬升但中间反复跳水的曲线，照样能换出一个不算差的秩相关。`bucketZigzag` 这个诊断函数当时已经存在，但只接在 `recommendFactorPath` 贪心路径每一步的诊断导出里，从没接进任何目标函数——配权时优化器对锯齿完全没有感知，只是没被人盯着图发现。

**第一版公式（已废弃）**：`zigzagPenalty = min(1, Σ(倒挂档跌幅) / (该因子组合下档命中率的总跨度))`，最终值 = 秩相关 × (1 − maxBucketFrac) × (1 − zigzagPenalty)。上线后立刻在真实数据（n=679，177个候选字段）上炸了：候选表"边际分层秩相关贡献"几乎全部塌成 0.000，因子推荐贪心只挑得出1个字段。

**五订正（同一天修复）——根因与改法**：分子 `Σ倒挂档跌幅` 是随倒挂次数**累加**的量，真实数据 bucketSize 固定至少15，n=679 时 K≈45 档，一个真实但不完美的信号（真实候选大多 AUC 只有 0.52~0.58）局部倒挂十几次很常见，累加起来轻松超过分母那个**跟档数无关的固定值**（总跨度），比值动不动封顶到1——分子会随输入规模（档数）发散，却拿去除一个不会发散的分母，这个归一化方式本身就是错的，跟档数越多惩罚越离谱没有关系。手工验证：强信号(AUC~0.7)构造数据用第一版公式完全正常(deltaTest≈0.52)，说明问题不是"档数多"，而是"信号弱、局部倒挂占涨跌总量比例高"——换成弱信号(AUC~0.55，贴近真实候选表典型候选)构造数据才复现出同样塌陷(deltaTest≈0.031)。**改用"总变差"归一**：`totalVariation = Σ|相邻档差值|`（涨跌都算，不只算跌的），`zigzagPenalty = Σ倒挂档跌幅 / totalVariation`——`Σ倒挂档跌幅` 天然是 `totalVariation` 的子集（只数其中"跌"的部分），比值永远落在 [0,1]，不需要 `min(1,...)` 兜底，也不会随档数增多而发散，衡量的是"整条涨跌里有多少比例在往回跌"，跟档数无关。

**验证**：`tests/bucket-rho-optimize.test.js` 四条回归测试——① 构造两组档命中数排列（rank 顺序、range、maxBucketFrac 全部相同，只有中间那一档的跌幅不同），验证跌幅更大的那组分数更低（这条在新旧两版公式下结论都成立，只验证"锯齿该被扣分"这个方向）；② 验证零倒挂（纯递增）序列不会被误伤，分数应高于有倒挂的序列；③ 弱信号(AUC~0.55) + 真实规模(n=700,K≈35档)构造，验证 deltaTest 不该被拍扁到接近0（阈值0.06——第一版公式在这条上算出≈0.03，过不了；新公式≈0.09，能过）。全量 571 个测试通过，无回归。

**影响面**：`bucketRankRho` 是 `scorePoolBucketRho`（配权目标函数）、边际贡献评估（`useFactorScan.js` 的 `runMarginalRho`）共用的核心，这次改动会让已有因子池的"分层秩相关"数值普遍下降（凡是档序列有倒挂的都会被多打一层折扣，弱信号折扣得比强信号更狠），需要用户重新点一次"按分层秩相关配权"/"计算候选分层秩相关贡献"看新数值，不代表策略变差了，只是评估口径更严了。

## 3. 挑因子该跟哪个口径走

**2026-07-28 更新：不再区分策略用途，候选边际贡献评估/因子推荐贪心搜索固定用分层秩相关。** 之前的方案是`useFactorScan.js`的`marginalMode`('rho'|'bucketRho')、`FactorRecommendCard.jsx`的`scoreMode`两个UI切换，"筛垃圾"策略手动留rho、"推荐"策略切bucketRho——用户确认这层区分没必要了，直接删掉了切换（两处UI组件不再暴露这个选项），候选边际贡献和推荐路径搜索统一用分层秩相关。**这条只影响"挑因子"这一步，不影响"配权"**：配权阶段的三种口径（🎯按ρ最优配权/按分层增益配权/按分层秩相关配权）不受影响，依然按策略用途选——所以"筛垃圾"策略配权时仍可以选分层增益，只是它挑因子这一步现在也用分层秩相关算边际贡献了（之前是全局ρ）。

（以下是改动前的历史设计考虑，供理解为什么曾经要分开：分层增益绑cutoff，候选量大时用绑定某个切分点的判据粗筛容易被"某候选恰好在这个点凑出巧合"放大，全局ρ更抗这种噪声；分层秩相关本身不绑cutoff、也是对整条分布算的粗粒度指标，不存在这层顾虑——这也是为什么最终决定统一到分层秩相关是合理的，它本来就没有"cutoff放大噪声"这个短板。）

## 4. 候选粗筛/初始权重：从"单调AUC"换成"区间感知统计量"（2026-07-28，已实现）

这是"三个核心问题"讨论（判据是否过严 / 字段质量 / 权重阈值）追出来的第一个可落地结论，跟上面几节的"总分↔returnMax单调性"是同一个大主题下的另一层——这里改的是**候选字段**这一层的判据，不是总分这一层。

**发现的真实逻辑矛盾**：`scanFieldsAuc`（`auc.js`）算AUC时在原始特征值上定死一个方向（`direction:'high'|'low'`），但下游打分是**区间/梯形**（`findHotInterval`/`deriveTrapezoid`，值落在挖出的最优区间才加分，不假设方向）。一个"驼峰型"字段（比如中段[40,60]命中率高、两头对称地低）在方向性AUC上会显得接近0.5、"没有区分度"（两头互相抵消），但它的区间打分其实可能很强——而`recommendFactorPath`的候选粗筛（`candLimit=50`）和`autoWeights`的初始权重，改之前恰恰都是按**单调AUC**排序/加权的，会把这类驼峰型好字段挡在外面或压成极小权重，跟下游实际用的打分逻辑自相矛盾。

**修复**（只改候选粗筛排序和初始权重这两个决策点，AUC本身的计算和UI展示——`AucPanel.jsx`、`FactorLab.jsx`手动AUC列/过滤器——都不动，AUC仍是给人看的有效诊断参考）：
1. `scanIntervalCore`（factorLab.js）挖区间时本来就算了一个区间感知、Wilson下界+coverage加权的判别力统计量 `score = (wilsonLo/base)×√coverage`，但之前显式丢弃了（`const { score: _s, ...interval } = best`）——现在保留下来，不用发明新指标。
2. `scanFactorCandidates` 给每个候选的区间新增 `interval.pAdj`/`interval.significantAdj`（BH多重比较校正），跟AUC那边`pAdj`/`significantAdj`的纪律对齐——这是为了不丢失AUC那边已有的多重比较保护。**p值来源已修过一版，见下面4.1**。
3. `recommendFactorPath` 的候选粗筛排序键：`|auc-0.5|` → `interval.score`。
4. `autoWeights` 的权重公式：`∝|AUC-0.5|` → `∝interval.score`。
5. `FactorSopCard.jsx` 文案同步更新（"AUC/显著性只是候选发生器"改成"候选粗筛/初始权重走区间打分，AUC只是诊断参考"）。

**验证**：`tests/factorlab.test.js` 新增构造数据回归测试——一个对称"驼峰"字段（方向性AUC不显著）+ 一个真正弥散的"弱单调"字段（AUC显著但信号弥散、区间打分弱）对照，验证新公式/新排序键下驼峰字段的权重和排名都正确地高于弱单调字段（旧公式会反过来）；`autoWeights`原有的两个测试也同步改成用`interval.score`构造。

### 4.1 补丁：区间显著性检验换成置换检验，并真正接入决策链路（2026-07-28）

上面第2条第一版用`twoProportionTestP`（两比例检验）算区间显著性，review时发现两个问题：①**方法论漏洞**——`twoProportionTestP`检验的是`scanIntervalCore`已经从O(边界数²)个候选窗口里搜出来的最优窗口，没有为"搜了这么多窗口才挑出这个赢家"做校正（look-elsewhere/winner's curse），系统性低估巧合概率；②**算了但没用**——`pAdj`/`significantAdj`当时没有任何地方读取，UI不显示、`recommendFactorPath`/`autoWeights`都没拿它做门槛，等于白算。

**修复**：
- `scanIntervalCore`内部改用**置换检验**——labels固定种子(`mulberry32`)洗牌`permB`（默认200）次，每次都重新跑一遍完整窗口搜索，得到"纯靠搜索本身能凑多高分数"的零假设分布，观测分数在这个分布里的排位就是`pPermutation`。实测验证：纯噪声字段即使侥幸搜到lift=1.0~1.2的窗口，`pPermutation`也在0.13~0.96之间，正确判不显著；真实种入的强信号判显著不受影响。性能：300字段×500行规模下，置换检验部分只占约8%（~560ms／6.6s总耗时，大头是本来就有的AUC bootstrap），可接受。
- `scanFactorCandidates`的p值来源从`twoProportionTestP`改成直接读`interval.pPermutation`，`twoProportionTestP`的import已移除。
- **真正接入决策，但很快撤销了硬门槛**：`recommendFactorPath`候选池过滤一度加过`interval.significantAdj !== false`，同时`FactorLab.jsx`候选表新增"区间判定"列。但**在真实数据上验证时发现这个硬门槛把候选池筛空了**——真实数据里单字段AUC普遍贴着0.5（截图实测0.548~0.575），用同等强度构造信号测试，置换检验只有约20%的随机种子能测出显著（p<0.05），80%测不出——这是因为这套系统的设计本来就是"很多个体各自不显著的弱信号，靠加权组合出有效打分"，不是靠单字段自证清白，拿单字段显著性去当候选池的硬门槛，跟系统设计前提矛盾，导致"因子推荐"在真实数据上直接变成"没有可推荐的候选"。**已撤销这个硬门槛**：`recommendFactorPath`不再检查`significantAdj`（回到只要求`c.interval`存在），区间显著性现在只在UI候选表当**展示/参考**（跟AUC的判定列待遇一样），不影响候选粗筛/因子推荐——`recommendFactorPath`自己的train/test held-out验证已经是足够的把关，不需要再叠一道单字段显著性门槛。
- 验证：新增3个回归测试（真实信号判显著、纯噪声不判显著、`recommendFactorPath`不再因`significantAdj:false`排除候选——只要held-out边际贡献够好仍可推荐）。全量568个测试通过（565基线+3新增），无回归。

## 5. 已发现并修复的真实 bug

1. **worker 参数错位**（`recommendWorker.js` / `recommendWorkerNode.js`）：`computeHeldOutDeltaRho(rows, currentFactors||[], c, c.camp, opts)` 少传了一个参数，`opts` 整个落进 `winThreshold` 位置，导致内部命中率比较恒为 false，候选预筛**一直100%报错**，被一个从未真正执行断言的假通过测试掩盖。已修复+接上 scoreMode→scoreFn 字符串桥接。
2. **测试框架本身的坑（已修复，2026-07-28）**：`run-tests.js` 的同步 `test(name, fn)` 遇到 `async () => {...}` 时只同步调用一次就计入 passed，不等 Promise 结算——断言失败变成脚本打完总数之后才触发的 unhandled rejection，完全不计入统计。上面那个 worker bug 就是靠这个假通过藏了很久。**修复**：①在同步 `test()` 里加了一道永久防护——`fn()` 返回值是 thenable 就直接判失败并报"应该用 testAsync"，不再需要逐文件人工排查，以后谁不小心把 async 用例注册到 `test()` 上都会被立刻抓出来；②通篇排查后确认全项目 40 个测试模块里只有 `factorlab.test.js` 真正踩了这个坑（6 处用例），`binning.test.js`/`factor-recommend-worker.test.js` 虽然也有 async 用例但调用点本来就正确传了 `testAsync`。`factorlab.test.js` 的 `run()` 改成跟 `summary.test.js`/`parity.test.js` 同款的 `run(test, testAsync)` 双参数写法，6 处 async 用例改用 `await testAsync(...)`，`run-tests.js` 调用点改成 `runFactorLab(test, testAsync)`。修复后跑全量测试：561 个测试全部真正通过（含那 6 个，之前是假通过），无回归。

## 6. 现状 / 待办

- 早期讨论过的"分段中位数(segmentGain)"设计（方案D）已被现在的"分层秩相关(bucketRho)"取代——用户订正了"cutoff 不该当配权输入"这个方向问题后，直接改造成了不绑cutoff、用命中率+饱和度惩罚的版本，**`scorePoolSegmentGain` 不再计划实现**。
- `run-tests.js` 的 async 假通过问题已修复并加了永久防护（见第5节第2条）。
- 候选粗筛/初始权重从单调AUC换成区间感知统计量已完成，区间显著性检验也已经从有漏洞的两比例检验换成置换检验、并真正接入`recommendFactorPath`的过滤（见第4、4.1节）。
- **2026-07-28 大回退**：候选边际贡献评估/因子推荐贪心搜索/配权，三步曾短暂统一固定用分层秩相关（见第1节历史沿革），但真实数据上配权效果不理想，已全部换回全程ρ（默认口径）。分层秩相关相关代码（`scorePoolBucketRho`/`optimizeWeightsForBucketRho`/`bucketRankRho`及其饱和度/锯齿惩罚）**未删除**，只是当前 UI 调用方都不再传参数触发它，处于"代码在、没人调"状态，跟 `scorePoolRho`（大回退前）同款处理方式。"筛垃圾"类策略配权是否该换个口径仍未验证，不是这次大回退的范围。
- **✅ 2026-07-29 已修复：边际ρ 两套口径合一（原"已知但尚未修复的方法论缺口"）**。详见第 9 节。
- **"三个核心问题"讨论出的另外两块，还没做**：②因子推荐结果的字段质量问题——现有质量闸门（held-out test段Δ、`overfit`标记）目前只做单次时间切分，样本小时方差大；候选池变大后`minGain=0.003`等固定阈值也没有随候选数/样本量做多重比较调整。③每个字段权重和推荐分数阈值（`recommendCutoff`）的问题——已在真实数据（128条样本）上观察到`recommendCutoff`选出的cutoff落在触发数已经是0的区域（0/128、0.0%），根因还没排查，这是"权重阈值"这条线下一步要看的具体问题。
- **新增「因子推荐2」+ 去掉 candLimit=50 截断 + 加上过拟合校验（三步迭代，同一天）**：
  1. `recommendFactorPath`（因子推荐1，held-out贪心）原来按 `interval.score` 排序只取前50个候选进贪心搜索，会漏掉排名靠后但组合起来有用的字段——用户先要了一个不切train/test、不截断候选的探索工具（新函数 `recommendFactorPoolFull`，贪心选完字段紧接着在全样本上配一次权重，UI是「因子推荐2」卡片）。
  2. 用户进一步要求把「因子推荐1」的 candLimit=50 也去掉（默认值改成 `Infinity`，参数还在但没人再传50了）。此后两者都遍历全部候选，唯一区别是切不切 train/test。
  3. 用户要求给因子推荐2"加上过拟合"，第一版直接拿"全样本配好的权重"切开 train/test 两边打分——上线后用户实测：因子推荐2 自己说没过拟合(train=0.308/test=0.346)，但紧接着对同一份因子池点「按ρ最优配权」(只用train重新配权，对test完全盲)反而测出 test ρ 从 0.346 跌到 0.288，过拟合现出原形。根因：第一版的"全样本权重"配权时已经把 test 数据也吃进去了，事后怎么切都显得稳，等于拿抄过答案的卷子对答案。**修复**：过拟合校验换成配一份"影子权重"——只用 train 拟合（对 test 完全盲，跟 `optimizeWeightsForRho` 同一套纪律），拿影子权重去 test 上打分，才是真正的 held-out。返回给用户"采用"的 `factors` 仍然是全样本配出来的（物尽其用），影子权重只用于诊断数字（`rhoTrain`/`rhoTest`/`overfit`），不影响采用结果。
  测试见 `tests/factor-recommend.test.js`：candLimit截断（两个函数各一条）、真实信号不该被误判过拟合、概念漂移（信号只在训练区间成立）应该被判过拟合。全量 577 个测试通过。
  4. **性能回归+修复**：第2步去掉 candLimit=50 之后，`recommendFactorPath` 的贪心搜索本身变重了（不再截断，跟着遍历全部候选）；而 `FactorRecommendCard.jsx`（因子推荐1）原来有个"combo模式下 factors 变化就自动重算"的效果（防抖600ms，监听整个 `factors` 数组）——因子权重表里删一个因子、改一个权重数字都会触发，600ms 后在主线程跑一遍现在已经不便宜的贪心搜索，冻住整个页面。用户反馈"点删除很卡"，根因就是这个。**修复**：去掉自动重算，因子池变了只提示"结果可能过期"（新增 `staleFactorsAt` 状态 + 一条 Alert），用户自己决定要不要点「算推荐」重新算——mode/heroOnly 这两个直接在推荐卡片上的显式操作仍然保留自动重算（不是"隐式触发"，是用户正在这个卡片里操作）。
- **新增字段范围「全部」档（原字段+组装字段一起做因子发现）（2026-07-28）**：「因子发现」卡片原本字段范围只有二元切换「原字段/组装字段」（`FactorLab.jsx` 的 `fieldScope` state，`'original'|'assembled'`），组装字段单独一档、扫出来的规律仅供探索审核。用户要求把组装字段也开放进因子发现、并新增一个「全部」档同时扫两类。**改法**（全在 `src/ui/FactorLab.jsx`）：① `fieldScope` 增加第三值 `'all'`；`scopedFields`（喂给扫描的字段列表）在 `'all'` 时直接返回全部 `fields`，不按 `classifyFieldOrigin().original` 过滤。扫描管线 `useFactorScan.runScan` 本来就直接消费 `scopedFields`，所以「全部」会把合并后的候选喂给勇者/邪恶两阵营和「因子推荐1/2」卡片，无需改扫描侧。② Segmented 加 `{ label:'全部', value:'all' }`；新增模块级 `FIELD_SCOPE_LABEL = {original:'原字段', assembled:'组装字段', all:'全部字段'}`，扫描按钮/导出 meta/过期提示统一走它（不再是二元三目）。③ 组装字段"进不了生成代码"的警告条件从 `=== 'assembled'` 放宽到 `!== 'original'`，「全部」档也显示（带针对性文案）。**保留的边界**：组装字段"实盘 ctx 里没有对应值、进不了生成代码"的约束**没解除**——`classifyFieldOrigin`/`resolveCtxAccessor` 的拒绝逻辑没动，「全部」档里勾中的组装字段能参与因子发现，但上线仍需人工在实盘侧复刻计算。这跟原「组装字段」单档行为一致，没引入新的绕过。纯 UI 增量，`npm run dev` 加载无新报错。
- **因子发现扫描搬进 worker 池并行（解决「扫全部字段」冻死页面）（2026-07-28）**：「全部」档字段数一下涨到 318（×两阵营=636 次扫描），点扫描非常卡——根因是 `scanFactorCandidates` 全在主线程跑（每字段 bootstrap AUC + 区间置换检验 permB=200），几秒长任务冻死页面。**改法**：① 把 `scanFactorCandidates` 拆成三层可复用件（`src/lib/factorLab.js`）——`computeFieldRaw`（逐字段纯计算：AUC + 仅对可用字段挖区间/算缺失率，无 BH、无跨字段依赖，可安全并行）＋ `assembleCampScan`（全量汇齐后统一做 AUC/区间的 BH 校正+排序，BH 依赖字段总数只能在主线程做一次）＋ `scanFactorCandidates`（串行版=两者串起来，行为逐字段不变）；AUC 的 BH 抽成 `finalizeAucScan`/`isUsableAuc`（`src/lib/auc.js`）。② 新增 `src/ui/factorLab/scanWorker.js`（逐字段跑 `computeFieldRaw`，`rows` 只 `init` 一次并缓存，避免每批重复结构化克隆大数组）＋ `workerPool.js` 的 `scanCandidatesWithWorkers`（两阵营字段切批、共用一池 worker 吃满多核，回主线程按阵营 `assembleCampScan`）。③ `useFactorScan.runScan` 优先走 worker 池、`typeof Worker==='undefined'`（SSR/测试）或构造失败兜底回主线程串行；新增 `scanProgress` 状态，扫描按钮显示"扫描中 45%…"。**等价性**：worker 路径（`computeFieldRaw`+`assembleCampScan`）与串行 `scanFactorCandidates` 必须逐字段完全一致——`tests/factorlab.test.js` 新增两条 `deepStrictEqual` 回归（含目标变量 `returnMax` 两条路径同样剔除），加上既有 scan 测试守着，全量 579 通过。**实测**：150 字段×两阵营、bootstrapB=200、8 核，串行版直接冻页面 >30s（js 探针超时），worker 路径 3.2s 跑完且主线程不冻（`await` 期间主线程持续处理消息回调）；BH 校正/显著性判定与串行完全一致。**没做的进一步优化**：hero/eval 因各自 exclusions 可能不同，AUC 仍按阵营各算一遍（同字段 AUC 算两次），没做跨阵营去重——并行已够快，留着不动以保证 BH 集合大小与串行严格一致。
- **另外三个重活也搬进 worker（「计算候选边际ρ贡献」+「算推荐」+「算推荐2」）（2026-07-28）**：这三处此前都在主线程冻页面——① `runMarginalRho` 逐候选串行跑 `factorMarginalRho`（每候选 build + 全程 spearman）；②「算推荐」的候选预筛（`evaluateCandidatesWithWorkers`）本来就并行，但后面的 `recommendFactorPath` 贪心（现遍历全部候选、maxSteps 轮）在主线程；③「算推荐2」`recommendFactorPoolFull` 整条同步（注释原话"会卡一下"）。**改法**：把 `recommendWorker.js` 从"只跑 held-out 逐候选评估"扩成三类活的统一 worker——`type:'eval'` 逐候选，`opts.job:'marginal'` 走 `factorMarginalRho`、否则走 `computeHeldOutDeltaRho`；新增 `type:'recommendPath'`/`'recommendFull'` 各自单 worker 跑完整条纯函数。`workerPool.js` 复用现成的 `evaluateCandidatesWithWorkers`（marginal 只多传 `job:'marginal'`，`buildRows` 只在残差模式≠rows 时才传、避免重复克隆）＋ 新增 `runRecommendInWorker(kind,payload,{signal})`（单 worker、postMessage 一次、支持 AbortController 取消）。三个调用点（`useFactorScan.runMarginalRho`、`FactorRecommendCard`、`FactorRecommendCard2`）都优先走 worker、`typeof Worker==='undefined'`/失败兜底回主线程直算，结果一致。marginal 的 map 仍按 field key（跟原串行一样，同字段 hero/evil 冲突时 evil 覆盖 hero，靠保持 cands 顺序复现）。**等价性**：浏览器实测三条 worker 路径（marginal/recommendPath/recommendFull）与直算逐字段/逐路径一致（delta、path、rhoTest 全对齐）；lib 函数本身没动、node 全量 579 测试仍通过。
- **「因子推荐2」过拟合检测加强：held-out K折验证曲线 + 推荐因子数 k* + 采用时自动截断（2026-07-28）**：用户实测「因子推荐2」在真实数据上贪出 20+ 个因子、尾部一堆 +0.002~0.005 的边际，但原「过拟合校验」（单次时间切分的影子权重、判据 `test<train×0.4`）判它"站得住脚"。**根因**：① 影子权重只校验了"配权"，而选字段是在**全样本**上贪的（偷看了 test），对"因子数太多"这层几乎失明；② 单次切分方差大（n_test≈200 时 ρ 标准误≈0.07，train-test gap 0.019 本就在噪声里）；③ `×0.4` 阈值又松又跟 n 无关。**改法**（新函数 `heldOutFactorCurve`，`src/lib/factorLab.js`）：固定全样本贪心选出的因子顺序 `pathSpecs`，用 **K 折（默认5，固定种子随机分折）** 逐前缀 held-out 评估——**每折在 train 上重新推导区间/梯形边界 + autoWeights（边界不碰 test）、去 test 折打全程 ρ**，K 折平均得到"test ρ 随因子数 k"的曲线；噪声因子在 held-out 上平均贡献≈0、曲线走平。**1-SE 规则**挑最省 k*（峰值 kBest → 取"均值≥峰值−1个标准误"的最小 k）。`recommendFactorPoolFull` 调它、按 k* 把路径截断出一份 `factorsTrimmed`（前 k* 个全样本精配权重），返回 `{heldoutCurve, recommendedCount, factorsTrimmed}`。**UI**（`FactorRecommendCard2.jsx`）：原过拟合 Alert 下新增一条曲线诊断（列出每个 k 的 test ρ、k* 高亮、尾巴变灰），采用按钮默认「✅ 采用截断到 k*」→ `onAdopt(factorsTrimmed)`，另留「仍采用整条 N 个」。**刻意保留的口径边界**：因子的**选择顺序**仍来自全样本贪心（没在每折重做贪心，避免 K×贪心 的开销）——这条曲线校验的是"加到第几个开始不泛化"，不是完全嵌套 CV；曲线用 autoWeights（快、找 elbow 够用），采用的截断池才用坐标上升精配权重。**用户当时的取舍**：`更严格的判定阈值`（把 `test<train×0.4` 换成"gap 相对 √n 噪声"）**先不做**，等这条曲线跑一段再说——所以原 `overfit` 标记/文案没动，曲线是叠加的新诊断。**验证**：`tests/factor-recommend.test.js` 新增两条——① `heldOutFactorCurve` 喂"真信号+一串噪声"的固定路径，k* 应远小于路径长度（≤2<5）；② `recommendFactorPoolFull` 返回曲线/推荐数/截断池且截断池长度≤k*。全量 581 通过；浏览器实测 worker(`recommendFull`) 回包带全 `heldoutCurve/recommendedCount/factorsTrimmed`。**待观察**：合成数据里全样本贪心很保守（纯噪声/纯冗余字段拿不到 +0.001 边际，pathLen 常=1、无尾巴可截）；真正的"20 个因子尾巴"来自真实数据里大量弱信号字段，得在真实数据上验证 k* 是否显著小于贪出来的因子数。
- **「算推荐」「算推荐2」会挑进缺失率 95%+ 的字段（2026-07-28）**：用户在真实数据（871条样本）上跑「按ρ最优配权」，选出的11个因子里混进了 `breakout_volume_10x_recent_kline_change_pct`（缺失率95.1%，权重21.5）、`whale_recent_tx_count`（缺失率80.5%，权重6.2）等——这类字段只在极少数样本上有值，靠那一小撮样本"凑巧"held-out ρ有正贡献就被贪心选中并给了不小的权重。**根因**：候选表本来就有「缺失率≤」过滤器（`candFilter.maxMissRate`），但它只接进了 `filteredHeroCandidates`/`filteredEvilCandidates`（候选表展示用），`FactorLab.jsx` 喂给「因子推荐」「因子推荐2」两张卡片的 `candidates` 用的是没经过这道过滤的 `scan.visibleHeroCandidates`/`visibleEvilCandidates`——不管你把候选表里的缺失率滑块调多低，两个推荐工具依然会在全部候选（含缺失率95%+的）里贪心搜索；且贪心算法本身也没有专门针对"有效样本太少"的惩罚（`scanIntervalCore` 只要求非缺失 n≥20、正类≥5个就能出区间，871条里只有43条非缺失也够格）。**修复范围（用户明确选定，只做这一项）**：让「缺失率≤」这一道过滤真正接入推荐，其余几道（AUC偏离/lift/边际ρ）**不牵连**——那几道是候选表专用的"显著性类"展示过滤，之前已经踩过"硬显著性门槛把候选池筛空"的坑（见4.1节），推荐算法应尽量遍历全部候选，缺失率是个例外（数据可靠性问题，不是显著性判据）。**改法**（`src/ui/FactorLab.jsx`）：新增 `recommendCandidates`——只对 `scan.visibleHeroCandidates`/`visibleEvilCandidates` 套 `(c.missRate ?? 0) * 100 <= candFilter.maxMissRate` 这一条，不复用 `applyCandFilter`（那个函数把AUC/lift/边际ρ/搜索都揉在一起，直接套用会把默认值 `minLift:1.05`/`minMarginal:0.005` 也当成硬门槛喂给推荐，超出这次修复范围）。`FactorRecommendCard`/`FactorRecommendCard2` 的 `candidates` prop 从两阵营 `visible*Candidates` 直接拼接改成传这份 `recommendCandidates`。候选表过滤区的说明文案同步更新（"缺失率≤"控件的 tooltip 注明"这道过滤会真正限制因子推荐的候选池"，跟其它几道展示专用过滤区分开）。**验证**：纯 UI 数据流改动（换了个数组引用），lib 层没动，全量581个测试原样通过；浏览器里确认页面正常加载、无新报错，但因为需要真实数据文件走原生文件选择对话框，这次没能在浏览器里跑通"缺失率滑块调低→算推荐2→确认高缺失率字段不再出现"这个端到端场景，建议用户下次跑「算推荐2」时留意确认。

- **「算推荐」真实数据上把主线程冻到 FPS=1（2026-07-28）**：用户点「算推荐」（`FactorRecommendCard.jsx`），页面内置的 PerfMonitor 显示 FPS 掉到 1、10 秒内 12 次主线程长任务（最长 3344ms）——跟"另外三个重活也搬进 worker"那次改动的初衷（全程不冻主线程）矛盾。**根因**：`workerPool.js` 的 `evaluateCandidatesWithWorkers`（「算推荐」候选预筛用的多 worker 并行池）在 `next()` 派发每一批候选时，`worker.postMessage({ type:'eval', taskId, rows, currentFactors, candidates:batch, opts })` 把完整 `rows` 跟着**每一批**一起发——真实数据 871 行、每行带 logearn/gmgn/holders/chip_analysis/kline_and_indicators 全套嵌套结构，单行可能几十 KB；候选数远多于 `batchSize`（默认8）时批次数远多于 worker 数（默认并发4），同一份 `rows` 会被结构化克隆几十遍。**结构化克隆发生在发送方（主线程）**，不是接收方 worker 里，所以哪怕计算本身在 worker 里跑，光是反复克隆 `rows` 就能把主线程冻住——这跟 `scanWorker.js`/`scanCandidatesWithWorkers`（因子发现扫描并行化那次）当初踩过、并已经修好的坑一模一样（见"因子发现扫描搬进 worker 池并行"那条），但同一天稍晚写的 `evaluateCandidatesWithWorkers`/`recommendWorker.js` 没有照抄这个修法，是这次"三个重活搬进worker"里唯一漏掉"rows只clone一次"这个纪律的地方（`runRecommendInWorker` 单 worker 单次 postMessage 天然不受影响，只有多worker+多批次这条路径会中招）。**修复**：`recommendWorker.js` 加 `cachedRows` + `type:'init'` 消息（跟 `scanWorker.js` 同款），`eval`/`recommendPath`/`recommendFull` 都改成 `msg.rows || cachedRows`；`workerPool.js` 的 `evaluateCandidatesWithWorkers` 建 worker 时立刻 `postMessage({type:'init', rows})` 一次，后续每批 `eval` 消息不再带 `rows`。**验证**：纯 worker 消息协议改动，lib 函数没动，全量581测试照常通过（Node 测试走的是 `workerPoolNode.js`/`recommendWorkerNode.js` 这两个独立的 Node 版镜像，这次没碰，两者是否有同款"逐批带rows"问题还没排查，因为 Node 里不会表现成 UI 冻住，不是这次真实观察到的症状）；浏览器里确认页面加载无新报错，但没能用真实数据文件走通"点算推荐→PerfMonitor不再钉在FPS=1"这个端到端验证（受限于这次环境驱动不了原生文件选择对话框），建议用户下次点「算推荐」时留意 PerfMonitor 是否恢复正常。

- **「因子推荐2」补上「组合路径(基于当前池)/探索全路径(从零)」模式切换（2026-07-28）**：用户指出「因子推荐」（卡片1）已经有这两个模式，「因子推荐2」应该体验一致——之前「因子推荐2」`recommendFactorPoolFull` 固定从零遍历，没有"基于当前池只找新增"这个选项。**改法**：① `src/lib/factorLab.js` 的 `recommendFactorPoolFull` 新增 `opts.startFactors`——非空时贪心从起点池出发，起点池字段直接进 `pathSpecs`/`chosen`（不会被重新挑选，也不出现在 UI 的 `path` 展示里），`baseRho` 用起点池自身的全样本ρ做基线，后续贪心只找【新增】的字段；若起点池已经不错、没有能提升ρ的新增，返回一条区分于"完全没候选"的提示（`"当前池子已经不错——..."`），不是硬报错崩溃。② held-out K折曲线/k*这次特意**只针对新增路径**——`heldOutFactorCurve` 新增 `opts.baseSpecs`（固定基座，每折都跟当前前缀一起建，但不计入 `kMax`/不参与 k 的扫描），避免"组合路径"模式下把用户已经采信过的起点池也拖进这次的截断诊断里连带judge。`recommendFactorPoolFull` 相应把喂给 `heldOutFactorCurve` 的入参从 `pathSpecs`（起点池+新增混在一起）改成只传 `path`（新增部分），`baseSpecs` 单独传；截断池 `factorsTrimmed` 的构建也从"切 `pathSpecs` 前 k 个"改成"起点池原样保留 + 新增路径只截前 k* 个"。③ `FactorRecommendCard2.jsx` 新增 `factors` prop + `mode` state + 跟卡片1同款的 Segmented 切换；`run()` 时 `mode==='combo'` 传 `startFactors:factors`、`explore` 传空数组；采用按钮文案按 mode 区分——combo 模式说"应用到当前池（新增 N 个，共 M 个，重新配权）"，explore 维持原来的"替换当前因子池"措辞，避免用户误以为 combo 模式点"采用"会把已有因子清空（实际上"整体替换"用的 `result.factors` 本来就是起点池+新增合并重配权后的完整集合，效果上等价于"合并进池子"，`FactorLab.jsx` 的 `adoptRecommendedFull`/`setFactors` 没有改动）。**验证**：`tests/factor-recommend.test.js` 新增两条——① 构造两个都只跟 returnMax 部分相关（非完美单调，留出"组合能提升"的空间）的独立信号，从只含其中一个的起点池出发，验证已在池里的字段不重复出现在新增路径里、另一个真信号被正确挑出、`recommendedCount` 只针对新增路径计数；② 起点池已经不错、没有新增候选时验证返回明确提示而不是崩溃。全量583个测试通过。浏览器里确认页面正常加载无新报错，但同样受限于需要真实数据走原生文件选择对话框，没能端到端跑通"切到组合路径模式→点算推荐2→确认新增/起点池按预期合并"这个场景。

- **「时间外推验证」大幅加强：walk-forward多段滚动 + 全cutoff曲线对比 + 统计显著性 + 逐因子归因（2026-07-28）**：用户看着"触发数@-26"这个截图问"这个验证怎么加强"——原实现只切一次70/30，只在【当前设的那一个cutoff】上对比train/test的命中率/lift，过拟合判据是固定阈值"验证段lift<训练段lift×60%"。诊断出跟"因子推荐2过拟合检测"当初一样的几个坑：①单次切分是"这一刀"的运气，切在行情转折点附近结果就不可信；②`oos.train`/`oos.test`内部本来就算了完整的cutoff扫描曲线（`sweepScoreCutoffs`），但展示层只挑了一个点，没画出来；③"×60%"固定阈值跟样本量无关，触发数少时噪声就能触发假警报，触发数大时真衰减却可能漏报；④总分lift塌了看不出是哪个因子拖累的。跟用户过一遍设计后，四个方向（A全用户都要）一起做：
  1. **Walk-forward多段滚动**（`src/lib/factorLab.js`）：把原来的单段核心逻辑抽成私有 `backtestOneSplit(train,test,...)`，`runOOSBacktest`（单次70/30）不变——外部可见的返回形状、`tests/factorlab.test.js`既有断言、`backtestReportExport.js`的消费方式全部原样保留，纯内部复用。新增 `runWalkForwardBacktest`：训练段固定用最早`trainRatio`(默认0.7)做"起步窗口"（第0段跟`runOOSBacktest`单次切分完全等价），剩下的验证池切成`splits`段(默认5)连续时间窗、**扩张窗口**滚动（每段训练集=从最早到该段验证窗口开始为止的全部历史），逐段独立推导区间/权重、套到该段验证；验证池不够切出达标段数(每段<15条)时自动降段，不报错。
  2. **全cutoff曲线对比**：数据本来就有（`backtestOneSplit`内部`backtestFactors`就带了完整`sweep`），新增`FactorLab.jsx`里的`oosFoldSweepFigure`（纯展示层，零额外计算）——train/test两条lift-vs-cutoff曲线叠在一张图上，红色竖线标当前cutoff，一眼看出是全程衰减还是只在某个cutoff区间分叉。
  3. **统计显著性替代固定阈值**：新增`assessSplitDecay(trainPoint,testPoint)`，用已有的`twoProportionTestP`(`utils.js`，两比例z检验)判断验证段命中率是否显著低于训练段——返回`{p,decayed,significant,insufficientN}`，`insufficientN`(触发数<5)时不给判定（宁可不下结论，不假装知道）。为了让这个检验能拿到精确的命中数而不是靠`hitRate×triggered`四舍五入反推，给`sweepScoreCutoffs`的每个point顺手加了`hit`字段（累加时已经算出来了，之前只是没往外传）。
  4. **逐因子归因**：`backtestOneSplit`里每个因子的训练段AUC(`c.auc`)扫描时已经算好，新增对验证段独立跑一遍`aucForField`(`auc.js`，已有函数)，两者差值(`aucDrop`)大的排最前——粗略诊断"总分lift塌了，先看这几个字段"，不是严格统计检验（两段的AUC方向都是各自独立选出来的，不排除翻转，只作定位线索用）。
  **UI**（`FactorLab.jsx`）：按钮文案改成"walk-forward：前70%起步→后30%切多段滚动检验"；新增`oosProgress`(验证第几段)、`oosFoldIdx`(详情面板选中哪段，默认最后一段——训练集最大、离现在最近，最贴近"现在上线"的情形)；渲染从"一张单点表格"换成"多段总览表(点行切换详情，衰减判定列用两比例检验替代固定阈值) + 选中段的曲线对比图 + 逐因子归因表"；导出报告(`exportBacktestReport`)固定用详情面板当前选中的那一段，跟页面显示的数字对得上。
  **验证**：`tests/factorlab.test.js`新增7条——`runWalkForwardBacktest`：splits=1时应与`runOOSBacktest`单次切分完全等价（验证重构没有偷偷改变原有行为）、splits=3时训练集应逐段扩张、请求段数过多时应自动降段而不报错；`assessSplitDecay`：大样本明显衰减应判显著、差异在噪声范围内不该判显著、验证段命中率更高时不该判衰减、触发数<5时应标`insufficientN`不给判定。全量590个测试通过。浏览器里确认页面正常加载无新报错，但同样受限于需要真实数据走原生文件选择对话框，没能端到端跑通"点时间外推验证→看多段总览表/曲线对比/归因表"这个真实场景，建议用户实测时留意每一块是否符合预期。

- **「时间外推验证」补上专属导出报告（2026-07-28）**：用户拿真实数据跑出"逐因子归因"表后问"什么结论"——发现大多数字段的test AUC反而远高于train AUC（比如某字段0.537→0.805），这本身是个警讯而不是好消息：大概率是该段验证窗口太小、正类数太少，AUC估计噪声大，不是"这个字段验证段真的更强"。诊断这个问题需要同时看这段的test n、验证段高倍盘数（正类数）、总览表的衰减判定——但这些数字分散在页面好几处，来回问用户很低效。**改法**：① `src/lib/backtestReportExport.js` 新增 `buildWalkForwardReport(oos, foldRows, opts)`——沿用这个文件一直以来"零 import、纯格式化，业务计算全部由调用方算好传进来"的约定（不像临时方案那样在这个模块里重新实现一遍两比例检验，那样会有"页面判显著、导出说不显著"两处不一致的风险）：`foldRows` 直接复用 `FactorLab.jsx` 渲染总览表用的那份计算结果（同一个 `assessSplitDecay` 调用、同一份数据）。报告含：切分配置、各段总览表（含"验证段高倍盘数(基准率)"——这就是判断AUC可信度的关键数字）、逐段逐因子归因表（含 `testN`/`testPos`）、给AI的诊断清单（专门提醒"AUC大幅波动但正类数很小=噪声，别被唬住"）。② `factorLab.js` 的 `backtestOneSplit` 给 `factorDecay` 每条补上 `testN`/`testPos`（`aucForField` 本来就算出来了，之前算完就扔了）——UI归因表和这份导出报告都能用来判断"这个AUC差值到底可信不可信"。③ `FactorLab.jsx` 把渲染时内联算的 `foldRows` 提到 `useMemo`（`oosFoldRows`），保证页面表格和导出报告读的是同一份计算，不会出现两处判定不一致；新增 `exportWalkForwardReport()`，在"时间外推验证"按钮旁边加一个独立的"📋 导出本节报告（喂 AI）"按钮（跟顶部大而全的"导出报告"是两个不同的导出，这个只聚焦这一节）。**验证**：`tests/backtest-report-export.test.js` 新增4条——含全部关键小节、关键数值(testN/testPos/跳过字段说明)落进报告、无oos/oos.error时给占位不崩溃、某段训练失败时给出失败原因而不是崩溃。全量594个测试通过。浏览器里确认页面加载无新报错；同样受限于没法在这个环境走原生文件选择框加载真实数据，没能端到端点一次导出按钮确认剪贴板内容，建议用户实测时点一次这个新按钮看看报告内容是否符合预期。

- **新增「基线库 vs 训练集(按天) 对比」——监控现成策略在不同数据来源/时间上是否漂移（2026-07-28）**：用户要求在"时间外推验证"旁边加一个新对比——基线库当一个整体，训练集按天，对比看漂移。**这跟"时间外推验证"是完全不同的两套机制**：时间外推验证是【当前样本内】自动按时间切分、每段都重新训练区间/权重再验证（过拟合检验）；这个新功能用的是仓库里本来就有的、独立于当前分析范围的「基准库/训练集」按天归类机制（`lib/dataSlices.js`，用户在「数据与过滤」tab 手动把浏览器里累积的历史数据按天分别归到"基准库"或"训练集"，注释写的是"训练集调参、基准库做样本外验证"）——这套归类表（`sliceCats`）和全量原始数据（`allRows`）之前只存在 `DataLoader.jsx` 内部状态里，没有传给 `FactorLab.jsx`，做这个对比先要把这两样东西一路传下去。**跟用户确认的三个设计点**：①打分用当前「因子权重」面板现成的 `factors`，不重新推导任何区间/权重——这是"监控现成策略表现"，跟每段重新训练的 walk-forward 不是一回事；②漂移判定复用刚做的两比例显著性检验（`assessSplitDecay`），不用固定阈值；③展示成表格（基准库一行+训练集每天一行），不做趋势图。**改法**：① `DataLoader.jsx` 新增 `onArchiveChange` 回调，用一个 `useEffect` 统一在 `allRows`/`sliceCats` 变化时往上抛（比在每个 `setAllRows`/`setSliceCats` 调用点手动通知一遍不容易漏——这两个 state 有七八处更新点）。② `App.jsx` 新增 `archive` state 接住，透传给 `FactorLab`（新增 `archiveAllRows`/`archiveSliceCats` props）。③ `factorLab.js` 新增 `compareGroupsAgainstBaseline(baselineRows, groups, factors, winThreshold, opts)`——通用命名（`groups:[{label,rows}]`，不叫"day"），不需要知道"天/基线库"这些概念从哪来，保持跟"数据按天怎么归类"解耦；对基准库整体和每个组各打一次 `backtestFactors`，在当前cutoff取点，用 `assessSplitDecay` 逐组跟基准库比。④ `FactorLab.jsx` 用 `dataSlices.js` 的 `selectRowsBySlice`（`{mode:'baseline'}`/`{mode:'train'}`）现分基准库/训练集，训练集再用 `dayOf` 分组成 `groups`，喂给 `compareGroupsAgainstBaseline`；新增卡片"基线库 vs 训练集(按天) 对比"，表格首行=基准库(整体)，其余每行=训练集一天，"判定"列显示显著性检验结果；配套 `backtestReportExport.js` 新增 `buildBaselineVsTrainReport`（跟 `buildWalkForwardReport` 一样的风格，导出markdown喂AI）。**验证**：`tests/factorlab.test.js` 新增4条——组命中率明显更差应判显著偏离、命中率接近不该判偏离（用取模精确构造命中率，不靠RNG凑近似值，避免种子运气导致断言不稳）、多组互不干扰、因子池/基准库/训练组为空时给出明确error不崩溃；`tests/backtest-report-export.test.js` 新增2条——基准库整体+每天一行都应出现、显著偏离/无样本天都能正确标出、无结果时给占位不崩溃。全量600个测试通过。浏览器里确认三个文件（`App.jsx`/`DataLoader.jsx`/`factorLab.js`）都能正确编译加载（用 `import()` 直接探测确认新导出都在），也验证了这次改动中途一度出现的"`buildBaselineVsTrainReport` 未导出"报错只是编辑时序中的瞬时状态（先加了import后写函数），最终状态正常；同样受限于没法在这个环境走原生文件选择框、也没有手动归类过基准库/训练集数据，没能端到端跑通这个新卡片的真实渲染效果，建议用户实测时先去「数据与过滤」tab 把部分天归到基准库/训练集，再来这张卡片看效果。

- **因子发现"已移除"清单：按排除时间排序 + 一键恢复（2026-07-28）**：用户在候选表里排除了128个邪恶阵营字段后，发现"已移除"清单里的顺序看不出排除先后，想找回最近排除的字段很麻烦，逐个点×恢复也太慢。**改法**（`src/lib/factorExclusions.js`）：新增 `sortExclusionsByRecency(list)`——按 `excludedAt`（`excludeFactor` 早就在记录，之前只是没用来排序）新→旧排序，不 mutate 原数组；新增 `restoreAllExcluded(list, camp)`——一键清空指定阵营的全部排除记录，不影响另一阵营。`useFactorScan.js` 的 `excludedHero`/`excludedEvil` 接入这个排序（最近排除的排最前，方便找到刚手滑排除的字段）；新增 `handleRestoreAllExcluded(camp)` 调用 `restoreAllExcluded`。`FactorLab.jsx` 在"已移除 N 个（查看/恢复）"链接旁边加了"一键恢复全部"按钮（`Popconfirm` 二次确认，毕竟可能一次性恢复上百个），勇者/邪恶两个阵营各自独立。**验证**：`tests/factor-exclusions.test.js` 新增5条——一键恢复只清空指定阵营不影响另一个、该阵营本来没有排除项时不报错、排序新→旧正确、排序不mutate原数组、真实场景（先排a再排b，b应排更前）。全量605个测试通过。浏览器里用 `import()` 直接探测确认三个改动文件（`FactorLab.jsx`/`useFactorScan.js`/`factorExclusions.js`）都能正确编译加载、新导出都在；同样受限于没法在这个环境加载真实数据触发排除操作，没能端到端点一次"一键恢复全部"确认UI效果。

- **修复「基线库 vs 训练集(按天)对比」跨策略混淆的真实bug（2026-07-28）**：这张卡片上线当天就被用户用真实数据抓到——07-26这天"训练集"显示154条，但「数据与过滤」tab 的时间切片表里同一天明明只有114条；07-22~25明明整段都是"基准库"，却也在这张对比表里单独冒出一行。**根因**：基准库/训练集归类是按【策略+天】两个维度记的（`sliceKeyOf(strategyKey, day)`，同一天在不同策略下可以分别归类——用户浏览器里同时存了"强势盘策略"(679条，07-22~25基准库/07-26~28训练集)和"1.5段策略"(192条，07-22~26全是训练集)两个策略），但我实现的 `baselineVsTrain` 只按日历日分组、没有再按策略区分——把两个策略同一天的样本混进了同一行：07-26 = 强势盘策略114条(train) + 1.5段策略40条(train) = 154，跟用户截图分毫不差；07-22~25 单独冒出来的行，其实是"1.5段策略"在这几天的训练集数据（强势盘策略这几天是基准库，被正确排除了，但1.5段策略这几天是训练集，被错误地当成了"新的一行"）。**这是我这次实现遗留的真实bug，不是数据问题**——诊断过程：用户先反馈"这俩数据差距有点大"，我先怀疑是"策略数据没scope"，用户追问后贴出完整的时间切片表截图，两边数字逐日核对后完全对上，确认了根因。**修复**（`src/ui/FactorLab.jsx`）：新增 `strategyOptions`（`groupRowsByStrategyAndDay(archiveAllRows)` 现算，按样本数降序）+ `baselineVsTrainStrategy` state，一个 `useEffect` 默认选中样本数最大的策略（策略列表变化、或当前选中的策略不在列表里时兜底重选）；`baselineVsTrain` 的 `useMemo` 先用 `strategyOf(r) === baselineVsTrainStrategy` 把 `archiveAllRows` 收窄到单个策略，再走原来的 `selectRowsBySlice`/按天分组逻辑——彻底避免跨策略的天被合并。UI：卡片右上角新增策略下拉选择器（只在检测到多个策略时才显示，避免单策略场景多一层无意义的UI），说明文字同步补充"归类按策略+天两个维度记，不同策略的样本不会混在一起"；导出报告 `buildBaselineVsTrainReport` 新增 `strategyName` 参数，报告里明确写出"对比范围已收窄到单个策略：XXX"，避免被误读成全站汇总数据。**验证**：`tests/backtest-report-export.test.js` 新增1条——传入 `strategyName` 时报告应写明收窄到该策略。全量606个测试通过（`compareGroupsAgainstBaseline` 本身逻辑没变，这次改动全在调用方怎么喂数据进去，不需要新增 lib 层测试）。浏览器里确认 `FactorLab.jsx` 正确编译加载；受限于没法在这个环境操作真实的多策略归档数据，没能端到端验证"切换策略下拉后数字变化"这个交互，建议用户实测时确认切到"1.5段策略"后 07-22~26 这几天能正确显示（而不再是混进"强势盘策略"视图里的幽灵行），且"强势盘策略"视图下 07-26 应该正确显示114（不再是154）。

- **字段质量审核：市值机械耦合 + 边际ρ 置换零分布（2026-07-29）**：新增 `src/lib/fieldAudit.js`（纯函数、只依赖 rows+字段名，不依赖因子池），`computeFieldRaw` 扫描时逐字段顺带算，结果经 `assembleCampScan` 挂到候选对象上。
  1. **市值机械耦合**：`returnMax = max_mcap / initial_mcap`，分母就是进场市值，任何跟进场市值高度相关的字段，"预测力"可能只是"小盘天生更容易翻倍"这条恒等式的投影。数据集级给 `auditMcapCoupling(rows)` → ρ(进场市值, returnMax) 体检卡；字段级给「与市值ρ」列 = `fieldMcapRho` = spearman(字段, initialMcap)。字段名带 mcap/fdv 的一眼能认，这一列真正的价值是抓住名字上看不出来的——真实验证里合成的 `supply_like` 字段名毫无市值痕迹，这列直接给出 1.00。
  2. **边际ρ 置换零分布** `permutationNullMarginalRho`（+ `summarizeNullDistribution`/`permutationPValue`）：边际ρ 不是教科书统计量，没有 p 值可查，SOP 里"≥0.005"那条线是拍出来的。做法是把 `returnMax` 在样本间完全打乱（字段值不动），把"挖区间→建梯形→算Δρ"**整条流水线原样重跑**——必须整条重跑而不是复用真标签挖出的区间，否则"从几百个候选窗口挑最优"这部分搜索自由度被藏起来、零分布会偏低。区间挖掘内部的置换检验关掉（`permB:0`），候选由调用方等间隔抽样（按 `interval.score` 排序后取 24 个，确定性、强弱都覆盖）。并行走 `runPermutationNullWithWorkers`（按 permutations 切片，每片一个 worker + 不同 seed，主线程合并 deltas 后统一 `summarizeNullDistribution`）；`recommendWorker.js` 新增 `permNull` 消息类型。UI 给出 q50/q90/q95/q99/max 和「按 q95 设阈值」一键回填，候选表边际ρ 列下方显示经验 p。
  **三个被否决/移除的设计（别再加回来）**：
  · **观察期偏差**——最初实现了 `观察时长 = exportTimestamp - buyTimestamp` 以及字段与它的 ρ，写完才发现 `summary.js` 里同思路的警告**早就因为同一个原因被删过一次**：`row.exportTimestamp` 取的是 `call.timestamp`，而它实际是【信号时刻】（真实样本里与 `swap_begin_time` 只差 107 秒），且匹配逻辑强制 `|call.timestamp − snapshot.timestamp| ≤ 3600s`，于是"观察窗口"恒 ≤1 小时，任何基于它的检测都对 100% 样本无条件触发。已整体替换成上面第 1 条（市值耦合，有真实数据支撑）。
  · **时点标记（事后字段 / 市值同源 Tag）**——`getFieldTiming` 实现过并验证可用（`post_buy_max_drawdown_pct` 打红标、默认隐藏、从「因子推荐」候选池剔除），但**用户判断看字段名就能人肉判断**，2026-07-29 移除。
  · **缺失非随机检查**——`missingBias` 实现过并验证可用（两比例检验，真实验证里合成的 `sparse` 字段缺失率 64.8% 被正确标 ⚠），同样按用户判断"看缺失率人肉检查就行"移除，不值得占候选表列宽和扫描开销。
  这两项移除后 `fieldAudit.js` 头部留了注释说明它们是被主动砍掉的、不是漏做的；候选表的「字段」列和「缺失率」列都还原成了纯展示，「隐藏事后字段」「隐藏市值同源」两个开关一并删除。
  **验证**：`tests/field-audit.test.js` 共 10 条（市值耦合正/负/无数据、字段级 ρ 含无关字段与不存在字段、扫描结果透传、置换零分布的"真信号必须超出 q95"关键性质、种子可复现、不污染调用方 rows、碎片合并、p 值 +1 修正），全量 **635 个测试通过**，构建通过，全项目无残留引用。另外在 Browser 里灌了一份合成数据集跑通完整链路端到端确认：置换零分布 20轮×10候选=200 个噪声 Δρ（q95=0.0868）、种入的真信号 `good` 经验 p=0.00 而噪声字段 p=0.22、点「按 q95 设阈值」后候选从 5 个被筛到只剩 `good` 1 个。（注：该 q95 是**空因子池**下的量级，池子非空时零分布会小得多，别拿这个数当通用阈值。）

## 7. 迭代记录（时间线，仅供追溯，不影响现状判断）

全部发生在 2026-07-28 这一天，按顺序：

1. 用户订正"围绕cutoff判定"这个方向本身不对 → 拆出不绑cutoff的 `scorePoolBucketRho`/`optimizeWeightsForBucketRho`，UI 加第三个配权按钮。
2. 挑因子边际贡献口径跟着配权口径联动（`marginalMode`/`scoreMode`）。
3. 联动过程中挖出 worker 参数错位的真实 bug（见第4节）。
4. `frequent_volume` 真实数据撞出 Δ=+1.000 → K固定3~5太粗 → 改按命中数自适应算K。
5. `followed_tx_analysis.sell_amount` 又撞出一次同样问题（自适应K在局部命中率异常低时会被顶回K=3）→ 档大小固定15+K下限提到5。
6. `max_up_duration` 单因子路径 held-out +0.964 但散点图显示顶格桶饱和 → 加饱和度惩罚。
7. 顺带发现 `run-tests.js` 的 async 假通过坑（见第4节第2条，尚未全面修复）。
8. 用户在回测图上肉眼发现"档命中率"紫线锯齿很重 → 诊断出 spearman 对局部倒挂"失明"、`bucketZigzag` 诊断函数写好了但没接进任何目标函数 → 加锯齿惩罚，接入 `bucketRankRho`（见第2.1节）。
9. 锯齿惩罚第一版（除以固定"总跨度"）上线，用户在真实数据上实测候选边际贡献几乎全塌成0 → 根因是分子随档数/倒挂次数累加、分母是跟档数无关的固定值，弱信号候选很容易把比值顶到封顶的1 → 改成除以"总变差"（涨跌都算，比值天然落在[0,1]，不随档数发散）（见第2.1节五订正）。
10. 锯齿惩罚第二版修好之后，用户在真实数据上实测配权效果仍然不理想 → 直接决定放弃分层秩相关这条线，**大回退**回全程ρ（`scorePoolRho`/`optimizeWeightsForRho`）——候选边际贡献评估、因子推荐、配权三处 UI 调用方全部改回不传 bucketRho 相关参数，`bucketRankRho`/`scorePoolBucketRho` 等函数代码保留但不再被调用（见第1节）。顺带修了一个 `FactorLab.jsx` 里的悬空引用 bug：`invalidateDownstream` 调用 `setRhoOpt`/`setTierGainOpt` 但这两个 state 从未声明过（前一轮"统一到分层秩相关"清理时删漏的），调用到就会抛 `ReferenceError`——这次重新声明 `rhoOpt` state 顺带修好，`setTierGainOpt` 因为没有对应功能直接删掉了这行调用。

详细的每一步原始讨论、构造数据、验证结果见 git 提交 `5611647`/`d4e70b7` 附近以及 `tests/bucket-rho-optimize.test.js` 里逐条测试的注释（每条回归测试都写了"为什么加这条"）。

---

## 8. 逻辑审查修复批次（2026-07-29）

对「找因子」整条主流程做了一次逻辑审查，下面这批是**审查出来并且已经修掉**的。共同特点：不报错、跑得通，
但状态或结论是错的——所以每条都在 `tests/factorlab-fixes.test.js` 里配了一条能复现原症状的回归测试
（全量 640 通过），回归了会红，不会悄悄退回旧行为。

### 8.1 会丢数据的状态 bug（三条，都是"用户的因子池凭空少东西"）

1. **从策略导入因子池后，点一次「扫描」整池被清空**（`FactorLab.jsx` `importFromStrategy`）。
   `importFromStrategy` 调了 `scan.resetScan()` 把 `selectedHero/Evil` 清空，却没把导入的字段写回勾选；
   下次 `runScan` → `rebuildFactors` 的规则是"本次扫到的字段、不在勾选里 = 用户取消勾选了 → 丢"，
   导入的因子（都是原字段，必然在扫描范围内）于是被整批判成"已取消"，`setFactors([])`。
   跟 `useFactorScan.js` 顶部注释里记的那次"刷新后重建把整池清空"是同一个事故，入口换成了导入。
   **修**：导入后按阵营把字段写回 `selectedHero`/`selectedEvil`。
2. **`autoWeights` 把没有 `interval` 的因子权重清零**（`factorLab.js`）。
   `raw = f.interval?.score || 0` —— 导入的因子 `interval=null`、手工建的因子同理，只要池里还有一个
   带 interval 的因子（sum>0），这些因子的 share 就是 0。而 `rebuildFactors`/`removeFactor` 每次都会
   整体重配一遍权重，所以"导入池 → 随手扫一次/删一个因子 → 导入的因子全变 0 权重"。
   **修**：分三种情况——全部有 score 时行为**完全不变**（既有测试守着）；一个 score 都没有（导入池/手工池）
   时按现有权重的相对比例归一（全都没权重才退化成均分，保持旧行为）；混合池时无 score 的那批按
   现有权重的组内相对比例参与分配、规模对齐到有 score 那批的平均分（不能直接拿 weight 当 raw：
   权重是 0~100 量纲、`interval.score` 通常 0.5~2，混在一起归一会让导入因子吃掉几乎全部权重）。
3. **组合路径模式会静默吃掉起点池里的因子**（`recommendFactorPath` / `recommendFactorPoolFull`）。
   两个函数都要从**本次** `candidates` 里查起点池的字段来重建，查不到就被 `buildFactors` 静默跳过。
   触发条件很常见：勾了「只看勇者阵营」（`FactorRecommendCard2` 直接 filter 掉 evil 候选）、换过
   字段范围/残差模式、上一轮没挖出区间的字段。后果两层：① 基线目标值按残缺池算，新增字段的 Δ 虚高；
   ② UI 的"采用"是整体替换因子池 → 用户池里那几个因子就此消失。
   **修**：新增 `buildWithBase(baseFactors, ...)`——能从候选重建的照常重建（保住"边界在 train 段推导"
   这条纪律），重建不出来的直接沿用传进来的因子对象本身（它自带边界，只是这次不重新推导），起点池只增不减。
   `recommendFactorPath`/`recommendFactorPoolFull`/`heldOutFactorCurve` 三处统一走它；后者的
   `opts.baseSpecs` 相应换成 `opts.baseFactors`（收因子对象而不是 spec）。

### 8.2 数字算错/串表

4. **候选表「边际ρ贡献」两个阵营互相覆盖**（`useFactorScan.js`）。结果 map 的 key 只有 `field`
   （老注释写着"evil 覆盖 hero，保持口径一致"，其实是把 bug 当约定），`getMarginal(field)` 也只按 field 查——
   勇者候选表里显示的可能是邪恶那份的 Δρ。更麻烦的是候选表的「边际ρ≥」过滤器**默认就是 0.005**，
   会拿这个串了阵营的数去筛候选，该留的筛掉、该筛的留下。而 SOP 里挑因子这一步"固定看边际ρ"。
   **修**：map key 改成 `camp:field`，`getMarginal(field, camp)`，候选表列/排序/过滤器/TSV 导出四处调用点全部带上 camp。
5. **`trapScore` 的上界与区间口径不一致**（`factorLab.js`）。挖区间/算 lift 用的是 `[lo, hi)`（`inWin` 是 `x < hi`），
   但 `trapScore` 判满分用 `v <= hi1`。`shape='interval'` 退化成矩形（`hi1===hi0===hi`）时，落在右端点上的样本
   "统计上不算命中、打分却给满分"。连续字段几乎看不出来，**离散字段是成片的**——布尔字段区间 `[0,1)` 本该只覆盖 0，
   实际把 1 也打成满分。**修**：上界改成先判、且右开（`v >= hi0 → 0`）；下界仍留在核心判定之后（矩形时左端点属于区间，
   不能提前判 0）。梯形形状行为不变（`lo0<lo1<hi1<hi0` 时 `v>=hi0` 本来就该是 0）。
6. **`bucketRankRho` / `scorePoolTierGain` 的惩罚项在负分区间方向反了**（`factorLab.js`）。
   `ρ×(1−饱和度)×(1−锯齿)`：ρ<0 时乘一个 (0,1) 的系数是把负值往 0 推，"越饱和、越锯齿"反而离最大值更近，
   坐标上升会**主动**挑饱和/锯齿的权重组合。`scorePoolTierGain` 的 `above.length × gapScore` 同理——
   gapScore<0 时"把触发数压小"就成了最省力的提分手段（-1000 → -20 也是提升），优化器会去缩触发量而不是改善分层。
   **修**：两个惩罚/放大都只作用于正分，负分原样返回。这两个函数当前处于"代码在、没人调"状态（见第1节大回退），
   但重新启用前必须先有这个修复，否则一启用就踩。

### 8.3 验证口径不一致

7. **「时间外推验证」验证的不是当前因子池**（`FactorLab.jsx` `runOOS`）。原来用 `scan.selectedHero/Evil`
   拼 fieldSpecs，而不是 `factors`。两者会不一致：从策略导入的因子、跨字段范围保留的因子、"因子推荐2"
   直接采用的因子，都在池子里但未必在勾选里——导入策略之后 selected 为空，点验证直接报"推导不出任何有效因子"，
   而用户看着的是满满一池因子。**修**：改用 `factors` 派生 fieldSpecs，空池给明确提示。
   （仍**未**改的：walk-forward 每段内部会重新 `autoWeights`，所以它验证的是"同一批字段用自动权重重训"的版本，
   验证不到「ρ最优配权」搜出来的权重——这是 walk-forward 的固有语义，没动，但要知道。）
8. **K 折验证曲线按行分折 → held-out 泄漏**（`heldOutFactorCurve`）。同一个 token 的多条信号收益高度相关
   （`summary.js` 那条"非独立样本"警告说的就是这件事，而找因子默认并不去重），按行随机分折会把兄弟样本
   分到 train/test 两边——test 折上考的是已经见过的题，held-out ρ 被系统性抬高，1-SE 选出来的 `k*` 跟着偏大，
   噪声因子看起来"还在涨"。而这条曲线正是「因子推荐2」截断 k* 的唯一依据。
   **修**：抽出 `assignFoldsByToken(rows, K, seed)`（导出，可单测），同一 tokenAddress 的所有信号整组进同一折；
   没有 tokenAddress 时退回按行分折。

### 8.4 上线尺度

9. **映射不回原始 ctx 的因子会让线上分数和回测分数不是一个尺度**。上线代码（`onlineExport`）对取不到值的
   字段返回 null → 记 0 分，但**它的权重仍留在分母里**，于是线上总分系统性低于回测总分，而 CUTOFF 是照搬
   回测面板的 → 触发数莫名其妙少一大截，且这类因子权重越大偏得越狠。`generateStrategyCode` 那条路则相反
   （直接把因子剔除、分母变小），同样不是一个尺度。
   **修**：① `generateStrategyCode` 新增 `cutoffUnreliable` 返回字段，并在生成的代码注释里写明"这段代码的
   总分与回测面板不是同一个尺度、CUTOFF 不能直接套"；② `FactorLab.jsx` 新增 `unmappableFactors`（`classifyFieldOrigin`
   + `resolveCtxAccessor` 双重判定），在**因子权重卡片上常驻一条警告**（阈值是在这张卡片上定的，不能只在点
   「发送到策略」那一下才说），「发送到策略」时再提示一次。

### 8.5 样本层面的两个系统性偏差（新增常驻提示，不改默认行为）

这两条不属于任何单个字段，却会同时污染这一页上的每一个统计量，所以放在最顶上的「高倍阈值与样本总览」卡里常驻：

10. **非独立样本**：同一 token 多条信号（重复率 >20% 时提示）。AUC 的 bootstrap CI、区间的置换检验 p、
    Wilson 区间、衰减的两比例检验全都按"n 条独立样本"算，**显著性被系统性高估**，有效样本量远小于 n。
    提示里给出去重入口（「总览」页的"每个 token 只留首条信号"）。**没有**默认去重——那会改变现有全部结论，
    是用户该做的决定，不是我该悄悄替他做的。
11. **观察期未定型（右删失）**：`returnMax = max_mcap / initial_mcap`，而 `max_mcap` 只统计到数据导出为止
    （见 `data.js` `buildRows` 的 `exportTimestamp` 注释）。最近抓的样本还没走完行情，倍数天生偏低。
    检测方式：用样本里最晚的 `buyTimestamp` 近似"数据截止时刻"，比较最近 24h 与更早样本的高倍率，
    明显偏低时提示。**这条直接决定怎么读「时间外推验证」**：验证段永远是最新的那批样本，天然吃这个亏，
    看到"验证段衰减"要先排除这层，别一上来就归因成参数过拟合。

### 8.6 性能

12. **残差模式下 `buildRows` 仍被逐批结构化克隆**（`workerPool.js` / `recommendWorker.js`）。
    第7节记的"算推荐把主线程冻到 FPS=1"那次只把 `rows` 挪进了 `init`，`opts.buildRows`（残差子集，一样大）
    还留在 `workerOpts` 里跟着**每一批** eval 消息重发——同一个坑的另一条支路，只在残差模式下踩，
    所以那次实测没覆盖到。**修**：`buildRows` 跟 `rows` 一样只在 `init` 时发一次并缓存（`cachedBuildRows`）。

### 8.7 审查发现但**尚未**修的（需要决策或改动过大，按优先级记在这）

- **`recommendFactorPath` 用 test 段做贪心选择**：每一步都选"test ρ 涨最多"的候选，再把这个 `testRho`
  当泛化证据展示——选择本身就在 test 上优化，报出来的 `deltaTest` 是乐观的。要真正无偏得上三分
  （train 拟合 / valid 选字段 / test 只看一次）或嵌套 CV，样本量够不够是个问题，需要先定。
  同一族的还有第6节记的"边际ρ没有 train/test 切分"，以及 `heldOutFactorCurve` 的因子**顺序**仍来自全样本贪心。
- **两个阵营的 `interval.score` 不同量纲**：`score=(wilsonLo/base)×√coverage`，勇者 base≈15%（lift 上限 ~6.7）、
  邪恶 base≈85%（lift 上限 ~1.18），`autoWeights` 把两边的 score 直接归一分权，跨阵营的相对权重其实是量纲
  artifact。推荐卡注释里"邪恶候选量远大于勇者、贪心一边倒选邪恶"，根子在这。修法需要先定一个跨阵营可比的
  统计量（比如各自阵营内先标准化）。
- ~~**`recommendCutoff` 选出触发数为 0 的档位**~~ → **已排查并修复，见下面 8.8**。
- **两套 train/test 切分口径并存**：`splitRowsByTime` 把缺失时间的样本排最后、`utils.splitTrainTest` 用
  `?? 0` 排最前，回测面板和配权面板的"train"不是同一批样本。
- **`bootstrapAucCI` 全字段共用同一个种子**：各字段的重采样序列完全相同，BH 校正隐含的独立性假设更弱一些。

## 8.8 「触发数 0/128、0.0%」的根因（第6节挂了很久的未排查项，2026-07-29 结案）

**结论：这口锅不在 `recommendCutoff`。** 它自带 `minN = max(20, 样本量×5%)` 的档位门槛，
**不可能**返回触发数为 0 的档——回归测试 `recommendCutoff: 永远不会推荐触发数为 0（或不足 minN）的档位` 钉住了这一点。

**真正的来源：当前 cutoff 高于因子池打得出的最高分。** 复现构造（`tests/factorlab-fixes.test.js`）：
128 条样本 + 6 个命中区互不重叠的弱因子，任何样本最多只命中 1 个，
总分 `Σ(±w·s)/Σw` 的上限就只有 `100/6 ≈ 16.7`。而 cutoff 的默认值是 **60**、而且是**持久化**的
（`factorPoolStore`）——换一份数据、换一批因子、改一次高倍阈值或缺失口径，分数分布整个变了，cutoff 却原地不动。
于是 `sweepAt` 落在最高档：`triggered=0` → `hitRate=NaN`（UI 显示 "-"）、`capture=0`（**显示 "0.0%"**）、`lift=NaN`。
"0/128、0.0%" 这两个数字就是这么来的，看着像"策略彻底失效"，其实只是刻度错了。

因子越多、各自命中区越不重叠，这个上限越低——**这也是为什么池子越大越容易撞上**：
用户往往在因子少、分数高的时候定下 cutoff，之后一路加因子，分数上限一路降，cutoff 却留在原地。

**修（全在展示/防呆层，统计逻辑一行没动）**：
1. **回测卡片**：当前 cutoff 下触发数为 0 时给红色告警，直接写出"因子池打得出的最高分只有 X"、解释这不是策略失效、
   并指向「🎯 推荐阈值」按钮；触发数 >0 但少于 `minN` 时给橙色告警（这些数字的抽样噪声很大，别据此下结论）。
2. **walk-forward 分段总览表**：触发数为 0 的一侧标红 + tooltip；命中率那格写"无触发"而不是一个看着像"很差"的 `-`；
   表上方汇总提示"有 N 段在当前 cutoff 下无触发——各段独立重训、样本量小、分数分布本来就会漂，而 cutoff 用的是
   全样本上定的那一个，看整体结论时请排除这些段"。（衰减判定列本来就会走 `insufficientN` → "样本不足，不下结论"，没动。）
3. **基线库 vs 训练集(按天) 对比表**：同样处理，0 触发标红 + "无触发"。

**没做**（记着，等下次真实数据上再看要不要）：按每段各自重推一个 cutoff。那会让各段之间不可比
（每段阈值不同，"衰减"就没有共同基准了），跟 walk-forward "同一套参数在不同时间段上表现如何"的初衷相反。
现在的做法是保持同一个 cutoff、但把"这段没样本触发"明确标出来。

## 9. 边际ρ 统一到 held-out 一套口径（2026-07-29）

**动机**：这是第 6 节挂了很久的"已知但尚未修复的方法论缺口"结案。此前"边际ρ"这个名字下有**两个不同的统计量**：

| 入口 | 函数 | 有没有 train/test 切分 |
|---|---|---|
| 候选表「计算候选边际ρ贡献」按钮 | `factorMarginalRho` | ❌ 全样本评估，无切分 |
| 「算推荐」的候选预筛 / 贪心每一步 | `computeHeldOutDeltaRho` | ✅ train 推边界、test 读增量 |

后果有两层，第二层更要命：

1. 两个数都叫"边际ρ"、都显示成一个 Δ，含义却不同，用户没法横向比较；
2. **"挑因子"这一步完全没有过拟合防护**。候选的区间/梯形边界本来就是从这批样本里搜出来的
   （`findHotInterval` 从 O(边界数²) 个窗口里挑最优），再在同一批样本上评估增量，等于让它自己给自己判卷。
   纯噪声候选可以带着虚高的 Δρ 直接进池，而下游 `optimizeWeightsForRho` 的 train/test 对比只看得见
   **"权重组合"层面**的过拟合——它拿到的因子池已经被污染了，看不见"这个字段的贡献本身就是噪声巧合"这一层。

**做法**：删掉 `factorMarginalRho`，三处调用方全部走 `computeHeldOutDeltaRho`，展示的主数字固定是 `deltaTest`。

- `src/lib/factorLab.js`
  - **删除** `factorMarginalRho`（不是"代码在、没人调"，是真删——留着必然再次分叉）。
  - `computeHeldOutDeltaRho` 新增 `opts.buildRows`：残差模式下候选的 `.interval` 挖自残差子集，边界要在
    同一份数据上推——**但同样只取它的 train 段**。少了这一刀，边界就看过验证段了，`deltaTest` 不再是 held-out。
    `tests/factorlab.test.js` 有一条专门的守门用例：构造"训练段该字段全缺失"的 `buildRows`，
    正确实现必须报错（只有偷用了全量含验证段的数据才推得出边界）。
  - `permutationNullMarginalRho` 内部改调 `computeHeldOutDeltaRho`、收集 `deltaTest`。
    **这一步是必须的，不是顺手**：零分布是给候选表那一列当尺子用的，尺子和被量的东西必须是同一个统计量。
    held-out Δρ 比样本内 Δρ 散得多，拿样本内的 q95 去卡 held-out 观测值，这把尺子直接就是错的。
    区间仍在全量置换数据上挖（不切训练段）——观测侧的候选 `.interval` 也来自全样本扫描，
    零分布必须复刻同一条流水线，切了反而比观测值少一层搜索自由度、尺子偏松。
  - 代价：置换零分布贵了约一倍（held-out 要 train/test 各评 baseline 与 with 两次）。可接受，
    它本来就是"按需点一次"的标尺，不在主循环里。
- `src/ui/factorLab/recommendWorker.js`：`opts.job` 参数整个取消，`eval` 消息只有一条路径。
- `src/ui/factorLab/useFactorScan.js`：`runMarginalRho` 走 held-out，worker 与主线程兜底两条路同口径。
- UI（`FactorLab.jsx`）：候选表那一列改名 **「边际ρ(test)」**，主数字 `deltaTest`，
  下方小字并排给 `train Δ` 和置换 p 值；`deltaTrain > 0.005 且 deltaTest ≤ 0` 标 ⚠（贡献只存在于推边界的那批样本里）。
  「边际ρ(test) ≥」过滤器卡的也是 `deltaTest`——**train 涨 test 不涨的候选正是这道过滤要拦掉的那类**。
- 导出 TSV（`factorScanExport.js`）：`边际ρ贡献` 一列拆成 `边际ρ(test)` + `边际ρ(train)` 两列，
  让"只有 train 涨"在表格里/喂给 AI 时也一眼可辨。

**影响面（挑因子的人要知道的）**：同一批候选，这一列的数**会普遍变小、也更容易出现负数**——
不是代码变差了，是原来那个数含着"边界照着这批样本挖出来"的水分，现在扣掉了。
默认阈值 0.005 相对新口径偏松，建议点一次「跑置换零分布」按 q95 回填。

### 9.1 这个 held-out 到底 held 住了什么、没 held 住什么（2026-07-29 审计订正措辞）

上面反复写的"train 推边界"**只对梯形核心成立，对区间窗口不成立**，之前的措辞会让人以为 `deltaTest`
是完全无偏的 held-out，实际不是。把话说准：

| 这一层 | 在哪推的 | 是否 held-out |
|---|---|---|
| 梯形满分核（P25/P75） | `computeHeldOutDeltaRho` 里的 `deriveRows`，**只取 train 段** | ✅ 是 |
| 区间窗口 `interval.lo/hi` | `computeFieldRaw` → `scanIntervalCore`，**全样本扫描**（含 test 段） | ❌ 不是 |

而 winner's curse 的主要来源恰恰是后者——`scanIntervalCore` 是在 O(边界数²)≈441 个候选窗口里挑最优。
也就是说 test 段虽然没参与"满分核画在哪"，但参与了"窗口开在哪"这个更强的搜索。
同一族的还有 `recommendFactorPath` 贪心（`buildOf(specs, train)` 里的 candidates 同样带全样本 interval）。

**实测（2026-07-29，纯噪声 40 组对照，n=400，右偏 returnMax，字段与目标完全独立）**：

| | mean deltaTest | >0 占比 |
|---|---|---|
| A) interval 挖自全样本（现状） | −0.0191 | 53% |
| B) interval 只挖自 train（对照） | −0.0166 | 50% |

**结论：泄漏在结构上确实存在，但在这个尺度上没测出有统计意义的偏差**（53% vs 50%，40 次试验下这个
差距本身就在噪声范围内）。所以本轮**只订正文档措辞，不动实现**——把 `computeFieldRaw` 也搬进 train 段
重挖一次意味着每个候选多扫一遍全窗口搜索（置换检验 200 次 × 441 窗口），性能代价明确，而收益实测不显著。
真要做，做法记在这里：`computeHeldOutDeltaRho` 里对 `deriveRows` 再跑一次 `computeFieldRaw` 拿 train 段
自己的 interval，而不是复用候选身上那个。**在有真实数据能证明这层泄漏可测之前，不值得付这个代价。**

**没做**：`FactorRecommendCard`（因子推荐1）的候选预筛现在跟这个按钮算的是同一个数、各算各的，
存在重复计算。没合并——那属于"两张推荐卡片是否该砍掉一张"的范围，等那个决定做完再一起处理。
`recommendFactorPoolFull`（因子推荐2）内部贪心用的仍是样本内 `scorePoolRho`，那是它刻意的
"先不管拟合、快速探索"定位（过拟合由事后的影子权重 + K 折曲线校验），不在这次统一范围内。

测试：635 个全通过（含 5 条改写/新增的 `computeHeldOutDeltaRho` 用例、1 条 buildRows 泄漏守门用例）。
（本次改动落地时另一个会话同步移除了 `fieldAudit.js` 的时点标记/缺失偏差三个函数及其 8 条用例，
总数因此从 643 降到 635，与本节改动无关。）

## 10. 两张推荐卡片合并成一张（2026-07-29）

**动机**：「因子推荐」和「因子推荐2」并列存在，对同一个问题给两个答案，用户得判断信哪个。
更要紧的是分歧落在方法论最要害处：

| | 旧「因子推荐1」`recommendFactorPath` | 旧「因子推荐2」`recommendFactorPoolFull` |
|---|---|---|
| 选字段 | held-out 贪心（每步 train 推边界、test 评 Δρ） | **全样本内贪心**，靠事后校验兜底 |
| 配权 | 只有 `autoWeights`，要手动再点 🎯 | 选完坐标上升精配权，采用即用 |
| 过拟合校验 | 每步 `overfit` 标记 + `testZigzag` 锯齿诊断 | 事后影子权重（只用 train 拟合） |
| 因子数 | 无 | K 折曲线 + 1-SE 给 k* |

旧推荐2 的选字段方式，正是第 9 节 `computeHeldOutDeltaRho` 那次统一要修的毛病——在同一批样本
上挖边界又评估增量，等于自己给自己判卷；事后校验只能说"整体过不过拟合"，改变不了选的时候
就已经被噪声带偏。所以合并不是二选一，是**取 1 的选择纪律 + 取 2 的收尾能力**。

**合并后**：`recommendFactorPool(rows, candidates, opts)`，四步串起来——
① 选字段调 `recommendFactorPath`（held-out 贪心，唯一的选字段引擎）→ ② 全样本坐标上升精配权
（这份就是"采用即用"的权重）→ ③ 影子权重过拟合校验 → ④ `heldOutFactorCurve` K折曲线定 k*。
UI 上一张卡、一个「算推荐」按钮，两个采用入口：点路径某一步 = 合并进池按区间自动配权；
底部按钮 = 带精配权重整体替换（可选截断到 k*）。

**删掉的**：`recommendFactorPoolFull` 的全样本贪心循环、`buildPathFromPool`/`buildPathFromZero`
（无人调用的薄包装）、`FactorRecommendCard2.jsx`、`replaceWithRecommended`/`onReplace`
（"整体替换"统一由带精配权重的 `onAdoptFactors` 承担，旧路径替换进去的是 `autoWeights` 权重，
严格更差）、worker 的 `recommendPath`/`recommendFull` 两条消息合并成 `recommend` 一条，
以及推荐卡里那道 `evaluateCandidatesWithWorkers` 候选预评估——贪心内部本来就会跳过评估不出来
的候选，而候选表的「计算候选边际ρ贡献」算的就是同一个数，那是纯重复一遍全量计算
（第 9 节结尾记的"没做：存在重复计算"这条一并结案）。
顺手把三处复制粘贴的坐标上升+归一化收敛成 `fitWeights`/`normalizeWeights` 两个内部小函数。

**默认参数**：`maxSteps` 从 6 放宽到 12（后面有 k* 兜底截断长尾，与其贪心阶段保守停手、
漏掉组合起来才有用的字段，不如多走几步让曲线决定砍在哪）；`minGain` **维持 0.003 没动**——
本来打算跟着放宽到 0.001，写测试时被打脸，见下。

**一条实测结论，写下来免得再想当然**：`minGain` 不是过拟合防线。概念漂移用例里（good 只在
前 70% 跟 returnMax 相关，后 30% 完全无关），held-out 贪心**照样会选中**它：从空池出发时首个
因子的 `deltaTest` 就等于它自己的验证段 ρ，实测 **+0.009**——数值约等于 0，但大于任何合理的
地板值，0.001 和 0.003 都拦不住。真正认得出它的是 ① 每步 `overfit` 标记（样本内 Δρ≈0.25 vs
验证段 ≈0.009，差两个数量级）；② 路径标签上显示的数字本身就是 0.009 而不是 0.25；
③ 影子权重校验 rhoTrain≈0.38 vs rhoTest≈0.002。相比旧的全样本内贪心（标签显示 0.25、得等事后
校验才知道有问题），改进在①②，**不在"拒绝"**。`tests/factor-recommend.test.js` 里那条用例
（原名"应该被判过拟合"）已按这个真实行为重写，并把三条判据都断言上，防止以后再被改回幻想中的
"held-out 会自动拒绝坏字段"。

测试：635 个全通过。

## 11. 减复杂度批次（2026-07-29）

起因是"找因子这块业务太复杂，哪些能删、哪些能简"。先做了一遍实测盘点，第一个结论是
**当前代码根本跑不起来**——所以本批次的第 0 项不是简化，是修坏账。

### 11.0 分层秩相关/分层增益删了一半，build 和测试全挂（blocker）

第 1 节记的"BucketRho/TierGain 代码保留、UI 未接"这个状态，在 2026-07-29 已经把函数
从 `factorLab.js` 里真删了，但引用没清干净：

- `recommendWorker.js` / `recommendWorkerNode.js` 仍 `import { scorePoolBucketRho }` →
  ESM 链接失败。`npx vite build` 直接报 `Missing export: scorePoolBucketRho`，**整个构建挂掉**；
  浏览器里该 worker 也起不来。
- `tests/bucket-rho-optimize.test.js` / `tests/tier-gain-optimize.test.js` 仍 import
  `optimizeWeightsForBucketRho` / `optimizeWeightsForTierGain` → `run-tests.js` 在第一个
  import 就抛 SyntaxError，**615 个用例一条都没跑**（"测试全绿"曾经是假的）。

已删两个测试文件与 `run-tests.js` 里对应的 import/调用，去掉两个 worker 里的
`scoreMode:'bucketRho'` 分支（scoreFn 不能跨 worker 边界传、只传字符串标记的那套机制，
随目标函数唯一化一起没了用武之地）。**教训**：删一个 export 之后，判断"删干净了"的标准是
`npm test` + `vite build` 都过，不是 grep 没结果——worker 是独立的构建入口，主包编译通过
不代表它通过。

### 11.1 删除【残差模式】

**它是什么**：扫描/挖区间可以只在"当前因子池没打对的子集（score < cutoff）"上做，
想挖"漏网之鱼跟同子集里的真输家相比，哪些字段不一样"。

**为什么删**：这正是 held-out 边际ρ 的定义。`computeHeldOutDeltaRho` 每评一个候选，算的就是
"并入当前池子之后验证段排序还能再涨多少"，贪心推荐的每一步也在做同一件事——残差模式是把
同一个问题换了个入口再问一遍，而且问得更糙（子集里高倍盘常常不足 5 个，大部分字段直接
"区间：无"，页面得专门挂一条告警解释这不是字段没信号）。

**它的成本**：`useFactorScan` 里 8 处分支、`FactorLab.jsx` 里 14 处；把"扫描结果已过期"做成了
三选一状态机（范围变了/阈值变了/残差开关变了）；页面上常驻一条 4 步 `<ol>` 教用户怎么用它，
外加两条只在残差态出现的告警。删完这些全部消失，`staleScan` 回到两选一。

**保留什么**：看漏网之鱼的能力在「低分高倍复盘」（`MissedRowsCard`）里，没动。
SOP 的第 7 步「残差补漏」删除，原第 8 步「发送到策略 + 上线」顺位成第 7 步。

**一个反直觉的发现，别再想当然**：worker 协议里的 `buildRows` 参数**不是残差模式专属**，
不能跟着一起删。它记的是"候选区间实际挖自哪份行集"，梯形边界必须回到同一份数据上推导；
用户在「数据与过滤」里改了筛选、`rows` 换了一份但还没重扫时，候选还是老那批，这条通道仍要用。
`scanRowsUsed` 同理保留。原先代码注释一律写成"buildRows 只有残差模式才有"，是错的，已改。

### 11.2 常驻教学文案 → 折叠

`FactorLab.jsx` 里有 28 个 `<Alert>`，光「因子发现」一张卡就常驻 8 个。问题不在数量，在于
**"看一次就够"的教学内容和"必须当场处理"的有态告警挤在同一屏**，互相稀释注意力。

- 「因子发现」卡顶部 7 行说明（两阵营各挖什么、原字段/组装字段/全部的区别）→ 移进默认折叠的
  `FactorSopCard`（新增「两阵营与字段范围」一节），页面只留一句定义 + 指回 SOP。
- 「市值耦合体检」：弱耦合（|ρ|<0.2）时原本也是一整块 info Alert，内容却是"没事，不用管"——
  一条常驻的好消息横幅。现在只有 |ρ|≥0.2（小盘效应真的在污染候选表）才升级成橙色告警块，
  弱耦合降成一行灰字，数字仍在、tooltip 仍解释。
- 条件触发的告警（组装字段提醒、`staleScan`、`marginalStale`、置换零分布）**全部留在原地**——
  它们只在真的出事时才出现，本来就不构成常驻噪声。

### 11.3 死锚点与重复入口

- `App.jsx` 的 ScrollNav 还挂着 `fl-generate`（"生成代码"）。那张卡在"代码生成统一到策略侧"
  时就删了，锚点留着，点了不跳。改为指向 `fl-send`「发送到策略」。
- 「发送到策略」曾在「因子权重」卡右上角和 `fl-send` 卡各有一个按钮，调同一个 `sendToStrategy`。
  删掉权重卡那个：CUTOFF 是在下面「回测」卡里定的，从权重卡直接发容易在还没定阈值时就发出去，
  而且 ScrollNav 只指向 `fl-send`。

### 11.4 验证

`npx vite build` 通过（worker 正常产出），`node tests/run-tests.js` 615/615 通过——这是坏账修复
之后**第一次真正跑完**。dev server 启动无新增 console 错误。「找因子」tab 需要先加载数据文件
才能进入（原生文件选择框），页面视觉未逐屏复核。

## 12. 导出按钮 8→2 + 基线库对比复查（2026-07-29）

### 12.1 8 个"喂AI markdown"导出按钮合并成 1 个

原来分散在五处、各自一个按钮：候选表「导出全部候选」+ 勇者/邪恶阵营各一个「复制候选清单」
（3个）、回测卡「导出报告（喂AI）」、时间外推验证卡「导出本节报告」、基线库对比卡
「导出本节报告」、因子推荐卡「导出分档诊断」——原因是每加一个新的分析板块就顺手加一个
配套导出按钮，用户反馈这些东西本来就是要一起粘给 AI 看的，拆成 8 份只是让人多点几下、
自己手工拼接，没有实际价值。

**改法**：回测卡的「导出报告」按钮改名「导出完整报告（喂 AI）」，成为唯一的 markdown 导出
入口（`exportFullReport`，`FactorLab.jsx`）——按当前实际算出了什么就并什么段落（候选列表 /
回测报告 / 时间外推验证 / 基线库对比 / 因子推荐分档诊断），没算出来的段落直接跳过、不占位，
各段之间用 `---` 分隔。其余 7 个按钮连同各自的 `copyAllCandidates`/`copyCandidateList`/
`exportWalkForwardReport`/`exportBaselineVsTrainReport`/`exportPathDiagnosis` 函数一并删除，
`buildBacktestReport`/`buildWalkForwardReport`/`buildBaselineVsTrainReport`/
`buildRecommendPathReport`/`buildCandidateExportTsv` 这几个纯函数不变，只是调用方收拢到一处。

**唯一的接线改动**：因子推荐的分档诊断结果原来只存在 `FactorRecommendCard` 内部 state 里，
父组件够不着。给它加了个 `onResultChange` 回调 prop，结果变化时把 `result` 抛给
`FactorLab`（存进新增的 `recommendResult` state），`exportFullReport` 才能把这段也并进去。

💾「导出原始数据（供内存验证）」不属于"喂AI"，是给 Node 脚本重放用的 JSON，性质不同，
原样保留，跟合并后的 markdown 按钮一起构成最终的 2 个导出入口。

### 12.2 「基线库 vs 训练集(按天)」对比复查：功能完整，未删

一开始按用户初始描述的方案打算把这张卡整个删掉（理由：跟 walk-forward 回答同一个问题，
walk-forward 更稳，且依赖用户手工在「数据与过滤」tab 分类）。用户中途改口：不删，先查它是否
功能完整。复查结论：**完整、可用，端到端链路没有缺口**——`DataLoader.jsx` 里"基准库/训练集"
按天分类 UI（`sliceCats`，全部→/区间→/单天→ 三种批量归类入口）→ `onArchiveChange` 把
`{allRows, sliceCats}` 抛给 `App.jsx` → 转给 `FactorLab.jsx` 的 `archiveAllRows`/
`archiveSliceCats` → `compareGroupsAgainstBaseline`（`factorLab.js`）用当前因子池原样打分、
两比例检验判定偏离 → 卡片渲染 + 并入 12.1 的完整报告。`compareGroupsAgainstBaseline`/
`buildBaselineVsTrainReport` 各自的单测都在，本次未作代码改动，只是它的导出按钮按 12.1
并入了统一入口。

### 12.3 验证

`npx vite build` 通过，`node tests/run-tests.js` 599/599 通过。dev server 启动、控制台无新增
错误；「找因子」tab 因需要先经原生文件选择框加载数据，本次未做真实数据下的逐屏点击复核。

## 13. 候选表 lift 过滤删除 + AUC批量检测/波峰扫描删除（2026-07-29）

### 13.1 候选表删掉「lift ≥」过滤器

起因：用户截图问"这个 lift 有没有用，感觉没用"。查 `scanIntervalCore`（`factorLab.js`）确认
挖区间的搜索本身按 `score=(wilsonLo/base)×√coverage` 选窗口，**不是**按 lift 最大化——
√coverage 这一项主动拿 lift 换捕获率，捕获率越高的窗口 lift 越必然被拉回接近 1（捕获率100%
时区间≈全样本，lift 必然≈1）。也就是说 lift 单独拿出来筛/排序，筛掉的可能恰恰是"覆盖广、
边际ρ也可能不低"的候选，口径跟真正决定因子有没有用的「边际ρ(test)」对不上。删掉候选表的
`lift ≥` 输入框（`candFilter.minLift`），过滤控件从 4 个减到 3 个（搜索/边际ρ(test)≥/缺失率≤）。
lift 列本身还在候选表里（跟捕获率一起看，判断区间"窄而强"还是"宽而弱"），只是不该单独当
候选池门槛。

### 13.2 删除「AUC 批量检测」面板

`ui/AucPanel.jsx` 整个删除，App.jsx 里"找因子"tab 的引用一并去掉。理由：
- FactorLab 候选表本身就给每个候选字段带 AUC 列，这个面板唯一的增量价值是"扫描 FactorLab
  挖不出区间、进不了候选表的字段"，价值有限。
- SOP 明文写"别按 AUC 挑因子"，readme 第4节记录了 AUC 单调假设会漏掉驼峰型字段这个已知盲区——
  这个面板存在的理由本来就跟当前挑因子方法论对着干。
- 纯只读展示，结果不接回任何后续步骤。

`lib/auc.js` 的 `scanFieldsAuc`（只服务这个面板的批量扫描包装）一并删除；`aucForField`/
`finalizeAucScan`/`collectAucSamples`/`isUsableAuc`/`AUC_TARGET_FIELDS` 是候选扫描
（`assembleCampScan`）的核心依赖，保留不动。`tests/auc.test.js` 里测 `scanFieldsAuc` 的
BH校正/排序行为的两条测试，改成直接测 `finalizeAucScan`（不因为面板删了就丢失这层覆盖）；
测"必须排除目标变量"的第三条测试删除——那是候选扫描入口（`scanFactorCandidates` 用
`AUC_TARGET_FIELDS` 过滤）已经在测的行为，不用在这里重复。

### 13.3 删除「字段体检」里的「波峰扫描」，只留 VIF

`ui/FieldHealth.jsx` 原来一张卡两个工具：波峰扫描（`scanFieldsForPeaks`，找非单调"甜蜜区间"，
用连续优势长度+置换检验）+ 共线性诊断（VIF）。波峰扫描跟 FactorLab 自己的 `findHotInterval`
其实是同一个问题的两套不同解法——后者统计量更严谨（wilson下界×√coverage，直接喂进打分因子），
前者是纯只读发现工具，看到"有波峰"之后实际动作还是回 FactorLab 走 findHotInterval 那一套，
结果不接回任何后续步骤。删掉波峰扫描，卡片标题改为「字段体检（共线性诊断 VIF）」，如实反映
现在只剩一个工具。

连带删除 `lib/analytics.js` 里只服务这个功能的一条链：`scanFieldsForPeaks` → `requiredPermN`/
`permutationPeakTest` → `longestAboveRun`（后两个逐级只被上一层调用，没有其它调用方），以及
一个早就没人用的孤儿变量 `lastFieldScanPassed`（声明了但零引用，顺手清掉）。`benjaminiHochbergAdjust`/
`wilsonInterval` 这两个 import 也跟着变成死代码，一并从 `utils.js` 的 import 列表里去掉
（`percentile`/`rankAuc`/`WIN_THRESHOLD`/`getFeature`/`isFiniteNumber` 仍被 `mineBreakpointsOOS`/
`recommendBreakpoints`/`winRateOf` 使用，保留）。测试相应清理：`tests/lib-analytics.test.js`
删 `requiredPermN`/`longestAboveRun`/`permutationPeakTest` 三条单测，`tests/field-health.test.js`
删 `scanFieldsForPeaks` 那条，`tests/analytics-parity.test.js` 删对应的差分测试（跟旧版
`js/charts.js` 比对行为一致性的那一条，函数没了就没有可比对象）。

App.jsx 的 ScrollNav 锚点 `section-auc`（标签"AUC/体检/分箱"）随 AUC 面板删除改名
`section-health`（标签"体检/分箱"）。

### 13.4 验证

`npx vite build` 通过，`node tests/run-tests.js` 593/593 通过（599 - 6 条：requiredPermN/
longestAboveRun/permutationPeakTest/scanFieldsForPeaks×2/scanFieldsAuc目标变量排除，各自的
单测随对应函数一起删）。dev server 热更新对已删除文件报了一次
`[vite] Failed to reload AucPanel.jsx` 控制台错误——这是长期运行的 dev server 进程没重启、
还留着旧模块图的正常现象，不是代码问题：`npx vite build` 是全新进程从头构建，完全没有报错，
重启 dev server 这条错误就会消失。

## 14. onlineExport.js 组装字段覆盖率补齐（2026-07-29）

### 14.1 起因：因子池权重超一半"上线恒为缺失"

用户因子权重表红框提示：4 个因子（`chip_analysis.above_below_ratio`/`holder_fomo_ratio`/
`holder_sniper_ratio`/`holder_hhi`）权重合计 51.3（占整池一半以上），FactorLab 判它们"映射不回
原始 ctx，上线后恒为缺失"。第一反应是建议用户删掉或去实盘侧手写——**被用户纠正**：这些字段是
review 工具自己算出来的"组装字段"，`lib/data.js` 里**已经有现成公式**，不是没法算，是压根没人把
公式搬进 `onlineExport.js` 的 `BLOCKS` 派生字段注册表。

查证：`onlineExport.js` 的 `generateOnlineCode` 把用到的字段分三类——`direct`（能核对回单一
ctx 路径，直接取值）、`derived`（字段名在 `FIELD_TO_BLOCK` 里，内联对应块的现成公式）、
`unresolved`（两者都不是，真的写成字面量 `null`）。而 `chip_analysis.above_below_ratio` 其实
**当时已经在 `BLOCKS` 里注册过**（`simple` 块），FactorLab 页面的"映射不回ctx"警告走的是
`classifyFieldOrigin`/`resolveCtxAccessor` 那套更粗糙的判断（`factorLab.js:1323` 硬编码"字段名以
`holder_`/`chip_analysis.` 开头一律判定不可映射"），完全不知道 `FIELD_TO_BLOCK` 这张已知可派生
字段表——两套逻辑不同步，`above_below_ratio` 属于**误报**。`holder_*` 这三个才是真缺口：公式在
`data.js:1088~1367`，但没人搬进 `onlineExport.js`。

### 14.2 用户诉求：所有组装字段都要搬，且是长效常规工作

用户明确要求不只修这 4 个，而是把**所有**组装字段搬完；并且"以后新加组装字段也要搬"应该是
一条常规纪律，不是这次修完就完事。据此设计了两层方案：

1. **一次性搬完当前缺口**——扒了全部"组装字段"（`data.js` 里 `features['xxx']=` 赋值出现过的
   字段，减去已在 `FIELD_TO_BLOCK` 里的），共 **117 个**，逐个核对公式和依赖字段后分批搬进
   `onlineExport.js` 的 `BLOCKS`：
   - `holderStats`（41个）：`data.js:1088~1367` 整段"Top100持有人快照聚合"（A~K 八个子部分：
     交易所占比/转账接盘/钱包画像/gini+hhi集中度/盈亏/入场时间协同/资金协同检测(同源出金分簇+
     持有人互转+同秒建仓+相同买入量)/持仓成本变异系数/头部画像(sniper/dev_team/kol/fomo)/
     创建者名次/前30&50大户买卖&净成本均价/大户SOL余额统计），全部只依赖 `ctx.holders`。
   - `chipShape`（2个）：`chip_analysis.price_to_peak_ratio`/`price_concentration_hhi`，从
     `chip_analysis.price_bars` 算筹码峰位置/集中度。
   - `gmgnTop`（8个）：`gmgn_net_buy_vol_ratio_5m/1h`/`gmgn_buy_sell_count_ratio_1h`/
     `gmgn_vol_accel_5m_1h`/`gmgn_liquidity_change_ratio`/`gmgn_supply_circulating_ratio`/
     `gmgn_price_to_ath_ratio`/`gmgn_fee_to_liq_ratio`，全部来自 `ctx.gmgn` 的真实拆分窗口字段。
   - `klineVolumeShape`（10个）：`kline_volume_*`/`kline_max_rise_*`/`kline_bar_minutes`/
     `kline_turnover_pct`，从 `ctx.kline_and_indicators.kline_bars` 序列算量能形态/急拉速度/换手率。
   - `maxUp`（2个）：`mcap_to_max_up_ratio`/`max_up_speed_pct_per_min`。
   - `lastAlert`（1个）：`last_alert_low_lower_than_pre_low`。
   - `simple` 块扩容（11个）：`buy_sell_amount_ratio`/`buy_sell_tx_ratio`/`smart_buy_sell_ratio`/
     `mcap_liquidity_ratio`/`avg_sell_amount`/`buy_tx_per_buyer`/`sell_tx_per_seller`/
     `smart_money_net_buy_count`/`launch_to_buy_duration`/`above_cost_line`/`cost_line_distance_pct`。
   - `vBreakout` 块扩容（5个）：`v_breakout_volume_record_count`/`recent_breakout_ratio`/
     `recent_drawdown_min`/`recent_signal_from_open_min`/`recent_low_to_buy_min`——原来这个块已经
     覆盖了V转信号族大部分字段，这次是补全遗漏的几个，复用块内已有的 `recentV`/`breakouts`。
   - `continueBreakout`（11个）/`breakout10x`（13个）/`whale`（8个）：早期精选/休眠苏醒/蓝筹共振
     三类信号各自的明细字段，取 `signalTime` 最新一条为"生效"信号，跟已有 `vBreakout` 块同一个
     套路，但三类信号数组结构不同、字段名不同，各自独立成块。
   - `signalTiming`（4个）：`signal_total_count`/`signal_type_count`/`signal_span_min`/
     `signal_first_to_buy_min`——合并六大信号 list（含没做明细字段的 followed/smart_money）按
     `signalTime` 排序统计跨类型时序。
   - 每个字段公式都是从 `data.js` **逐行照抄**，只做 ES5 语法转换（`var`+`function(){}`，
     跟 `onlineExport.js` 已有块风格一致），逻辑不改一个字。踩过一个真实坑：`native_coin_decimal`
     误写成 `L.native_coin_decimal`（`ctx.logearn.native_coin_decimal`），实际上跟
     `native_coin_price` 一样挂在 `ctx` 顶层（`data.js:341` 注释明确写了"是同一个已知缺口"），
     应为 `ctx.native_coin_decimal`——写完立刻发现改掉了，没漏进最终版本。

2. **长效机制**——新增 `tests/online-export-coverage.test.js`：正则扫描 `data.js` 源码里所有
   `features['字面量键']=`/`features["..."]=`/`` features[`...`]= `` 赋值（自动发现新字段，不依赖
   任何手工维护的清单），对每个被 `classifyFieldOrigin` 判定"非原字段"的，断言它要么在
   `FIELD_TO_BLOCK` 里、要么在测试文件内一份**显式豁免清单**里（附理由）。这条测试就是"以后新加
   组装字段也要搬"这句话的强制执行者——谁在 `data.js` 里新写一行 `features['xxx']=...`，不补
   `onlineExport.js` 对应块或豁免理由，`node tests/run-tests.js` 就会红。当前唯一豁免项：
   `post_buy_max_drawdown_pct`（依赖买入之后才知道的 `min_mcap`，任何用它做打分因子的策略都是
   前视偏差，该从因子池删除而不是指望上线代码把它"算出来"——这条不是"忘了搬"，是"不该搬"）。
   `composite_score`（Pro"组合评分"）在当前代码里已是死引用，`data.js` 里没有任何地方真的写
   `features['composite_score']=...`，所以这次的正则扫描天然不会碰到它，不需要额外处理；
   `customFields`（用户在 UI 自定义的任意公式字段）同理不在扫描范围内——它是运行时动态的任意
   JS 表达式，不是一份固定清单，没法预先注册进 `BLOCKS`，想上线只能用户自己把公式抄进实盘策略。

3. **顺带修的误报**：`FactorLab.jsx` 的 `unmappableFactors`（因子表红框警告）加一道
   `FIELD_TO_BLOCK.has(f.field)` 前置判断——命中就不算不可映射，不再重复 14.1 节里
   `above_below_ratio` 那种"其实能上线、页面却报警"的误报。`classifyFieldOrigin` 本身的分类逻辑
   没动（它还服务于「原字段/组装字段」范围筛选 tab，语义不一样，不能混为一谈）。

### 14.3 验证

`node tests/run-tests.js` 595/595 通过（新增覆盖率测试 + 2 条子断言）；`npx vite build` 通过；
额外手工构造了一份贴近真实结构的 ctx（含 holders/chip_analysis/四类信号数组/gmgn 全字段/
kline_bars），跑 `generateOnlineCode` 对 20+ 个新搬字段逐一核对——`chip_analysis.
price_concentration_hhi`/`mcap_to_max_up_ratio`/`max_up_speed_pct_per_min`/
`v_breakout_volume_recent_breakout_ratio` 等值与手算完全一致，`unresolved` 为空。

## 15. 死代码清理：custom-fields.js 老版面板管理代码 + utils.js 两个零调用函数（2026-07-29）

### 15.1 起因

对 `src/lib`/`src/ui` 做整体重构扫描时发现：`custom-fields.js` 是从 `js/custom-fields.js`
机械移植来的，里面除了公式编译执行 + 聚合函数库这部分仍在被 `data.js`/`customFieldsRuntime.js`
实际使用外，还带着一整套"老版面板管理代码"（增删字段、导入导出配置、字段依赖分析）——这部分
依赖老版 `ui.js` 的模块级全局变量（`matchedRows`/`allNumericKeys`/`renderCustomFieldList`/
`updateScatterSelects`/`refreshAnalysisViews`/`showToast`/`showConfirm`/浏览器 `prompt()`），
React 化时从未被迁移接入，`customFieldsRuntime.js` 早已用"定义作为入参"的纯函数版本
（`applyDefs`/`testDef`/`validateName`）取代了它。逐个 grep 确认零调用方后，这部分代码不只是
"暂时没用"，调用了就会直接 `ReferenceError`——纯粹的死重量，容易误导读者以为它是活的。

### 15.2 删除范围

`custom-fields.js` 删除：`applyCustomFields`（被 `customFieldsRuntime.js` 的 `applyDefs`
取代）、`customFieldStats`、`removeCustomFieldValues`、`refreshAfterCustomFieldChange`、
`extractFieldRefs`/`computeCustomFieldDependencies`（字段依赖分析，从未接入任何 UI）、
`editingCustomFieldIdx`、`validateCustomFieldName`（被 `customFieldsRuntime.js` 的
`validateName` 取代）、`promptImportConflict`/`importCustomFieldsFromFile`（导入导出配置，
从未接入 UI）、`saveCustomFields`（写入路径已由 `customFieldsRuntime.js` 的 `saveDefs`
接管）、`CUSTOM_FIELDS_CONFIG_VERSION`、`CUSTOM_FIELD_TEMPLATES`。连带清掉因此变成死代码的
顶部 import（`DERIVED_KEYS`/`SIGNAL_KEYS`/`readJson` 来自 `data.js`、`FIELD_DESC` 来自
`dictionary.js`、`formatNumberSmart` 来自 `utils.js`——后者其实一开始就没被用到）。保留：
`customFields` 模块状态 + `loadCustomFields`（`data.js` 的 `isAssembledField` 要查、
`customFieldsRuntime.js` 的 `saveDefs` 保存后要用它同步模块状态）、`compileCustomField`/
`invokeCustomField`/`customRowMeta`/`buildZscoreFn`（公式编译执行链路，`customFieldsRuntime.js`
直接引用）、以及聚合/公共函数库全体（`countWhere`/`avgField`/`sumField`/`maxField`/`minField`/
`giniCoefficient`/`safeDiv`/`pct`/`clamp`/`log1p`及其 `_FN_NAMES`/`_FNS` 常量——这些是用户
写自定义字段公式时能直接调用的运行时工具箱，不是死代码）。文件从 382 行降到约 210 行。

`utils.js` 删除两个零调用方的函数：`withLoading`（依赖不存在的 `showLoading`/`hideLoading`
全局函数，调用即崩）、`csvEscape`（纯函数但确认全项目无引用）。

### 15.3 验证

`node tests/run-tests.js` 595/595 通过（这次清理删的都是零测试覆盖的死代码，测试数不变）；
`npx vite build` 通过。

## 16. 抽公共工具：文件下载 + 剪贴板复制 + localStorage 读写（2026-07-29）

### 16.1 起因

整体重构扫描发现三类样板代码在多个组件/lib 文件里各自手写、逐字重复：`new Blob→
createObjectURL→临时<a>→点击→清理` 这套文件下载流程在 8 个组件里各写一遍，写法还互相不一致
（有的不 append 到 DOM、有的用 `a.remove()` 有的用 `removeChild`——`BacktestReports.jsx` 甚至
已经在注释里承认"跟项目里其它导出同一套 Blob 写法"却没有真的抽出来）；`navigator.clipboard.
writeText` 包 try/catch 弹 antd message 这套在 8 处组件里重复，其中几处用可选链裸调用不处理
失败，复制真失败了也照样弹"已复制"；`localStorage.getItem/setItem` + `JSON.parse/stringify` +
try/catch（隐私模式兜底）这套在 12 个 lib 文件、17 个 key 上重复，部分注释还写着"跟 labels.js /
excludedTokens.js 一个路子"——即已经意识到在重复，但没有收口。

### 16.2 改法

新增三个纯工具模块，只收公共的取值/异常吞掉这层机制，各 store 自己的形状校验（是不是数组/
字段够不够）留在各自文件里，不强行塞进一个过度泛化的工厂函数：

- **`lib/download.js`**：`downloadBlob(content, filename, mimeType)` + 两个便捷封装
  `downloadText`/`downloadJson`。8 处调用点（`FieldBrowser.jsx`/`BinBarCard.jsx`/
  `SnapshotInspector.jsx`/`LabelPanel.jsx`/`PerfMonitor.jsx`/`FactorLab.jsx`/
  `strategyReplay/BacktestReports.jsx`/`strategyReplay/OnlineExportPanel.jsx`）全部改用它；
  `BacktestReports.jsx` 里那个已经自认重复的本地 `downloadMarkdown` 直接删掉。
- **`lib/clipboard.js`**：`copyText(text)` 只负责复制本身（成功返回 true/失败返回 false），
  成功/失败提示文案留给调用方——各处提示语义不同（"已复制 JSON"/"已复制 N 个 CA"等），
  不能强行统一成一句话。8 处调用点改用它，顺带修正了几处"复制失败也照样弹成功"的小毛病
  （`SnapshotInspector.jsx`/`FieldPickerModal.jsx`/`FilterPanel.jsx` 原来用
  `navigator.clipboard?.writeText(...)` 裸调用不管结果）。
- **`lib/localStorageStore.js`**：`readJsonLS`/`writeJsonLS`/`readRawLS`/`writeRawLS`/
  `removeLS` 五个原语。改造了 `labels.js`/`dataFolders.js`/`excludedTokens.js`/
  `factorExclusions.js`/`removedFactors.js`/`backtestReports.js`/`strategyVersions.js`/
  `tableHiddenFields.js`/`factorPoolStore.js`/`todoList.js`（2 个 key）/`dataSlices.js`
  （4 个 key）/`campLibrary.js`（3 个 key）共 12 个文件、17 处读写。另外把 `FilterPanel.jsx`
  里内联的筛选预设持久化（`loadPresets`/`savePresets`）挪成独立的 `lib/filterPresets.js`，
  跟项目里其它持久化状态（因子池/已删因子/已排除因子等都各自有 lib 模块）的惯例对齐——
  之前这是唯一一处内联在组件里的持久化状态。

没动 `custom-fields.js`/`customFieldsRuntime.js` 里的 localStorage 调用——前者刚在第15节清理过，
后者的 `loadDefs`/`saveDefs` 逻辑和错误处理跟其它 store 已经不完全一样（`saveDefs` 保存后要连带
调 `loadCustomFields()` 同步模块状态），不值得为了统一而改，改动风险大于收益。

### 16.3 验证

`node tests/run-tests.js` 595/595 通过（纯提取重构，行为不变，测试数不变）；`npx vite build`
通过；dev server 里过一遍页面加载，控制台无新增报错（原有的 antd `Space.direction` 过时警告
是既有噪声，跟这次改动无关）。导出/复制类按钮大多要求先通过原生文件选择框加载真实数据才能
触发（跟前几节记录的限制一样），这次没能在浏览器里逐个点击实测下载/复制成功——改动本身是
纯函数级别的行为等价替换（每处调用点逐个核对过参数/mimeType 跟原写法一致），风险可控。

## 17. 拆"上帝组件"第一步：StrategyReplay.jsx 抽出 WeightSuggestionPreview（2026-07-29）

### 17.1 背景

`ui/FactorLab.jsx`（1506行）/`ui/DataLoader.jsx`（806行）/`ui/StrategyReplay.jsx`（949行）
三个文件长期偏"上帝组件"：主文件里混了不该属于它的内联子组件、纯 I/O 逻辑、多件独立职责的
状态管理。用户要求按已有拆分惯例（`ui/strategyReplay/ScoreReturnPanel.jsx` 等已拆出去的卡片、
`ui/factorLab/useFactorScan.js` 的 hook 抽取模式）挨个拆，但风险比前两批重构（第13~16节，纯
删除/纯工具抽取）更高——这次要动的是"从一个大文件里搬出一段有状态、有渲染逻辑的代码"，容易在
搬运途中改漏 prop、漏 import、或者引入渲染时机差异。所以先挑`StrategyReplay.jsx`里"内嵌了一个
完整独立组件 `WeightSuggestionPreview`（约120行）"这一项动手——三处目标里改动面最小、边界最
清楚的一处：组件已经是纯 props 驱动（`preview`/`onCancel`/`onConfirm`），不读任何外层闭包变量，
机械搬移风险最低，适合验证"这套拆分节奏在这一批文件上是否可行"，改完再决定要不要接着拆
`FactorLab.jsx`/`DataLoader.jsx`。

### 17.2 改法

新增 `ui/strategyReplay/WeightSuggestionPreview.jsx`，把原 `StrategyReplay.jsx` 第822~949行的
`WeightSuggestionPreview` 函数原样搬过去（调权建议试算弹窗：改动前后指标对比表 + 单调性ρ判定
文案 + 样本外闸门校验），逻辑一字未改。`StrategyReplay.jsx` 改为 `import WeightSuggestionPreview
from './strategyReplay/WeightSuggestionPreview.jsx'`，调用点（`<WeightSuggestionPreview
preview={preview} onCancel={...} onConfirm={confirmPreview} />`）不变。原文件顶部 antd 具名导入
里的 `Table`/`Modal`/`Checkbox` 三个——逐一 grep 确认在删除的这段之外全项目内该文件再无其它
使用点——随组件搬走一并从 `StrategyReplay.jsx` 的 import 列表里删除，避免留下死 import。
`StrategyReplay.jsx` 从 949 行降到 822 行。

### 17.3 验证

`node tests/run-tests.js` 595/595 通过（纯移动重构，无测试覆盖此组件的渲染逻辑，测试数不变）；
`npx vite build` 通过；dev server 里重新加载页面，控制台无新增报错、无 `Failed to reload` 之类
的模块解析问题（原有 antd `Space.direction` 过时警告是既有噪声）。`WeightSuggestionPreview` 弹窗
本身要先加载真实数据、跑一次回放、点"调权建议"才会弹出（跟前几节记录的"导出/复制类按钮依赖
原生文件选择框"是同一类限制），这次没有在浏览器里实际触发弹窗做像素级核对——改动是纯粹的
文件搬移（组件体一字未改，只换了导入路径），风险集中在"漏删/漏搬 import"这一类问题上，已经
用 grep 逐个确认，且 build/lint 层面的 unused-import 不会静默通过。

## 18. 拆"上帝组件"第二步：FactorLab.jsx 抽出 BaselineVsTrainCard（2026-07-29）

### 18.1 改法

延续第17节的节奏，从 `FactorLab.jsx` 里挑第二处改动面小、边界清楚的目标：「基线库 vs 训练集
(按天) 对比」卡片（原第1412~1474行，约65行 JSX）。这处推导逻辑（`strategyOptions`/
`baselineVsTrain` 两个 `useMemo`，依赖 `archiveAllRows`/`archiveSliceCats`）留在 `FactorLab.jsx`
不动，只把纯展示部分搬到新的 `ui/factorLab/BaselineVsTrainCard.jsx`，走跟已拆出去的
`MissedRowsCard`/`CompareHardGateCard` 一样的模式——子组件只接收算好的数据当 props，不接触
上层状态。`fmtPct` 这个格式化小函数在 `FactorLab.jsx` 里还有十几处别的用途要留着，新组件里
按 `MissedRowsCard` 的先例本地拷贝一份同样的小函数，不额外抽公共 util（一行的格式化函数，
抽出去引入的 import 成本比复制这一行更高）。

顺带清理：`factors.length > 0` 这层判断按已有惯例挪到调用点（`{factors.length > 0 &&
<BaselineVsTrainCard .../>}`），组件本身不重复判断；`FactorLab.jsx` 顶部 antd 具名导入的
`Select` 随这块搬走后失去了唯一使用点，一并删除。`FactorLab.jsx` 从 1503 行降到约 1443 行。

### 18.2 验证

`node tests/run-tests.js` 595/595 通过；`npx vite build` 通过。dev server 重新加载时控制台报了
一次 `[vite] SyntaxError: Identifier 'WeightSuggestionPreview' has already been declared` /
`Failed to reload /src/ui/StrategyReplay.jsx`——这是第17节那次改动遗留的 HMR 模块图状态过期
（同一类"长期运行的 dev server 没重启、还留着旧模块图"的已知现象，第13.4节记录过一次同款），
跟这次改的 `BaselineVsTrainCard` 无关；`npx vite build`（全新进程从头构建）没有任何报错，
`grep` 确认 `WeightSuggestionPreview` 在源码里只声明了一次（新文件里 `export default function`
一处 + `StrategyReplay.jsx` 里 `import` 一处），重启 dev server 这条提示会消失。因数据加载依赖
原生文件选择框（跟前几节同样的环境限制），未在浏览器里对真实数据触发这张卡片做像素级核对。

## 19. 拆"上帝组件"第三步：FactorLab.jsx 抽出 BacktestCard（2026-07-29）

### 19.1 改法

第17~18节的两处都是改动面很小的目标（内嵌组件/65行卡片），这次拆用户点名风险更高的一处：
「回测」卡片（原第1202~1401行，约200行，含 cutoff 滑块/触发数统计/cutoff扫描曲线/分数-倍数
散点/十分位表/时间外推验证 walk-forward 逐段表+详情面板，内嵌 3 层匿名 IIFE 渲染函数）。

依赖梳理：这块 JSX 要读 19 个外部值（`backtest`/`cutoff`/`setCutoff`/`cutoffMin`/
`cutoffRecommend`/`applyRecommendedCutoff`/`exportFullReport`/`exportRawDataJson`/`hasEvil`/
`base`/`sweepFigure`/`scoreScatterFigure`/`threshold`/`oosBusy`/`runOOS`/`oosProgress`/`oos`/
`oosFoldRows`/`oosFoldIdx`/`setOosFoldIdx`/`oosFoldSweepFigure`），全部改成 props 传入新的
`ui/factorLab/BacktestCard.jsx`——这些计算（`useMemo`/`useState`）留在 `FactorLab.jsx`，因为
`sweepFigure`/`oosFoldRows` 等好几个在 `exportFullReport`（导出完整报告）等其它地方还有独立
调用点，不能整体搬走。`decileColumns`（十分位表列定义）只在这块用到，整段搬进新组件；
`sweepAt`（纯函数，`bt`/`cut` 两个参数、不读组件状态）在 `FactorLab.jsx` 里另外 3 处还在用
（时间外推逐段扫描），保留原地，新组件里按 `fmtPct` 的先例本地拷贝一份，不当函数类型 prop 传。

组件体 JSX 一字未改，只是从"直接读闭包变量"改成"读 props"。清掉因此失去唯一用途的
`Slider`/`PlotlyChart` 死 import。`FactorLab.jsx` 从约1443行（第18节末状态）降到约1247行——
连同第17~18节，三步累计从最初的 1503 行降到 1247 行，去掉约 17%。

### 19.2 验证

`node tests/run-tests.js` 595/595 通过；`npx vite build` 通过。dev server 里仍报着第18.2节
记录的同一条 `WeightSuggestionPreview already declared` HMR 残留（跟本次改动无关，源码里
grep 确认只声明一次）；因数据加载依赖原生文件选择框，未在浏览器里对真实数据逐项核对
cutoff 滑块/时间外推详情面板的渲染结果——风险集中在"prop 传漏/传错名"这一类问题上，
19 个 prop 逐个跟原变量名核对过，且 build 不报 `is not defined`/`is not a function`
这类运行时才会暴露的引用错误（React 组件里未定义变量在纯渲染路径下会在 build 阶段被
当成全局引用放过，需要格外靠这次逐项核对而非只靠 build 通过）。

## 20. 拆"上帝组件"第四步：DataLoader.jsx 抽出 useArchiveManager（进行中，见20.4待办）

### 20.1 跟前三步不一样在哪

前三步（第17~19节）都是"从一个大文件里搬一块自包含的 JSX/子组件出去"，风险集中在"prop
传漏"这一类问题。`DataLoader.jsx`（改前806行）不一样：它是三件**互相牵扯**的事混一个文件——
①文件上传解析（`files`/`analyze()`）②存储后端+批次/文件夹归档管理（`backend`/`batches`/
`folders`/...）③时间切片（`allRows`/`sliceCats`/`sliceSel`/...），`analyze()` 这个函数本身
要跨读①②③三块状态，不是"挑一块搬走"能解决的，得先按 `ui/factorLab/useFactorScan.js` 的
先例拆成 hook，把状态管理和渲染分开，同时保留 `analyze()` 这个跨三块的"胶水函数"在主组件里。

### 20.2 这次做了什么：`useArchiveManager`

新增 `ui/dataLoader/useArchiveManager.js`，把②（存储后端+批次/文件夹归档管理）整块搬进去——
这是三块里状态耦合最少、最适合先拆的一块（时间切片虽然也依赖 batches/store 做自动载入，
但只读不改；上传解析`analyze()`才是真正双向依赖②③的那个，见下节待办）。搬的内容：
- 状态：`batches`/`storeOk`/`backfilling`/`backend`/`fsDirName`/`fsPendingAuth`/`folders`/
  `selectedKeys`/`folderModal`
- 派生值：`store`（按 backend 选 fsStore/idbStore）/`savedCalls`/`savedSnaps`/`groups`/
  `multiStrategy`/`needsBackfill`/`batchKeyToId`/`selectedBatchIds`/`selectionGroupLabel`/
  `treeData`
- 操作：`refreshBatches`/`handlePickDirectory`/`handleAuthorize`/`handleForgetDirectory`/
  `moveBatchesToFolder`/`createFolder`/`renameFolderTo`/`deleteFolder`/`submitFolderModal`/
  `deleteBatchIds`/`handleBackfill`

关键设计点：**hook 返回值的 key 名跟 `DataLoader.jsx` 原来的本地变量名完全一致**——JSX
渲染部分（原第503~806行）因此**一行没改**，只是把上面这些声明换成一次
`const {...} = useArchiveManager({ onStatus: setStatus })`。这是刻意延续第17~19节"改动面
最小化"的做法：JSX 越不用碰，出错面越小。唯一的跨概念耦合是 `handlePickDirectory`/
`handleAuthorize`/`handleBackfill` 内部要在失败/完成时报一条状态——不是把 `status`
状态也搬进 hook（那会让 hook 管上传解析该管的东西），而是让 hook 接收一个 `onStatus`
回调，`DataLoader.jsx` 传 `setStatus` 进去，两边只通过这一个回调耦合。

`DataLoader.jsx` 原本 `groupBatches`/`deriveBatchStrategy`/`UNNAMED`/`loadFolders`等
导入随对应逻辑一起搬空，顶部 import 相应清理；`groupKeyOf`/`UNKNOWN_ID`/`fsStore`
因为在剩下的 `analyze()`/`autoLoad()`/JSX（`fsStore.isSupported()`）里还有独立用途，
保留在 `DataLoader.jsx`。`MOVE_OUT`/`storageLabel` 两个原来定义在 `DataLoader.jsx`
顶部的模块级常量/函数搬进 hook 模块导出，`DataLoader.jsx` 改成从 hook 模块 import
（而不是各自留一份），因为一个只服务归档逻辑、一个是単纯格式化，都没有理由留在两处。
`DataLoader.jsx` 从 806 行降到 641 行。

### 20.3 验证

`node tests/run-tests.js` 595/595 通过；`npx vite build` 通过；额外做了两层核对（这次没有
现成测试覆盖这个组件，比前三步更依赖手工核对）：① 写了个 node 脚本对 hook 返回的 32 个
key 逐个 grep 原 JSX 里的引用次数，确认全部 ≥1 次被用到（`createFolder`/`renameFolderTo`/
`batchKeyToId` 三个显示只有 1 次——即只在解构语句本身出现，回查发现它们原本就只被
`submitFolderModal`/`selectedBatchIds` 内部调用、从未被 JSX 直接引用，这三个随手一起
搬进 hook 后已经是 hook 内部实现细节，不需要在 `DataLoader.jsx` 再解构出来，删掉了这三个
死绑定）；② 在浏览器里实际加载页面截图确认「数据源」卡片正常渲染（上传按钮/分析按钮/
选择本地文件夹按钮都在，没有报错边界/白屏）——但因为本地没有已存批次数据，没能实际点开
「数据源管理」展开归档树、建文件夹、勾批次这些交互路径，这部分只靠上面的 grep 核对
+ build 通过，没有端到端点击验证。dev server 控制台里的 `Failed to reload DataLoader.jsx`
跟第18~19节记录的同一个"长期运行 dev server 旧模块图"问题同源（同一次 `WeightSuggestionPreview`
残留触发的级联），`npx vite build` 全新进程不受影响。

### 20.4 待办：时间切片还没拆

`DataLoader.jsx` 剩下的 641 行里，时间切片（`allRows`/`sliceKey`/`sliceCats`/`sliceSel`/
`sliceSelectedDays`/`deletedDays`/`rangeStart`/`rangeEnd` 及 `emitRows`/`autoLoad`/
`sliceSummary`/`sliceTreeData`/`dayKeyMap`/`daysFromKeys`/`rowsOfKeys`/`assignSliceDays`/
`assignSelectedDays`/`deleteDays`/`deleteSelectedDays`/`restoreDeletedDay`/`assignRange`/
`assignAllDays`/`changeSliceSel`/`selectDays`/`effectiveCount`，约200行）还没拆，是下一步
目标。跟 `useArchiveManager` 不同，这块**不能照搬同一套手法直接抽**，原因：
- `emitRows`（分析完成后的收尾：过滤已删天数、记作用域、发下游）被 `analyze()`
  （留在主组件，上传解析概念）和 `autoLoad()`（自身也该进这个 hook）两处调用，
  `analyze()` 传入 `rawRows`+`key` 两个参数即可，不需要读取 `analyze()` 内部状态，
  接口是干净的，可以整体搬。
- 但 `autoLoad()` 需要 `batches`+`store`（来自 `useArchiveManager`）——即将新增的
  `useTimeSlices` hook 需要接收 `batches`/`store` 作为参数（或者 `DataLoader.jsx`
  把这两样当参数传给它），不能像 `useArchiveManager` 那样零依赖独立。
- `onArchiveChange` 这个 effect（第57~63行，把 `allRows`/`sliceCats` 上抛给 App 供
  FactorLab 用）要跟着 `allRows`/`sliceCats` 一起搬进新 hook。
- `showArchive` 这个纯 UI 折叠开关虽然初始值读 `loadSliceScope()`（时间切片的持久化
  状态），但语义上是"数据源管理面板要不要默认展开"，跟归档管理（`useArchiveManager`）
  关系更近；先留在 `DataLoader.jsx` 主体，不强行归进任一个 hook。

建议的下一步做法：新增 `ui/dataLoader/useTimeSlices({ batches, store, onRows })`，
返回值 key 名同样跟 `DataLoader.jsx` 现有本地变量名保持一致（复用第20.2节这条纪律），
JSX（第661~800行左右的"时间切片"那一整块）不用改。搬完后 `DataLoader.jsx` 应该只剩
`analyze()`（真正的胶水函数，读两个 hook 的返回值 + 自己的 `files`/`uploadKey`/`status`/
`busy`/`pct`/`includeSaved`/`persist`）和 JSX。做完这一步后 `DataLoader.jsx` 大概能降到
400行上下（上传解析约150行 + JSX约250行）。风险点跟这次一样：**逐个 grep 核对 hook
返回值有没有被 JSX/analyze() 完整覆盖，不能只看 build 通过**（build 不报未定义变量的
运行时引用错误，第19.2节已经记过这个坑）。

## 21. 拆"上帝组件"第四步收尾：DataLoader.jsx 抽出 useTimeSlices（2026-07-29）

### 21.1 改法：按第20.4节的计划执行

新增 `ui/dataLoader/useTimeSlices({ batches, store, onRows, onArchiveChange, onStatus,
onBusyChange })`，把时间切片整块（状态：`allRows`/`sliceKey`/`sliceCats`/`sliceSel`/
`sliceSelectedDays`/`deletedDays`/`rangeStart`/`rangeEnd`；操作：`emitRows`/`autoLoad`
及其自动载入 effect/`assignSliceDays`/`assignSelectedDays`/`deleteDays`/
`deleteSelectedDays`/`restoreDeletedDay`/`assignRange`/`assignAllDays`/`changeSliceSel`/
`selectDays`；派生值：`sliceSummary`/`sliceTreeData`/`dayKeyMap`/`effectiveCount`；以及
把 `allRows`/`sliceCats` 上抛给 App 的 `onArchiveChange` effect）搬进去，`DataLoader.jsx`
的 JSX（时间切片那一整块，约140行）跟第20.2节的 `BaselineVsTrainCard`/`useArchiveManager`
一样**一行没改**，只是把状态声明换成一次 `useTimeSlices()` 解构。

这个 hook 比 `useArchiveManager` 多两处真正的跨概念耦合（第20.4节已经预判到）：
- **`store`/`batches`**：`autoLoad`（批次就绪后自动载入上次作用域）要用归档管理 hook
  的这两样，作为参数传入，不是零依赖。
- **`onBusyChange`**：原 `autoLoad` 里有 `setBusy(true)`/`setBusy(false)`（控制"分析"按钮
  的 loading 态，属于上传解析概念、留在 `DataLoader.jsx`），照搬 `onStatus` 的先例加一个
  回调而不是把 `busy` 状态也搬进 hook——写这段时最初漏掉了这个回调、随手拿一个
  `onStatus?.({type:'loading'})` 占位糊过去，自己核对时发现这是编造的行为（原代码里根本
  没有"loading"这个 status type），不是老实的机械搬移，改成了正经的 `onBusyChange` 回调
  （详见21.2节的核对方法）。

`sliceKey`（切片作用域标识，只在 `emitRows`/`autoLoad` 内部读写，从没被 JSX 或 `analyze()`
直接引用过）、`sliceCats`（同理，只在时间切片自己的函数内部用）、`dayKeyMap`/
`daysFromKeys`/`rowsOfKeys`（纯内部辅助）都不对外暴露，只有 JSX 和 `analyze()` 真正要用的
21 个名字进了 hook 的返回对象。`DataLoader.jsx` 顶部的 `loadSliceCategories`/
`saveSliceCategories`/`assignDays`/`dayInRange`/`selectRowsBySlice`/`summarizeSlices`/
`CATEGORIES`/`loadSliceSel`/`saveSliceSel`/`saveSliceScope`/`dayOf`/`strategyOf`/
`sliceKeyOf`/`loadDeletedDays`/`saveDeletedDays`/`filterDeletedRows`（`lib/dataSlices.js`
的绝大部分导出）随逻辑一起搬空，只留 `loadSliceScope`（`showArchive` 折叠状态的初始值
还需要它）。搬完之后 `useEffect`/`useMemo`/`useRef`/`startTransition`（React）和
antd 的 `message` 在 `DataLoader.jsx` 里也全部失去了唯一用途，一并从 import 里删掉——
（`message` 差点被误判为还在用，因为文件里还有 6 处 `message` 字样，但逐个核对发现
全是 `e?.message`（错误对象属性）或 `<Alert message={...}>`（组件 prop 名），没有一处
是调用antd `message` 单例本身）。

`DataLoader.jsx` 从 641 行（第20节末状态）降到 443 行——连同第20节的
`useArchiveManager`，两步合计从最初 806 行降到 443 行，去掉约 45%；`FactorLab.jsx`（1503→
1247，第17~19节）+ `StrategyReplay.jsx`（949→822，第17节）+ `DataLoader.jsx`（806→443，
第20~21节）三个"上帝组件"目标至此都已完成至少一轮拆分。

### 21.2 验证（含一次真实踩坑）

写这个 hook 时逐段对照原文件手工搬运，搬完用 `diff` 命令把原 `DataLoader.jsx` 第150~336行
（时间切片整块原文）跟新 hook 文件对应段落做逐行比对（而不是只凭肉眼过一遍）——这一步
揪出了两处问题：① `autoLoad` 里 `mergeDaily(saved.callsArrays, saved.snapsArrays)` 被
手滑打成了 `saved.snapshots`（打字时可能是被同一函数里紧接着那行 `merged.snapshots`
带偏了——两个变量名相似但字段名不同，`saved`/`merged` 是两个不同来源的对象），
`diff` 一比对立刻现形，改回 `saved.snapsArrays`；② 上面21.1节提到的 `setBusy` 编造成
`onStatus` 占位那处，也是同一次 `diff` 核对时发现"原文件这里明明是 `setBusy`，我写的是
瞎编的 `onStatus`"才补上 `onBusyChange`。这两处如果不是逐行 diff 核对、只凭肉眼扫一遍
大概率会漏过（自动载入这条路径依赖用户已有历史数据+持久化的分析范围，这次环境里
验证不到，一旦漏改，症状会是"自动载入时长期显示 loading 转圈不停"这种只有真实数据、
真实用户才会踩到的坑）。这次经验之后，凡是"手工搬运一大段逻辑代码"（不是简单挪 JSX）
都应该收尾时补一次原文件 vs 新文件的逐行 diff，不能只靠"看起来对"。

`node tests/run-tests.js` 595/595 通过；`npx vite build` 通过；写了个 node 脚本把 hook
返回的 21 个 key 逐个 grep 在 `DataLoader.jsx` 里的出现次数，确认全部 ≥2 次（destructure
声明本身 1 次 + 至少 1 次真正被 JSX/analyze() 引用），没有第20节那种"解构了但没用上"的
死绑定。浏览器截图确认页面正常渲染、无错误边界；因本地没有已存批次数据，`autoLoad`
这条自动载入路径（连同上面21.2节修复的两个坑）没能在真实数据下端到端触发验证，
只靠这次的逐行 diff + grep 覆盖率核对，建议用户下次有历史数据时留意一下自动载入
是否正常（不再一直转圈、批次归档操作/时间切片操作是否符合预期）。


## 22. 拆 data.js 的 buildRows()：10 个组装字段块抽成具名函数 + 补单元测试（2026-07-29）

### 22.1 背景与整体方案

`lib/data.js` 的 `buildRows()` 原本是约 1120 行的巨型函数，是重构清单里"高优先级"第 4 项，
也是风险最高的一项——它是 parity 测试和 `onlineExport.js`/`strategySpec.js` 手工同步的对象，
任何行为偏差都可能悄悄影响下游。

**目标**：纯粹的 legibility 重构，逻辑一行不改，只是把循环体内一段段用注释分隔的"组装字段块"
搬成模块级具名函数（`applyXxxFeatures`），并**新增单元测试**直接测这些函数——此前这些字段
公式只被 `parity.test.js`/`analytics-parity.test.js` 这类端到端测试【间接】覆盖，端到端只能
告诉你"整体对不对"，单个字段的分母为 0、数组为空、必需字段缺失这些分支从来没被直接测过。

`buildRows()` 循环体一共约 17 个"块"，其中 10 个完全自包含（只读 `features`/`arrays`/`s` 已经
摊平好的值，互不依赖），全部拆完；V 转信号（`v_breakout_volume`）那一簇因为 `breakouts`/
`recentV` 被三处不连续的代码共用，**暂不拆**，留在 `buildRows()` 内联（原因见 22.5 节）。

### 22.2 拆出来的 10 个函数

按在 `data.js` 里的出现顺序（都放在 `resolveNativeDecimals` 之后、`buildRows` 之前）：

| 函数 | 原注释块 | 产出字段数 |
|---|---|---|
| `applySimpleRatioFeatures(features, mcap)` | 买卖比率类组装字段 | 11 |
| `applyChipShapeFeatures(features, arrays, mcap)` | 筹码分布组装字段 | 4 |
| `applyContinueBreakoutFeatures(features, s, buyMs, swapBeginMs)` | 早期精选信号 continue_breakout_volume 明细 | 11 |
| `applyBreakout10xFeatures(features, s, buyMs, swapBeginMs)` | 休眠苏醒信号 breakout_volume_10x 明细 | 13 |
| `applyWhaleFeatures(features, s, buyMs, swapBeginMs)` | 蓝筹顶级赢家共振信号 whale | 8 |
| `applyKlineVolumeShapeFeatures(features, arrays)` | K线量能形态（含"急拉程度"子块） | 10 |
| `applyHolderStatsFeatures(features, arrays)` | Top100 持有人快照聚合（单块最大，282 行） | 34+ |
| `applyGmgnTopFeatures(features)` | gmgn 顶层字段组装（gmgn_ 前缀） | 8 |
| `applyMaxUpFeatures(features, mcap)` | logearn 最大涨幅(max_up)组装 | 2 |
| `applySignalTimingFeatures(features, categorical, s, buyMs)` | 信号时序（跨类型先后关系） | 4 + 4 个 categorical |

`buildRows()` 从 **1117 行降到 392 行**（-65%），循环体里对应位置变成一行函数调用。

**保留在循环体里的共享局部变量**：`mcap`/`currentAvgPrice`/`fin`（=`Number.isFinite` 别名）/
`buyMs`/`swapBeginMs`/`launchMs`——它们要么被未拆的 V 转集群用，要么要按需传参给上面这些函数，
按参数传进去而不是在每个函数里重算一遍。原来那些只服务单个块的局部变量（`buy`/`sell`/
`picks`/`wakes`/`whales`/`klineBarsForVol`/`holdersAll`/`gp` 等）全部随块搬进对应函数内部
重新声明，循环体里已无残留（脚本扫过一遍，没有"声明了但只出现 1 次"的死变量）。

**两处非纯机械搬移的地方**（其余都是逐字节照搬）：
1. 原文用 `fin(...)` 别名的块（whale/kline量能/gmgn/max_up），函数内部开头补一行
   `const fin = Number.isFinite;`——`fin` 原来是循环体局部变量，搬出去就取不到了。
2. `SIGNAL_LISTS`（六类信号 list 的键名映射）从循环体内提到**模块顶层**——纯字面量常量、
   与行数据无关，原来每处理一行都要重新构造一次这个对象。改动前独立核实过是安全的
   （无副作用、无外部引用），也是这一整轮唯一一处"顺手小改进"。

### 22.3 搬运手法：脚本按行切片 + 逐字节回比，不手抄

第 21.2 节记过一次真实踩坑（手工搬运时 `saved.snapsArrays` 被打成 `saved.snapshots`、
`setBusy` 被编造成 `onStatus`），所以这次**没有用手抄**：写了个 node 脚本按行号切片搬运
（`slice(起, 止)` + 统一减 2 空格缩进 + 包成函数体），切片前先 `expect(行号, 关键字)` 断言
边界行内容对得上，避免行号算错。

搬完立刻跑第二个校验脚本：把新函数体重新加回 2 空格缩进，跟改动前文件的对应行区间逐行
`===` 比对，**全部 10 个块都是逐字一致**（93/81/32/122/281/31/8/56 行等），并额外核对
`features[...]=` 赋值总数（135）与 `categorical[...]=` 赋值总数（4）改动前后不变——后者正是
第 14.2 节 `online-export-coverage.test.js` 那道闸门扫描的东西，字段搬丢了这个数就会变。

### 22.4 顺带修的一处测试耦合

`run-tests.js` 里"字段候选池剔除：不得误杀任何组装字段"这条测试原本扫的是
`sandbox.buildRows.toString()`——字段计算搬出去之后它只能捞到 24 个字段（原来 130+），
断言 `made.length > 50` 直接红。**改法**：跟 `online-export-coverage.test.js` 统一口径，
改成静态扫描 `src/lib/data.js` 整份源码（新增 `fs`/`path`/`fileURLToPath` import 和 `ROOT`
常量）。这样既恢复了原来的覆盖范围，也不再受后续任何拆分影响。这不是放宽断言——扫描范围
反而比原来更大（原来只扫 buildRows 一个函数）。

### 22.5 明确不动的部分：V 转信号（v_breakout_volume）集群

从"buy 之前最大回撤"注释开始、到"V 转信号最低点与成本线之间的距离"结束（约 250 行），
`breakouts`/`recentV`/`vCycleKey` 三个局部变量被**三处不连续**的代码共用（中间还穿插着
"推特改名次数"、"last_alert 对比"两个不相关的小块）。硬拆有两个选择：
- **(a)** 让 `recentV`/`breakouts` 作为返回值在多次函数调用之间传递——函数签名别扭，但完全
  不改变原执行顺序；
- **(b)** 把三处代码挪到一起合并成一个函数——逻辑不变，但**会改变 `features` 键的写入顺序**
  （大概率不影响任何下游，因为没人依赖对象键序，但这是一处偏离"纯机械搬移"的改动）。

**用户已拍板：这一轮不动，留到下次单独一个 commit 再做。** 理由是它跟前面 10 个块不是同一类
工作——前面是"搬"，风险在"抄错字"，靠逐行 diff 能完全消掉；V 转是"改结构"，(a)/(b) 都不是
逐字节一致能证明的，得靠人判断，收益只有 250 行。混进同一个 diff 里会让这次干净的机械重构
变得不好验证。其余 10 个块已全部完成。

### 22.6 新增单元测试：`tests/build-rows-features.test.js`

用户本轮明确要求"记住加上单元测试"。新建该文件（31 条），10 个函数逐个覆盖三类场景：
① 正常输入 → 字段值符合手算结果；② 关键缺失分支 → 该缺失时字段**确实不写入**（而不是悄悄
写个 0/NaN/Infinity 进去）；③ 已知边界。重点测到的边界：

- `applySimpleRatioFeatures`：**分子为 0 是合法值**（买入量为 0 → 比值 0，不能当缺失丢样本），
  分母为 0/缺失时不写 Infinity。
- `applyChipShapeFeatures`：`mcap_range` 畸形的桶不参与选峰（否则 `peakMcap` 被永久置成 NaN，
  后面有效的 bar 再也接不上），但其 `percent` 仍计入 hhi 总量。
- `applyContinueBreakoutFeatures`：缺 `native_coin_price` 时两个 USD 口径字段缺失、**绝不退化成
  写原生币数值**（同字段混两种单位比缺失危险得多）；空数组记 0、整个字段不存在才算缺失。
- `applyBreakout10xFeatures`：信号市值已超历史高点时回调深度**应为负数、不截断成 0**（平台文案
  会截断，这里刻意不跟）。
- `applyWhaleFeatures`：`pastMinute` 是字符串 `"1"` 要转数值；分母缺失时人均次数不写 Infinity。
- `applyKlineVolumeShapeFeatures`：不足 10 根 K 线整组不写入；`kline_is_usd === 0` 时跳过成交额
  类字段但换手率仍可算（代币口径不受计价单位影响）；急拉多尺度扫描取最陡那段。
- `applyHolderStatsFeatures`：**`addr_type === 2`（交易所/流动性池）必须先剔除**，
  `holder_exchange_ratio` 在全体上算、其余画像比例在剔除后的子集上算（分母搞错会系统性稀释
  所有画像比例）；全是交易所地址时真实持有人为 0，只写 exchange_ratio 不写 NaN。
- `applyGmgnTopFeatures`：buy+sell 都为 0 时净买入占比**不写入**（"完全没成交" ≠ "卖压 100%"）。
- `applyMaxUpFeatures`：`max_up_duration` 为 0 时速度不写 Infinity。
- `applySignalTimingFeatures`：**晚于买入时刻的信号必须排除**（未来函数）；三条取值链
  （`s.signal` / `s.ctx.logearn` / `s.ctx`）都要能读到。

**做过变异测试确认这套测试真的会咬**：故意把 `addr_type !== 2` 的剔除去掉、把
`maxUpDur > 0` 的守卫放宽，跑一遍确实红了 3 条（不是那种怎么改都绿的摆设测试），
验证完立刻还原。

### 22.7 验证

`node tests/run-tests.js` **626/626 通过**（595 基线 + 31 条新增，无回归）；`npx vite build`
通过。10 个函数已按字母序加进 `data.js` 底部的 `export { ... }` 列表。

**没有做的验证**：`buildRows` 的端到端等价性只靠"逐字节回比 + 626 个测试（含 parity 系列）"
证明，没有拿真实数据跑一遍改前/改后的 `buildRows` 做输出 diff——仓库里的
`top100_calls.json`/`worst100_calls.json` 只有 calls、没有配套 snapshots，`buildRows` 跑不起来。
考虑到每个块都验证过是逐字节搬移、且循环体里没有残留死变量，风险很低，但如果用户手头有
真实数据，值得点一次「分析」确认字段值跟改动前一致。

---

## 23. 全项目审计修复批次：P0×5 / P1×6 / P2×5（2026-07-29）

### 23.1 这一批是怎么来的、验收基线

来源是一次**只读全量审计**（`src/lib`、`src/ui`、根目录各策略 js、`CLAUDE.md`、`tests`），
产出执行清单 [审计修复计划.md](../审计修复计划.md)（根目录），每条带「问题 / 位置 / 改法 / 验收」。
分三档：**P0 = 已复现的错数/挂死/静默丢数据**（改动小、立即修）；**P1 = 潜伏炸弹、竞态、方法论缺口**；
**P2 = 死代码、文档矛盾、仓库卫生**。

- 测试：**626 → 646 全绿**（只增不减；其中约 15 条是专门守住本轮 bug 的回归线）
- `node tests/lint-strategies.js`：**1 error / 1 warn → 0 / 0**（那条 error 是误报，见 23.4）
- P0 五条**每条都做了「把修复回退掉 → 新测试必须变红」的反向验证**，没有一条是"写完测试就绿"的

**这批里 3 个坑是"第一版改法自己写错、被新测试当场抓出来的"**（23.2 的 worker 判据、
23.2 的 `Number('')`、23.4 的正则字面量）。记在这里是想说明：这轮的测试不是补文档，是真的在干活。

### 23.2 P0：五条已经在出错的

**① AUC 方向常量 `'low'` ≠ `'lower'`，整个邪恶阵营的 CI 被镜像**
（[utils.js](src/lib/utils.js) + [auc.js](src/lib/auc.js)）

项目里存在**两套方向词汇**：`utils` 内部用 `'higher'/'lower'`，而 `auc.js`／UI／持久化的因子池用
`'high'/'low'`。`auc.js` 产出 `'low'` 时点估计按它翻转成 `1-aucHigh`，但 `rankAuc` 里判的是
`direction === 'lower'`，`'low'` 落进 else → **bootstrap 全程按正向算**。于是点估计翻转了、CI 没翻转，
两者永远差一次镜像：所有"值小更好"的字段 CI 落在 0.5 以下，`proAnalytics` 的 `aucVerdict`
把真正有效的因子标成「反向有效」——**文案意思完全相反**。实测 `auc=0.7984 / ci=[0.144,0.269]`，
点估计落在自己的 CI 之外。

`significant`（CI 不跨 0.5）和 `pApprox`（用半宽算）恰好不受影响，因为镜像关于 0.5 对称——
这也是它藏了这么久的原因：最显眼的两个判定列都是对的。

**改法：不统一词汇，在 utils 边界归一**——加 `isLowerDirection(d)` 同时认 `'lower'|'low'`，
`rankAuc`/`computeROC` 都走它，两处调用方一个字没改。**不改词汇是刻意的**：`direction` 会随因子池
存进 localStorage，改词汇会让存量数据的方向整体反转。

**② 两处 worker 缺 `error` 监听 → 扫描永久挂死**（[workerPool.js](src/ui/factorLab/workerPool.js)）

`scanCandidatesWithWorkers` 和 `evaluateCandidatesWithWorkers` 只挂了 `message`（同文件另外两处
是有 `error` 的）。worker 加载失败／OOM／结构化克隆抛错时不会有 message 回包 → `next()` 永不推进 →
Promise **永不 resolve**，UI 永远「扫描中…」；而且 `useFactorScan` 里那个"回退主线程串行"的 catch
**永远进不去**——不是 reject，是 hang。

改法：两处补 `error` 监听（terminate 该 worker、`dead++`、推进收尾），**全部 worker 都异常退出且还有
批次没回包时整体 reject**，让上层 fallback 生效。

> **实现时踩的坑**：第一版判据写的是 `bi < batches.length`——`bi` 是**派发游标**，派发那一刻就已经加过了，
> 于是"派发出去、worker 当场炸了"被误判成"跑完了"，照样 resolve。改成数**实际回包的批次** `doneBatches`
> （成功回包和该批报错都算"有结论"）。这条是新测试当场抓出来的。

**③ 候选导出 TSV 的「CI下/CI上」两列恒为 `-`**（[factorScanExport.js](src/lib/factorScanExport.js)）

写的是 `Array.isArray(c.ci) ? c.ci[0] : '-'`，但 `bootstrapAucCI` 返回的是 `{lo, hi}` **对象**，
`factorLab.js` 原样透传 → `Array.isArray` 永远 false。而这个导出存在的**全部意义**就是补齐 UI
藏起来的「方向 / coverage / **CI**」，结果 CI 从来没有过值。抽 `ciBounds(ci)`，`{lo,hi}` 与 `[lo,hi]` 都认。

**④ 测试盲区：两条测试的 fixture / 取样正好把 ①③ 掩盖住了**

这条单独列出来，因为它比前三条更值得记：
- export 测试的 fixture 写的是 `ci: [0.61, 0.67]`（**数组**），生产是 `{lo,hi}` → `Array.isArray`
  在测试里为真、生产里恒假；而且只断言了表头含 'CI下'/'CI上'，**没有一条检查值**。
- auc 测试的 CI 守门用例三个 seed **全走 `high` 分支**（随机数据 AUC 贴着 0.5）；唯一构造出强 `low`
  方向的用例只断言 `direction` 和 `auc`，**一个字没碰 `ci`**。

两条用例的盲区**正好互补**，所以两个 bug 各自活了很久。改法：fixture 换成生产真实形状 `{lo,hi}` +
补值断言；auc 补 `low` 方向的 CI 包含性断言（强信号、弱信号 n=300 各一条，后者贴近真实候选强度）。

> 教训是**"fixture 的形状要照抄生产"**——这次是 `ci`，下次可能是别的。
> `tests/online-export-coverage.test.js` 那种静态扫描式守门（见 §14.2）值得推广到所有
> "两处必须保持同步"的地方，本轮的 `direction` 常量和 `ci` 数据形状都属于这类。

**⑤ `1.5段策略` 四道 gmgn 风控闸门「缺失即放行」**（[1.5段策略/code.js](../1.5段策略/code.js)）

前10持仓／创建者持仓／内鬼占比／开发团队持仓四个字段全写 `(x ?? 0) * 100`，判定又都是 `< LIMIT`
→ **缺失必然通过**。而 `CLAUDE.md` 写明 gmgn 数据约四成缺失，也就是**约四成的币这四道风控静默全部放行**，
回测里完全看不出来。同文件其它字段用的都是保守默认（`shit_volume ?? 999`、`new_volume ?? 999`）。

改法：抽 `gmgnPct(v)`，**三层兜底缺一不可**，这点是实测出来的：

- `?? 999` 只挡 `undefined`/`null`，挡不住空字符串（`'' ?? 999` 得到 `''`，再 `*100` 就是 0）；
- **`Number('')` 和 `Number(null)` 都等于 0** —— 所以光靠 `Number + isFinite` 一样会被判成"0% 持仓"放行。
  **第一版就是这么写的，跑六种输入的对照表当场露馅**；
- gmgn 这几个字段有时是字符串数字 `'0.154'`，所以也不能直接 `typeof === 'number'` 判。

最终：先显式判 `undefined/null/''` → 999，再 `Number` + `isFinite` → 否则 999。跟 `auc.js` 的
`collectAucSamples` 同一套口径。顺带订正三处 expect 文案（`'20~30'`→`'15~30'`、`'> 60'`→`'< 60'` 方向写反、
创建者持仓写死的 `'<1'` 而常量早就是 `0.5`），四条 expect 一并改成**直接引用常量**，以后不会再飘。

### 23.3 P1：还没炸但会炸的

**⑥ IndexedDB 连接只开不关**（[dataStore.js](src/lib/dataStore.js)）：全文件 7 处 `openDb()`、0 处
`close()`（同目录 `fsStore.js` 是有 close 的，所以不是不知道这个 API）。现在不炸，但 `DB_VER` 一升级，
这些常驻连接会让新页面的 `onupgradeneeded` 被 blocked，而这里没有 `onblocked` 处理——表现就是
**"打不开数据、也不报错"**，极难排查。改成模块内缓存单个 db promise：`onversionchange` 主动让路、
`onclose` 清缓存、**打开失败也要清缓存**（否则一次失败被永久缓存，环境恢复后仍然拿到同一个 rejected promise）。

**⑦ `Math.max(...array)` 三处潜伏 RangeError**（[compare.js](src/lib/compare.js) ×2、
[strategyReplayLogic.js](src/lib/strategyReplayLogic.js) ×1）：同类坑 `factorLab.js` 的
`sweepScoreCutoffs` 已经踩过、修过并写了注释，这三处没同步。约 10 万样本触发。全部改 `reduce`。

**⑧ 扫描／边际ρ 不可取消，旧结果覆盖新结果**（[useFactorScan.js](src/ui/factorLab/useFactorScan.js)）：
底层 `workerPool` 一直支持 `opts.signal`，**但两个调用方都没传**，也没有 runId stale 判定。
扫描要跑几十秒，期间改筛选再点一次 → 先发后到时旧候选表覆盖新的；而紧跟其后的 `setScanThreshold(threshold)`
记的是**回调那一刻的最新阈值**，于是 `staleScan` 判定判不出过期——界面显示一张
**"看起来是新的、其实来自旧数据"的候选表，这比直接报错危险得多**。

改法：两个入口各持一个 AbortController（新调用先 abort 旧的）+ 自增 runId。写 state 前判 stale，
**四个位置都要判**：进度回调（否则旧轮次把新轮次的进度条来回拉）、worker 失败后的兜底串行入口
（已过期就连兜底都不必跑）、结果写入、`finally` 里的 `setBusy(false)`（旧轮次结束时新轮次还在跑，
它把按钮解开就成了"看着已结束、其实还在算"）。

**⑨ held-out 边际ρ 的区间窗口仍挖自全样本** → 见 **§9.1**（已单独成节）。结论：结构性泄漏确实存在，
但纯噪声 40 组对照实测没测出统计显著的偏差（53% vs 50%），**本轮只订正文档措辞、不动实现**，
真要做的做法也记在 §9.1 里了。

**⑩ `verifyParity` 单向自检：review 缺失时无条件判 `ok`**（[onlineExport.js](src/lib/onlineExport.js)）：
原来是 `if (rMiss) return { status: 'ok' }`——**review 侧算不出值时，无论线上算出什么都判「一致」**，
这条方向 100% 漏检。它是有实际代价的：线上派生块在某个 ctx 上算出 review 的 `buildRows` 不会产生的值
（比如两边门槛没对齐，review 因 `MIN_KLINE_BARS_FOR_VOLUME` 这类下限跳过了、线上内联块没跳），
那么因子的满分区间若覆盖到这个值，**线上给分、回测记 0 分**——同一个 cutoff 在两边含义就不同了，
而这套自检存在的全部理由就是防这个。

改法：新增 `missing_review` 状态**单独统计、不并进 `mismatches`**，`OnlineExportPanel` 用黄色
「仅线上有值」Tag 展示。**刻意不让它把报告判红**：review 缺失的原因往往是这条样本本来就没这个字段。
状态抬升有优先级——只在还是 `'ok'` 时抬成 `missing_review`，真问题（mismatch/missing_online/nonnumeric）不能被盖掉。

**⑪ `assignFoldsByToken` 按组轮转不看组大小**（[factorLab.js](src/lib/factorLab.js)）：
`pos % K` 只保证每折拿到差不多**多少个 token**，不管每个 token 带几条信号。meme 场景里这个差别很大——
热门币一天几十条信号、长尾币一两条。某一折可能吃到远超 1/K 的样本，另一折少到被 `heldOutFactorCurve`
的 `test.length < 5` **整折丢掉** → 各 k 的 `nFolds` 不齐 → 1-SE 用的是 `testStd/√nFolds`，
分母不同的两个 k 根本不可比 → **选出的 k\*（推荐因子数）跟着偏**。

改法：LPT 装箱（按组大小降序，每组放进当前累计样本最少的折），只多一次排序，仍然完全确定性。
**排序必须稳定**：先按组大小降序、同大小时按洗牌后的下标——直接对 `groupKeys` 排序会让同大小的组
退回 Map 插入顺序，白费上面那次种子洗牌。倾斜数据实测：`[7,46,7,45,45]` → `[40,40,40,15,15]`。

### 23.4 P2：清理与文档

**⑫ `rebuildFactors` 同时用参数和闭包**（[useFactorScan.js](src/ui/factorLab/useFactorScan.js)）：
`prevMap` 用入参 `prevFactors`、`preserved` 用闭包 `factors`。当前所有调用方传的恰好是同一个对象所以没炸，
但只要有人传一个不同的（比如"从策略导入"想基于另一份池子重建），`preserved` 和 `merged` 就来自两份不同的池子
→ **静默丢因子**。统一用入参。

**⑬⑯ `stripComments` 不认正则字面量 → 抽成共用模块 + 策略 lint 改成剥注释后再跑**
（新增 [stripComments.js](src/lib/stripComments.js)）

这两条是同一个根因，一起说。原来的扫描器在 `onlineExport.js` 里，只认字符串定界符（`' " \``），不认
`/.../` 正则——而 `CLAUDE.md` 明确建议 `off_meta` 这类字段用正则匹配，**策略里出现正则是预期内的**。
两个方向都会错，都实测复现过：

- **多提取**：`/don't/` 里那个单引号让扫描器以为进了字符串，后面的注释就不再被识别 →
  `extractUsedFields` 把**只在注释里出现过的字段**当成真字段 → 生成的上线代码多一个用不上的 const，
  `verifyParity` 还会去自检一个策略里根本不存在的字段。
- **少提取**：`/https:\/\//.test(x) && f('shit_volume') > 0` 末尾那对 `//` 被当成行注释起点，
  **同一行后面的 `f('字段')` 整段被吞** → 上线代码少一个 const，**对应因子恒 null（回测有分、线上没有）**。

改法：按"上一个有意义的字符"判断 `/` 是除号还是正则开头（前一个非空白字符是标识符/数字/`)`/`]` → 除号，
否则 → 正则），再补一张关键字表（`return /re/`、`typeof /re/` 这类）。这是 JS 词法层面本来就无法只靠
局部字符解决的老问题，用的是业界通用启发式；**判断错了也不会崩**——正则不能跨行，扫到换行就收手，
最坏退化成原来的行为。

同一个函数还有第二个用户：`checkStrategySpec`（[strategySpec.js](src/lib/strategySpec.js)）的规则全是正则匹配，
**原来直接跑在带注释的源码上**。于是 `node tests/lint-strategies.js` 唯一的 error 级输出是
`1.5段策略/code-score.js 用了 f('字段') 但没有 f 垫片`——而那个文件里三处 `f('` **全在注释里**，
其中一处恰恰是在说明"本策略不调用 `f('字段')`，所以不需要垫片"。后果有两层：
① 唯一的 error 是假的、退出码 1，挂 CI 就是长红，**人会习惯性忽略真违规**；
② 这条规则是 `fixable`，UI 上点「修正」会**插入一段根本不需要的垫片**。

改法：`checkStrategySpec` 先剥注释再跑规则，`test` 和 `extra` 走**同一份**剥过的副本
（否则会出现"没报违规却列出了细节"这种自相矛盾）。**注意只剥注释、不能连字符串一起剥**——
`f('字段')` 的字段名本身就是字符串字面量。

**⑭ 死代码标注（不删）**：`parseCheckDirection` / `scanCheckThreshold`（[proAnalytics.js](src/lib/proAnalytics.js)）
已无生产调用方（服务的是已下线的"阈值扫描"面板），但都是纯函数、有单测覆盖，**保留并加注释说明状态**，
同时写明"若日后确认不会再用，连同单测和 export 一起删干净——不要留成『代码在、没人调、也没人敢删』"。
顺带清掉一处机械抽取留下的孤儿注释（`// 单行回放。返回 {...}`，它描述的 `runStrategyOnRow` 在别处）
和一段复制了两遍的函数头注释。

**⑮ 仓库卫生**：`.gitignore` 从 1 行补到 18 行（`.DS_Store`、`.claude/`、`review_副本/`、
`root@167.99.73.172/`、手工导出的 `top100_calls.json`/`worst100_calls.json`）。
**只忽略、没有删除任何目录**——删除不可逆，那两个是人工留的备份不是构建产物，等用户自己决定。

**⑰ `强势盘策略/code-score.js` 的 25 字符截断重名**（[强势盘策略/code-score.js](../强势盘策略/code-score.js)）：
`ALL_CHECKS` 里 8 个不同因子的 name 全被截成 `'v_breakout_volume_re'`，而 **review 侧是按 name 聚合的**
（`aggregateScoreStats`）→ 八个因子在统计里被合并成一个，「差此一项 / 依赖此项」全部失真。
25 行 name 改回全字段名。

### 23.5 测试改动清单（626 → 646）

| 文件 | 改动 |
|---|---|
| `tests/worker-pool.test.js` **新增** | 4 条 async：全死→reject、部分死→其余跑完、边际ρ 同上、正常路径不串阵营。用假 Worker 精确控制失败时机 + 2 秒 `Promise.race` 超时兜底（不然失败表现就是测试本身 hang）。**反向验证：摘掉 `error` 监听后 3 条直接 TIMEOUT** |
| `tests/strip-comments.test.js` **新增** | 9 条：剥注释 5 条（含正则带单引号／带转义斜杠／除号不误判／`return`·`typeof` 后是正则）、`extractUsedFields` 2 条端到端、`checkStrategySpec` 2 条（注释里的 `f('x')` 不该报违规、真调用且无垫片仍要报） |
| `tests/auc.test.js` | 原「反向可分」用例补 CI 断言，另加一条弱 `low` 信号用例（n=300，贴近真实候选强度） |
| `tests/factor-scan-export.test.js` | fixture 换成生产真实形状 `{lo,hi}`；3 条断言——CI 两列真填上值、老数组格式向后兼容、`ci:null` 落成 `-` 不抛错 |
| `tests/factorlab-fixes.test.js` | 加「组大小极度倾斜」用例（3 个热门币各 40 条 + 30 个长尾各 1 条）。**原有那条"均衡"用例每个 token 只有 1 条信号，轮转和装箱结果完全一样，测不出区别**——这也是 ⑪ 一直没被发现的原因 |
| `tests/run-tests.js` | 挂上两个新文件；`worker-pool` 走 `await runWorkerPool(testAsync)`（同 §上面记过的教训：async 用例用同步 `test()` 调会被记成"通过"却根本没跑完） |

### 23.6 明确不改的部分（避免下次重复审）

- **`pApprox` 用 CI 半宽反推 p 值**（`auc.js`）：方法上确实是近似（隐含 bootstrap 分布对称正态），
  但它只用于 BH 排序和一个展示用判定列，改成精确检验要引入更重的计算。**记录为已知取舍。**
- **`scoreRow` 的 `opts` / `buildFactors` 的 `opts.shape`**：审计报告把它列成死参数，但代码里有明确注释
  说明是**有意保留的 plumbing**（"真要再加第二种口径，先在 `onlineExport` 里实现对应分支"）——
  属于已记录的取舍，不是遗漏，**不动**。
- §8.7 已自行记录的那批已知未修项（`recommendFactorPath` 用 test 段贪心、两阵营 score 不同量纲、
  两套 train/test 切分口径、`bootstrapAucCI` 共用种子）本轮不动。
- **工程判断做得好、不要动**：`PlotlyChart.jsx` 清监听器、`PerfMonitor.jsx` 的 effect cleanup、
  `onlineExport` 逐字段 parity 自检设计、`scanIntervalCore` 用置换检验对付 look-elsewhere。

### 23.7 收尾：`CLAUDE.md` 的 `volume_ratio` 单位自相矛盾（已订正）

[CLAUDE.md](../CLAUDE.md) 里 `breakout_volume_10x_list.volume_ratio` 的注释断言
"直接当倍数用就行（比如 12.31 表示 12.31x，**对应 content 文案里的 12.31x**）"，
但**同一段** `content` 样本原文写的是「休眠代币突然放量 **12.31%** 至 $5.25K」。两处必有一处是错的。

**先把问题缩小了**：同一条样本里 `current_volume / avg_history_volume = 73.887262466 / 6.001835 = 12.3108`，
跟 `volume_ratio: 12.310779` 逐位对上——**数值语义没有歧义，就是倍数**，拿它做阈值的策略一个都不受影响，
所谓"差 100 倍"的风险不存在。剩下的纯粹是文档措辞。

**用户拍板的改法：只改注释、不断言平台文案。** 注释里删掉"对应 content 文案里的 12.31x"这句断言，
改成写上验算式（让下次看的人自己就能确认口径），并加一行警告：content 文案写的是"12.31%"，
属平台侧措辞，**别照文案解析这个值，以字段数值为准**。这样两处不再互相打架，也不需要去核实平台真实推送。

## 24. 因子推荐黑名单：候选留在表里、但不许算法选（2026-07-29）

**用户的问题**：截图里那条推荐路径第一个是 `holder_sniper_ratio +0.178`，而同一张卡片下面又写着
「精配权后被压到 0（建议删）：`holder_sniper_ratio`」——它在 held-out 上抢到贪心第一名，全样本精配权时
权重又归零。这种字段用户想**不让算法再选它**，但**指标还要继续看**（AUC/边际ρ/区间都有参考价值）。

原有的「移除」（`factorExclusions`）解决不了：它是**扫描前**就把字段从 `scopedFields` 里剔掉，
连 AUC 都不会算，候选表里彻底消失。用户要的是轻一档的判定。

### 24.1 两个开关的分工（别合并成一个）

| | 移除 `factorExclusions` | 拉黑 `factorBlacklist`（新增） |
|---|---|---|
| 生效环节 | 扫描**前**过滤 `scopedFields` | 只在 `recommendFactorPath` 挑候选那一步 |
| 候选表 | 看不见 | **照常显示全部指标** |
| 手动勾选进池 | 不能（已勾的会被取消） | **能** |
| 语义 | 这字段对这阵营根本不该考虑 | 我要继续盯着它，但不许算法替我做主选它 |

两者都按 `camp+field` 记、都持久化到 localStorage（黑名单的 key 是 `chart_factor_blacklist_v1`）——
同一字段完全可能允许当勇者因子、不许当邪恶因子。

### 24.2 实现上唯一的坑：不能在调用方 filter `candidates`

最省事的写法是学 `heroOnly` 那样在 `FactorRecommendCard` 里 `candidates.filter(...)`，**但不行**：
`candidates` 同时还是 `buildWithBase` / `heldOutFactorCurve` **重建因子区间的字典**。从数组里删掉后，
起点池里的同名因子会走 `buildWithBase` 的 `kept` 兜底分支——保留的是**全样本推出来的旧区间**，
而不是在 train 段重推的区间，等于给那个因子开了道轻微的泄漏口子。

所以黑名单走 `opts.blacklist`（`[{camp,field}]`）传进 `recommendFactorPath`，**只在候选池 `pool` 那一步
过滤**，`candidates` 始终全量传下去。副作用正好也是想要的语义：**拉黑不影响起点池**——组合路径模式下
已经在因子池里的因子是用户采信过的，拉黑只挡新增挑选，要踢得去因子池里删。

### 24.3 改动清单

- 新增 [src/lib/factorBlacklist.js](src/lib/factorBlacklist.js)：store（load/save/add/remove/clear/isBlacklisted/sortByRecency/keySet）。
- [src/lib/factorLab.js](src/lib/factorLab.js)：`recommendFactorPath` 收 `opts.blacklist` 并在 `pool` 过滤；
  `recommendFactorPool` 透传。候选被黑名单挡光时，error 从"没有可推荐的候选（先扫描）"换成点明黑名单的措辞——
  否则用户会跑去重扫一遍，还是同一句话。
- [src/ui/factorLab/useFactorScan.js](src/ui/factorLab/useFactorScan.js)：黑名单 state + 持久化 + 三个 handler，
  跟 exclusions 并列。**刻意不取消勾选、不动因子池**（跟 `handleExcludeCandidate` 的区别就在这）。
- [src/ui/FactorLab.jsx](src/ui/FactorLab.jsx)：候选表「移除」旁边加「拉黑 / 已拉黑」按钮（两个 tooltip 讲清差别）。
- [src/ui/factorLab/FactorRecommendCard.jsx](src/ui/factorLab/FactorRecommendCard.jsx)：路径每个 Tag 上加 🚫
  （拉黑并**立刻重算**，`run(mode, blOverride)` 传新清单绕开 setState 异步）；卡片底部常驻黑名单管理条
  （Tag 可逐个解除 + 一键清空）。解除**不**自动重算——批量解除时每次重跑贪心太贵，跟这张卡"手动触发"的
  总基调一致（见文件头那段"自动重算曾经冻住整个页面"的历史）。
- [src/lib/backtestReportExport.js](src/lib/backtestReportExport.js)：`buildRecommendPathReport` 的 meta 收
  `blacklist` 并写进报告头——这份路径是"在排除了这些字段的前提下"选出来的，不写清楚，读报告的人
  （或拿去问 AI 时）会把"某个该上的字段没出现"当成算法 bug 去查。
- [tests/factor-blacklist.test.js](tests/factor-blacklist.test.js)：13 条。除 store 基础外，算法层验了
  **拉黑强信号后它不出现在路径里**、**拉黑另一阵营不影响本阵营**、**全被拉黑时给黑名单专属错误**、
  **黑名单不影响起点池的 baseTestRho**、**不传 blacklist 时结果与改动前逐字段一致**（回归兜底）。

**未做**：贪心仍然是单路径（beam=1），黑名单只是"从候选池里拿掉"，不改搜索结构本身。
"第一步选错、后面全在错误分支上找补"这个根本问题要靠 beam search 或前向-后向 stepwise 解决，另议。

## 25. 修：「只看勇者阵营」勾选后自动重算用的是勾选前的候选范围（2026-07-29）

用户报"点了只看勇者阵营再点算推荐没效果"。

**根因**：`FactorRecommendCard.jsx` 的 `run()` 里 `scopedCandidates` 读的是闭包里的 `heroOnly` state，
而 Checkbox 的 `onChange` 是 `setHeroOnly(...)` 之后**立刻** `run()`——setState 异步，这一次重算拿到的
还是勾选**前**的值，候选范围没变，UI 上就表现为"点了没反应"。

同一个文件里另外两个"改了就立刻重算"的入口都已经绕开了这个坑：`mode` 走 `run(v)`（第 103 行），
黑名单走 `run(mode, blOverride)`（见 24.3）。**只有 `heroOnly` 漏了**——三个入口踩的是同一个 setState
异步问题，修法也该是同一个。

**改法**：`run` 签名加第三个参数 `heroOverride`（默认 `null` = 沿用 state），内部
`const hero = heroOverride == null ? heroOnly : heroOverride;`；Checkbox 的 onChange 改成
`run(mode, null, e.target.checked)`。三个 override 参数现在形状一致。

**注意区分**：勾选后**手动**再点一次「算推荐」本来就是对的（那时已重渲染，闭包里是新值），
所以这个 bug 只影响"勾选那一下"的自动重算。如果手动点了仍看不出差别，那就不是这个 bug——
是这份数据上贪心本来就没选中邪恶候选（路径 Tag 上 `☠`+红色=邪恶、`🛡`+绿色=勇者，
`overfit` 的橙色会盖过阵营色，认图标不认颜色）。

## 26. 因子推荐第二入口：全字段贪心 + beam / 后向剔除 / 单调性闸门（2026-07-29）

用户先问"现在因子推荐怎么做的"，对齐完四段流水线（held-out 贪心选字段 → 全样本精配权 →
影子权重过拟合校验 → K折 k*）后，明确了两件事：

1. **北极星口径不变**——"唯一指标就是北极星指标"，目标函数仍然只有 `spearman(score, returnMax)`。
   分层秩相关那条线（BucketRho，见第 1 节的大回退）**不再走回去**。
2. 四个方案全做：A 全字段入口 / B 单调性闸门 / C Beam search / D 前向-后向 stepwise。

### 26.1 问题：贪心看不到的字段，和贪心看不见的病

- **入口被削两道**：`recommendCandidates` 的上游是 `fieldScope`（一次只扫原字段或组装字段其中一类）
  和 `exclusions`（候选表上手点「移除」的字段，扫描阶段就被 `filterExcluded` 拿掉、压根不进候选池）。
  用户真实数据上这两道削掉了一半以上字段（勇者 179 可用 / 已移除 137）。
- **ρ 对分档形状没有偏好**：用户看十分位表发现"最低两档区分度好、中间七档一片 37%~54% 的平地、
  档6 还比档7 高"，但同一份池子的 ρ=+0.26 看着不错。ρ 是把全部样本一起算的，只要两端拉开，
  中间怎么乱它都给高分。`bucketZigzag`/`🌀N` 一直只是**诊断**，不进任何决策。
- **单路径 + 只加不减**：beam=1 第一步被虚高的 Δρ 带偏，后面全在错误分支上找补（第 24 节末尾
  留的待办）；前向贪心也不会回头删掉被后来者顶替的冗余因子——现在只有精配权时把权重压到 0，
  但因子还留在池里、还占着 K 折 k\* 的计数。

### 26.2 方案A：全字段现挖区间（新文件 `src/lib/fullFieldRecommend.js`）

`scanIntervalsLite(rows, fields, opts)` 对全量字段两阵营各挖一次区间，**跳过 AUC 的 bootstrap CI
（200次重采样）、区间的置换检验（200次重扫）、BH 多重比较校正**——这三样只喂候选表的展示列和
显著性判定，**没有一个进入贪心的决策**（贪心只吃 `{field, camp, interval}`，`autoWeights` 只读
`interval.score`）。单字段成本从"2×200 次重算"降到"2 次窗口扫描"，全量几百个字段才跑得动。

代价写进了 UI 文案：候选的 `interval.pPermutation` 恒为 1、没有 `pAdj`——那是**这个检验根本没做**，
不是"做了且不显著"。要看区间显著性回候选表。

**不绕过**的两道：黑名单（"不许算法选它"是显式意图）和缺失率闸门（数据可靠性问题，不是显著性
门槛——第 102 节那次"算推荐挑进缺失率 95% 字段"的事故就是这么来的）。

#### 26.2.1 修正：exclusions 也不该绕过（2026-07-29 当天回退）

最初版本连同 `fieldScope` 一起把 **exclusions（候选表上手点「移除」的字段）** 也绕过了，理由是
"真实数据上这一项能削掉一半以上的字段"。真实数据上代价立刻兑现：318 个字段挖出 525 个候选
（候选表两阵营加起来才 361 个），被人工否掉的 138/133 个字段全部复活，**贪心第一步就捡回了一个
事后字段** `post_buy_max_drawdown_pct`（`+0.278`，占全路径增量的绝大头）。当时它没进黑名单——
用户以为"从因子池删掉"就等于拉黑了，而那是两个不同环节（见 `factorBlacklist.js` 文件头）。

那次结果还留了个反直觉的诊断样本：过拟合校验显示 `train ρ=+0.243` 而 `held-out test ρ=+0.325`，
**test 比 train 还高**。UI 据此报"没有明显塌陷"，但这恰恰是事后字段对结果近乎确定性映射的表现——
以后见到 test 显著高于 train，第一反应该是查泄漏，不是庆祝稳健。

改法：`fields` 参数改收 `{ hero, evil }` 两份名单（`normalizeCampFields` 归一，传数组仍是老口径
两阵营共用），各阵营只挖自己名单里的字段。**分阵营而不是取交集**——exclusions 按 `camp+field` 记，
同一字段完全可能"允许当勇者、不许当邪恶"。上层 `FactorLab.jsx` 的 `campScanFields` 用
`filterExcluded(fields, exclusions, camp)` 算两份，同时喂给全字段贪心和方案擂台。

于是**只剩 `fieldScope` 一道被绕过**：候选表一次只扫"原字段"或"组装字段"其中一类，那是扫描成本
导致的分批，不代表任何人的判断，绕过是纯收益。换句话说，两种候选池的差异现在**只剩跨类字段**这一项。

### 26.3 方案 B/C/D：`recommendFactorPath` 的三个 opts，默认值 = 改动前的行为

```
beamWidth = 1      >1 时保留多条最优前缀（C）
backward = false   每步回头试删已选因子（D）
monotoneGate = false  拒绝会增加 held-out 分档倒挂的候选（B）
gateTopK = 20      闸门只检查排名前 K 个候选
```

**做成开关而不是替换**：原来那条"单路径、只加不减、不看分档"的搜索仍是默认入口「因子推荐」在用的，
不能被顺手改掉。`tests/full-field-recommend.test.js` 有两条等价性回归专门守着——不传参数、和显式
`beamWidth:1/backward:false/monotoneGate:false`，路径逐字段、逐 `deltaTest`、逐 `baseTestRho` 一致。

三处口径细节：

- **跨 beam 比较必须用 `testRho` 绝对值，不能用 `deltaTest`**——不同 beam 的基线不同，一条差路径上
  的大增量不代表比好路径上的小增量更优。`beamWidth=1` 时同一基线下两者等价，且 `Array#sort` 稳定、
  平局保留 pool 顺序，与改动前 `deltaTest > best.deltaTest`（严格大于、平局取先出现的）逐字节一致。
- **单调性闸门只是准入约束，`ρ` 仍是唯一被优化的量**。全被拦下时**停止**而不是绕过闸门
  （偷偷放行等于闸门形同虚设），走专属 `stopReason:'monotoneGate'` 和专属文案——它跟"没有候选能
  提升 ρ"是两回事，用户该做的是关闸门/放宽 `gateTopK`，不是跑去降阈值攒数据。
- **后向剔除单遍扫描不迭代到收敛**，删除条件是 `r >= testRho`（ρ 打平时优先要少的那个，但不接受
  任何下降）；至少留 2 个因子。反复扫描容易在等值解之间来回震荡。

### 26.4 首版 beam 实现的一个真 bug（测试抓到的）

每步 `beams = nextBeams` 时，一条"这一步没有任何合法扩展"（候选都不够 `minGain`，或都被闸门拦下）
而走到顶的 beam 会被**直接丢掉**——而它可能正是全局最优解。实测 `beam=4` 反而比 `beam=1` 差
（ρ 0.846 vs 0.941），违反 beam search 最基本的性质。

**修法**：跨步维护历史最优 `bestBeam`，每条 beam 落地时 `consider(beam)`。`beamWidth=1` 时 `testRho`
逐步单调不降（每步要求 `deltaTest > minGain > 0`，`backward` 也只在 ρ 不降时才删），取历史最优
≡ 取最后一条，与原行为一致。测试 `beamWidth>1: 最终 held-out ρ 不劣于单路径贪心` 常驻守着这条性质。

### 26.5 改动清单

- 新增 [src/lib/fullFieldRecommend.js](src/lib/fullFieldRecommend.js)：`scanIntervalsLite` + `recommendFromAllFields`。
- [src/lib/factorLab.js](src/lib/factorLab.js)：`recommendFactorPath` 的循环重写成 beam 结构
  （单 beam 时逐字节等价）+ 内部函数 `shrinkBeam`；`bucketsOn` 从"只给选中项算诊断"提升成
  闸门与诊断共用；`recommendFactorPool` 透传四个 opts、返回值加 `stopReason` 和 `search`
  （报告里要能看出这条路径是 beam=5 搜的还是单路径贪的）。
- [src/ui/factorLab/recommendWorker.js](src/ui/factorLab/recommendWorker.js)：新增 `type:'recommendAll'`
  分支（收 fields 而不是 candidates，扫描在 worker 内做完）+ 按整百分比节流的 `progress` 消息。
  **Node 镜像 `recommendWorkerNode.js` 不用跟**：它只服务 `eval` 一种消息，`runRecommendInWorker`
  是浏览器专用路径。
- [src/ui/factorLab/workerPool.js](src/ui/factorLab/workerPool.js)：`runRecommendInWorker` 加 `onProgress`。
  **`progress` 必须在 `cleanup()` 之前拦掉**，否则会掉进下面的 `else` 被当成 error 直接 reject、
  顺手 terminate worker——整个任务在第一个进度回报时就死了。
- 新增 [src/ui/factorLab/FullFieldRecommendCard.jsx](src/ui/factorLab/FullFieldRecommendCard.jsx)：
  跟「因子推荐」并列的第二张卡，**上面那张一行未动**。三个增强在这里默认**开**（beam=3 + 后向剔除
  + 单调性闸门）——lib 的默认要守历史行为，这张新卡没有历史包袱。不要求先点「扫描」，它自己扫。
- [src/ui/FactorLab.jsx](src/ui/FactorLab.jsx)：import + 渲染新卡（传全量 `fields`，不是 `scopedFields`）。
- [tests/full-field-recommend.test.js](tests/full-field-recommend.test.js)：14 条。含两条等价性回归、
  beam 不劣于单路径、后向剔除不加长路径且 ρ 不降、闸门专属 stopReason、`AUC_TARGET_FIELDS` 排除、
  `permB=0` 后 `pPermutation` 是占位值。

### 26.6 验证与未做

659 → **673 个测试全通过**；`vite build` 通过（worker bundle 正常产出）；dev server 页面加载无新报错。
**端到端没跑通**：加载数据要走原生文件选择对话框，这个环境驱动不了（跟第 101/102/104 节同样的限制）——
建议用户首次点「全字段搜索」时留意三件事：进度条是否推进、扫出的候选数是否远多于候选表、
以及 beam>1 时耗时是否可接受（成本约 ×beamWidth）。

### 26.7 追加：方案擂台（同一页纵向对比，2026-07-29）

两张卡各跑各的，跨卡比要人肉记数字——用户要求"纵向列出来一目了然"。新增
`compareRecommendPlans`（lib）+ [PlanArenaCard.jsx](src/ui/factorLab/PlanArenaCard.jsx)：
5 种「候选池 × 搜索策略」组合（候选表/全字段 × 单路径/beam3+后向+闸门/beam5+后向）同场跑完，
一张表纵向摆开，看中哪行直接「采用」哪行。

**排名口径**（这是这张表唯一需要想清楚的事）：主键是 **K折曲线在 k\* 处的 test ρ**，不是
"精配权后的全样本 ρ"。后者在全样本上配权、又在全样本上打分，**方案越激进（池子越大、beam 越宽）
它越虚高**，拿它排名等于奖励过拟合；k\* 处的 K折 test ρ 是这几个数里唯一"每折重推边界+重配权、
按 token 分组分折、还砍掉了过拟合尾巴"的，跨方案可比。次选影子权重 `rhoTest`（单次切分、方差大）。
UI 上「全样本 ρ」那一列刻意置灰 + tooltip 写明"不要拿这个排名"。

**全字段扫描只做一次**，三个 full 方案共用（它是这里最贵的一步）。有测试用**对象引用相等**守着
——换成深比较就看不出"扫了两次但结果一样"。单个方案报错不带崩整张表（各自 try/catch，
错误信息落在该行）。worker 侧新增 `type:'comparePlans'`，进度按【方案】回报而不是按字段。

**未做**：① `buildRecommendPathReport` 还没把 `search` 配置写进导出报告的 meta（现在只有默认入口的
结果会被导出，那张卡三个开关全关、写不写没区别；全字段卡的结果尚未接进「导出完整报告」）；
② 单调性闸门用的是"倒挂处数不增加"这个粗判据，没有考虑倒挂的**幅度**（`worstDrop` 已经算出来了
但没用上）；③ 贪心仍然只在一个固定的 70/30 切分上做选择决策，K 折只在事后定因子数。

## 27. 报告补全：北极星无条件出 + 同分饱和度 + 候选表导出注明过滤（2026-07-29）

起因是连续两轮拿导出报告做诊断，都卡在同一批"报告里根本没有的数字"上。补的是数据缺口，
不是格式，三处：

### 27.1 第 4 节：北极星 ρ 不再依赖按钮

第 4 节原来只在跑过「ρ最优配权」/「分层增益配权」/「分层秩相关配权」之后才有内容，三个都没点
就是三行"未跑"。问题在于这三个报的都是**优化之后能到多少**，而"**当前这套权重此刻是多少**"
从来没被写进过报告——诊断时只能拿 lift@cutoff 反推，而 lift 是绑 cutoff 的、跟北极星不是一回事。

北极星本身不依赖任何按钮，它就是 `rows + factors` 的函数。现在 `scorePoolRho`（从 factorLab.js
导出，跟 `optimizeWeightsForRho` 同一份实现，避免第二套口径漂移）在 FactorLab 里无条件算，
第 4 节第一行固定输出。三行"未跑"照旧保留——"没优化过"这件事本身也是诊断信息，不能被顶掉。

### 27.2 第 4 节：同分饱和度

"一批样本分数完全相同、内部无法排序"这个问题真实数据上连着出现两次（344/688 = 50%，
145/728 = 20%），两次都恰好是第 7 节命中率塌陷的那几段。但报告里从来没有这个数字——只能靠
人眼在分段表里数"哪几段的分数区间一模一样"（`-0.6~-0.6`、`0.1~0.1`）。

现在直接给：最大同分块的样本数 / 占比 / 全样本不同分值个数，占比 ≥10% 加警告。
第 10 节诊断清单第 3 条跟着改写，并区分了两种饱和——**顶部**饱和加邪恶因子拉开，**中部**饱和
是那批样本在所有因子上都落同一档，得换维度不同的因子，调权重没用。

浮点分数按 `toFixed(4)` 归组，避免 `0.1` 和 `0.10000000001` 被算成两档。

### 27.3 候选表导出：抬头注明这是过滤后的子集

导出的候选表走的是 `filteredHeroCandidates/filteredEvilCandidates`（即候选表上关键词、缺失率≤、
边际ρ(test)≥ 三道过滤之后的行），但 meta 只写了阈值/样本数/字段范围。真实后果：一份 28 行的
导出被当成全部候选来选品，实际可用是 361 个——**选品是在不到 8% 的字段里做的，而读报告的人
无从知道**。现在抬头第二行固定写「导出 N 行 / 扫描出 M 个可用候选 · 生效过滤：…」。

### 27.4 仍然补不了的（必须点按钮）

- **第 8 节时间外推**、**滚动验证报告**：要跑 `runWalkForwardBacktest`，异步且贵，纯格式化函数里
  变不出来。没跑就是没跑。
- **三种配权**：同上，`optimizeWeightsForRho` 是搜索过程。
- **候选表的边际ρ(test)**：这一列本身要 held-out 重算，全字段贪心为了跑得动才特意跳过它
  （见 26.2），报告侧补不了。

## 28. 修：上线映射告警对 `chip_analysis.*` 恒误报（2026-07-29）

现象：因子池里有 `chip_analysis.current_mcap` 时，页面常驻告警

> ⚠️ 有 1 个因子映射不回原始 ctx，上线后取不到值：chip_analysis.current_mcap
> 它们在实盘会恒判"缺失"记 0 分，但权重仍留在分母里……要么把它们删掉后重新点「推荐阈值」，
> 要么在实盘侧自己复刻这几个字段的计算逻辑。

**这条是误报**，而且后果不轻：它建议用户删因子或重定 cutoff，实际上该字段上线取值毫无问题。

根因在 `classifyFieldOrigin`：

```js
if (field.startsWith('holder_') || field.startsWith('chip_analysis.')) {   // ← 一刀切
  return { original: false, reason: '持仓/筹码聚合字段，原始 ctx 中不存在' };
}
```

`resolveCtxAccessor` 第一行就是 `if (!origin.original) return {ok:false}`，所以**探测逻辑根本没跑**
——不是"探测过、ctx 里找不到"，是"按前缀直接短路"。

但 ctx 里 `chip_analysis` 本身就是平台给的一个块，`current_mcap` / `above_percent` /
`below_percent` / `total_holding_percent` / `inner_sell_ratio` / `inner_address_holding` /
`inner_holding_address_count` 这些标量**原样存在**，buildRows 只是 `flattenObject` 展开了一层。
`current_mcap` 更直白——它就是 `ctx.logearn.mcap` 的副本，[data.js](src/lib/data.js) 的
`CHIP_FIELD_EXCLUDE` 处早就写明了这一点。

改法：前缀规则里只留 `holder_*`（那些确实是从 `ctx.holders` 数组聚合出来的，没有对应标量），
`chip_analysis.*` 交给 `resolveCtxAccessor` 的**数值探测**判定——对得上就是 direct，对不上给
"原始 ctx 中找不到与该字段数值一致的路径"，那是核对过的结论。

**为什么不怕放开之后误判**：`chip_analysis` 里真正从数组算出来的那 5 个
（`above_below_ratio` / `price_to_peak_ratio` / `price_concentration_hhi` / `top5_hold_percent` /
`top5_transfer_in_ratio`）都在 `DERIVED_KEYS` 里，被上一道 `isAssembledField` 拦住，轮不到前缀规则。

教训：**"这个字段能不能上线"是可以用数据核对的（探测 30 行、逐行比数值），
就不该用字段名前缀去猜。** 前缀规则只该留给"物理上不可能存在对应路径"的那一类。

## 29. 内盘毕业哨兵值：0 不是测量值（2026-07-29）

### 29.1 怎么发现的

728 样本那轮的候选表里，这四个字段的邪恶集中区间，区间 n 全部落在 219~221（选择率 30%）：

| 字段 | 邪恶集中区间 | 区间n |
| --- | --- | --- |
| `launch_time_duration` | [33.9, ∞) | 219 |
| `chip_analysis.inner_sell_ratio` | [22.35, ∞) | 219 |
| `chip_analysis.inner_address_holding` | [1.66, ∞) | 219 |
| `chip_analysis.inner_holding_address_count` | [9, ∞) | 221 |

而这四个恰好就是平台文档里写明「**未毕业时固定为 0**」的全部字段。也就是说 728 个样本里只有
约 219 个（30%）真正毕业，剩下 509 个在这四个字段上全是哨兵 0。

**区间挖掘其实已经"发现"了这条分界线**——它在四个字段上各自独立地把边界切在了同一批样本上。
它挖到的根本不是这些字段的数值规律，是「毕业/未毕业」这个二分类，只不过被伪装成了四个连续量。

代价在勇者侧更直接：`launch_time_duration` 的核心区被推成 `[-∞, 45.5]`，把 509 个哨兵 0 和
"45 秒内闪电毕业"混在一起给满分，权重 37.2（池子里第二大）——也是「136 个样本卡在 63.8 分」
那个同分块的主因，以及分段表里段2（33~47 分）高倍率 16.4% 反常高于段3~段8 的成因之一。

还有一层隐性伤害：这四个字段的**缺失率显示 0%**，是哨兵值伪装出来的。真实定义域只有 30%
的样本，却因为"没有缺失"而一路畅通地穿过候选表的缺失率过滤和全字段贪心的缺失率闸门。

### 29.2 改法：把哨兵从数值轴上拿走，不是调梯形边界

`data.js` 新增 `applyGraduationFeatures(features)`，两件事缺一不可：

1. **未毕业时删掉这四个数值字段** → 缺失率如实反映真实定义域（会跳到 ~70%）；
2. **加 `is_graduated` 哑变量** → 「未毕业」这条信息单独保留下来，自己去因子池里竞争。

只做①会把这条信息整个丢掉（未毕业 = 更早期，很可能真有预测力）；只做②则哨兵 0 还在轴上，
照样被区间挖掘拟合。

毕业判定优先看 `launch_time > 0`，`launch_time_duration > 0` 作旁证兜住脏数据，避免把真毕业的
盘误删成缺失。

**为什么不改梯形边界**：区间挖掘是数据驱动的，把 `lo0` 抬到 0 以上只治标——下次重新推导时
看到那堆 0 对应着不差的命中率，边界还会被拉回去。

### 29.3 上线口径必须跟着改，否则是静默的 parity 破裂

这四个是 **ctx 原生字段**，`resolveCtxAccessor` 本来会把它们判成 direct、在上线代码里内联
`ctx.logearn.launch_time_duration` 这样的路径。那样线上未毕业的盘会拿到 **0（落进核心区算满分）**，
而 review 侧是缺失——回测再准也没用，两边根本不是同一个策略。

所以：

- 四个字段 + `is_graduated` 一起登记进 `DERIVED_KEYS`（它们的口径已经跟原始 ctx 不同了，
  判成"组装字段"是准确的，不是权宜之计）；
- `onlineExport.js` 新增 `graduation` 块，同一套哨兵规则：未毕业时**不写**这几个键 = 取值 null
  = 记缺失。

有一条 `verifyParity` 测试真的跑生成出来的上线代码、逐行比对 review 值，守着这个口径。

### 29.4 预期的连锁反应（改完重新分析一次数据才看得到）

- `launch_time_duration` 缺失率 0% → ~70%，会被「缺失率≤10%」过滤和缺失率闸门挡在门外，
  **自动退出因子池**，37.2 的权重空出来，由 `is_graduated`（0% 缺失）去竞争；
- 同分饱和的 136 块应该散开（70% 样本不再共享同一个满分项）；
- 段2 那个 16.4% 的反常大概率减弱或消失；
- **ρ 往哪边走不好说**：如果"未毕业"本来就是真信号，`is_graduated` 会接住；如果 ρ 明显掉，
  那说明现在这 0.232 有一部分是哨兵值撑起来的假象——那也是必须知道的事实。

### 29.5 同类风险，尚未处理

`buy_max_retracement` 是同一类（dictionary 写明「无数据为 0」，data.js 里
`let maxRetracement = 0` 起手）。区别是它的"无信号"和"真实回撤 0%"更难分辨，先不动。

**更该做的是一条常驻体检**：扫 dictionary 里描述含「没有…为 0 / 还没…则为 0 / 无数据为 0」
的字段并列出来。不然下次又会有新字段悄悄带着哨兵值进因子池，而且——像这次一样——伪装成
0% 缺失率一路畅通。

---

## 30. 修：walk-forward 的 cutoff 一直是失效的（2026-07-29）

用户看导出报告时提的疑点：第 8 节和整份 walk-forward 报告里，**训练段触发数几乎等于训练段
全部样本**（`679/681`、`638/638`…），所有段 lift 恒等于 `1.00`。但同一套参数在第 5 节全样本下
cutoff=-58 只触发 `395/728`。

### 30.1 根因：每段重新配了权，cutoff 却还是外面那个

```
FactorLab.jsx  runWalkForwardBacktest(rows, fieldSpecs, ...)   ← 只传字段名+阵营，不传权重
  └ factorLab.js  backtestOneSplit(train, test, ...)
      ├ scanFactorCandidates(train, ...)          ← 区间在 train 上重挖（这步一直是对的）
      └ buildFactors(train, candidates, ...)
            └ return { factors: autoWeights(factors) }   ← 权重被覆盖成 interval.score 比例分配
```

`buildFactors` 结尾无条件走 `autoWeights`，所以因子池里手调的权重（`chip_analysis.current_mcap`
= 67.2、`kline_volume_cv` = 3.8 那一套）在 walk-forward 里**一次都没被用过**。
然后 `FactorLab.jsx` 拿页面上那个全样本 `cutoff` 直接 `sweepAt(f.train, cutoff)`——套在另一个
权重体系产生的分数上，分数分布整体平移，阈值落到了几乎所有样本下面。

**合成数据复现**（600 条、3 个弱因子 AUC≈0.55，手调配比按真实池子同构设成 20.9 : 70 : 9.1）：

```
因子池 cutoff=-58        → 触发 253/600 (42.2%) lift=1.05
同一个 cutoff 套到各段    → train 396/420(94%) / 452/480(94%) / 494/540(91%)，lift 全塌成 1.0x
```

真实池子权重更极端（单因子 67.2），所以直接到 ~100%。

### 30.2 这意味着什么

1. 第 8 节 + 整份 walk-forward 报告**此前零信息量**。那些"命中率(train/test)"列全是两段各自的
   **基准高倍率**——"11.3% vs 6.4%"讲的是那天行情本身高倍盘少，跟因子池无关。
2. `> 落差小，泛化较好` 那行是**主动误导**：lift 恒 1.00 → 落差必然 0.00 → 永远输出这句。
3. 第 3 节逐因子 AUC 归因**不受影响**（`aucForField` 单字段独立算，没走打分链路），可以继续信。

### 30.3 改法

**A. cutoff 每段自己在训练段上定**（`backtestOneSplit`）。walk-forward 的语义本来就是"一切都在
train 上定"，cutoff 也不例外——调 `recommendCutoff(trainBt.sweep)`（净超额命中数最大，自带
minN 保护），返回 `cutoff` + `cutoffSource`（`'train'` / `'fallback'` / `'fixed'`）。
定不出来（该段训练集太薄）时退回调用方传的 cutoff 并标 `fallback`，报告里显示 `⚠兜底`。
`opts.cutoffMode:'fixed'` 保留旧行为当逃生口。

**B. `opts.keepWeights`**：只让训练段重挖区间、权重沿用因子池那一套（`fieldSpecs[].weight`），
把"配权变了"这个变量摘掉，单独检验区间是不是过拟合。`scoreRow` 是按 Σ权重 归一的，所以沿用
原始权重就精确复现了因子池的分数尺度，不需要另外缩放。要么全部贴回、要么整体退回自动配权
（`weightSource: 'pool' | 'auto' | 'auto-fallback'`）——只贴回一部分会造出一套既不是池子也不是
自动的混合尺度，比两者都难解释。UI 上是「沿用因子池权重」勾选框，默认关。

**C. 失效护栏** `assessCutoffInert(point, size, maxFrac=0.95)`：训练段触发率 ≥95% 就是阈值没在
筛任何东西。页面和导出报告共用这一份判定（沿用本仓库"两处永远读同一份计算结果"的约定）：

- 表格「衰减判定」列 → `阈值失效，判定无意义`（**不再输出"未衰减"**）；
- 第 2 节标题 → `其中 N 段阈值失效不计入`，显著性计数把失效段排除；
- 第 8 节 → 换成 `⚠️ 本节无效`，不再打"泛化较好"；
- 诊断清单新增第 0 条：先剔掉失效段和 `⚠兜底` 段再往下判断。

顺带订正一处文档错：`backtestReportExport.js` 写"总分 = Σ(±权重×命中度)/**Σ正权重** ×100"，
实际 `scoreRow` 的 `wsum` 累加的是**全部权重**（含邪恶）；因权重恒归一到 100，实际除数就是 100。

### 30.4 修复效果（同一份合成样本）

```
【修前】各段套全样本 cutoff=-58
  #1 train 396/420(94%) lift=1.04 | test 57/60 lift=0.98  → 未衰减
  #2 train 452/480(94%) lift=1.03 | test 51/60 lift=1.03  → 未衰减
  #3 train 494/540(91%) lift=1.03 | test 57/60 lift=1.05  → 未衰减

【修后】每段自己在训练段上定
  #1 cutoff=-54 train 383/420 lift=1.05 | test 56/60 lift=0.99  → 未衰减
  #2 cutoff=-50 train 425/480 lift=1.04 | test 49/60 lift=1.07  → 未衰减
  #3 cutoff=-32 train 167/540 lift=1.18 | test 18/60 lift=0.33  → 略降未达显著
```

第 3 段终于测出了东西——修前三段一律"未衰减"是假象。

### 30.5 边界与遗留

- `recommendCutoff` 的目标是**净超额命中数最大**（触发数 × 超额命中率），因子弱时它天然偏向
  宽松阈值：上面修后 #1/#2 训练触发率仍有 91%/89%，只是没到 95% 的失效线。这是既有函数的
  既定语义，这次没动；95% 只兜住完全退化的情形。真要收紧得改 `recommendCutoff` 的 `minFrac`
  或换目标函数，那是另一件事。
- **没能在浏览器里端到端验证**：因子实验室要先加载真实数据才出 tab，这个环境驱动不了原生
  文件选择框。页面本身加载无新报错（只有既有的 antd `Space direction` 弃用警告）；改动的正确性
  靠 Node 侧验证——合成样本复现+修复对照、真实 fold 形状喂进 `buildWalkForwardReport` 端到端
  渲染确认。建议实测时留意「该段cutoff」列和失效告警是否符合预期。
- 单测：`factorlab.test.js` +7（每段 cutoff 落在训练网格内、该段 cutoff 在训练段真的筛掉东西且
  lift>1、`cutoffMode=fixed`、keepWeights 三态、`assessCutoffInert` 边界），
  `backtest-report-export.test.js` +6（cutoff 列与来源、失效段判定换成无意义、无失效段不凭空报警、
  第 8 节失效不输出"泛化较好"、旧版 oos 无 cutoff 字段时退回全样本 cutoff 且不报警）。
  全量 **709 个测试通过**。

## 31. 常数因子闸门：拦掉"梯形退化成人人同分"的因子（2026-07-29）

### 31.1 起因：一个在报告里完全隐形的空转因子

用户拿 >3x 那轮的完整诊断报告来问"这批因子有没有业务意义"。逐个核对因子池时，把
`shit_volume`（邪恶，权重 8.1）的四个梯形边界代进 `trapScore` 实跑了一遍：

```
shit_volume(邪恶) lo0=-0.3492 lo1=0 hi1=∞ hi0=∞
  取值 0→1.00  0.5→1.00  1.2→1.00  5→1.00  30→1.00  80→1.00
```

`shit_volume` 是垃圾钱包持仓占比，恒 ≥0（只有超过 24 小时的老币才可能为负，见 CLAUDE.md），
于是 724/728 个样本的命中度全是 1.00，剩下 4 个是缺失记 0 —— **每个样本一律扣同样的 8.1 分**。

它对排序的贡献是**严格的 0**：`scoreRow` 里每个样本加的都是同一个 −8.1，秩序完全不变，
北极星 `spearman(score, returnMax)` 一分不动。上一轮 >5x 的因子池里它也在（权重 8.4，
一模一样的边界），两轮都没被任何一处指标看出来 —— 它有 AUC（0.530）、有区间、有权重、
有缺失率，在因子表和导出报告里跟正常因子长得**完全一样**。

### 31.2 它不是"无害的 0"

`scoreRow` 按 **Σ全部权重** 归一（`wsum += f.weight`，不分阵营），所以常数因子的权重照样
进分母，把其它因子的有效权重**按比例稀释掉**。测试里量化了这件事：一个满命中样本单因子
拿 100 分，并入一个等权的常数因子后变成 `(10−10)/20×100 = 0` —— 分数尺度整体平移，
**旧 cutoff 不能直接沿用**。

除了稀释分母，它还占着 K 折 `k*` 的因子数计数、占着「去冗余」表的一行、上线代码里也会
照样生成一段永远走同一分支的判断。

### 31.3 为什么会推出这种梯形（不是偶发）

两个条件凑齐才会退化，缺一不可：

1. **零值堆积** —— `deriveTrapezoidCore` 拿"区间内目标类取值的 P25"当满分核起点 `lo1`，
   目标类有 75% 都压在 0 上时 `lo1=0`；
2. **单边开区间** —— 区间是 `[0, ∞)` 这种形状时 `hi1=hi0=∞`。

于是任何 ≥0 的取值都落进 `[lo1, hi1]` 拿满分。而条件 2 正是上游口径在小样本下的**必然产物**：
`scanIntervalCore` 的 `score=(wilsonLo/base)×√coverage` 在正类样本少时系统性偏好"几乎全收"的
宽窗（这次实测：n=728/pos=80 时，一个 lift=1.06、coverage=95% 的宽窗打得过 lift=1.5 和
lift=2.0 的真区间，要正类 ~1000 才反转）。所以这不是偶发，必须在建因子这一步拦住。

光靠"字段恒 ≥0"是推不出退化梯形的（P25 会落在一个正数上，梯形照样有区分度）——
测试 fixture 一开始就踩了这个坑，手写的退化梯形 `deriveTrapezoid` 复现不出来，
改成"~86% 取值为 0 + 单边开区间"才真实重现。

### 31.4 改法

**判据用"众数命中度的占比"而不是"方差为 0"**：缺失样本会拿到 0 分，把严格方差撑起来，
上面那个 724 个 1.00 + 4 个 0.00 的因子在方差判据下**测不出来**。

- [factorLab.js](src/lib/factorLab.js) 新增 `factorHitProfile(rows, factor)` →
  `{ n, modalHit, modalShare, distinct }`，命中度按 1e-6 归桶数众数。
- **硬闸 `DEGENERATE_HIT_SHARE = 0.99`**：`buildFactors` 里在梯形推导之后加一道检查，
  `modalShare ≥ 0.99` 直接不收，理由进 `skipped`（带 camp）。定在 99% 而不是更松，是因为
  这道闸是**自动丢弃**，宁可漏放不能误杀 —— 一个只对 5% 样本有区分的因子确实很弱，但它至少
  还在区分，该由人看着 UI 提醒去删。n 小时这个阈值也天然保守：n≤100 时只有"一个不差全同分"
  才会被拦，所以既有 709 条测试**一条没动就全过**。
- **软线 `NEAR_DEGENERATE_HIT_SHARE = 0.90`** + `findDegenerateFactors(rows, factors, minShare)`：
  给**已经在池子里**的因子体检。硬闸只管新建的，从策略导入的、换过字段范围保留下来的、
  以及这道闸上线之前就已经在池子里的，都不走 `buildFactors`，得有一条常驻提醒。
- `opts.degenerateGate:false` / `opts.degenerateShare` 可关可调，只为排查用（想看看被拦掉的
  长什么样），正常路径都该开着。
- [FactorLab.jsx](src/ui/FactorLab.jsx)：因子表上方新增常驻告警（挨着「映射不回 ctx」那条），
  列出每个因子的 `modalShare`/`modalHit`/权重，标明"确定零贡献"还是"只对不到一成样本说话"，
  每行带 ✕ 直接删，并提示删完要重新点「推荐阈值」（分数尺度会变）。

**起点池不受影响**：`buildWithBase` 对"从本次 candidates 重建不出来"的基座因子会原样保留
（`kept`），所以硬闸不会把用户已采信的因子静默删掉 —— 那是 UI 提醒的职责，不是算法的。

### 31.5 验证

- 新增 [tests/factor-degenerate.test.js](tests/factor-degenerate.test.js) **14 条**：`factorHitProfile`
  三态（人人满命中 / 有区分度 / 缺失掩盖退化）、**常数因子对 ρ 的贡献严格为 0**、
  **稀释分母的量化**（满分样本 100→0）、`buildFactors` 拦截+理由+混合池只丢一个+开关+阈值可调、
  `findDegenerateFactors` 的排序/软硬线区分/空输入兜底。
- 709 → **723 个测试全通过**（既有 709 条一条未改）。`vite build` 通过。
- **端到端没跑通**：因子池那张卡要先通过原生文件对话框加载数据才可达（跟第 26.6 节同一个限制），
  dev server 页面加载无新报错。建议用户下次打开因子池时留意这条新告警是否出现在 `shit_volume` 上。

### 31.6 顺带记一笔：报告里的分数公式文案是错的

[backtestReportExport.js:65](src/lib/backtestReportExport.js:65) 写的是
`总分 = Σ(±权重×命中度)/Σ正权重 ×100`，但 `scoreRow` 归一的是 **Σ全部权重**。
[FactorLab.jsx](src/ui/FactorLab.jsx) 里"权重合计"的措辞才是对的。用户那份池子 8 个邪恶因子，
两种口径差出快 3 倍 —— 会让人误判分数尺度。**本次未改**（改文案要同步改导出快照测试的期望值，
留待下次一并处理）。

## 32. `Σ正权重` 不是文案笔误：review 与实盘的归一化分母真的不同（2026-07-29）

### 32.1 起因

第 31 节收尾时记了一笔"报告里的分数公式文案写错了"，本来以为是纯文档订正（第 30.3 节也这么
判过一次：*"因权重恒归一到 100，实际除数就是 100"*）。真去改的时候顺手核对了策略侧，发现
**两边的分母确实不是同一个东西**。

| | 分子 | 分母 | 出处 |
| --- | --- | --- | --- |
| review | `Σ(±w·s)`，邪恶的负号在 `s` 上、`w` 恒非负 | **`Σ全部权重`**（`wsum += f.weight`） | [factorLab.js](src/lib/factorLab.js) `scoreRow` |
| 实盘策略 | `Σ(s·w)`，邪恶的 `w` **本身是负数** | **`Σ正权重`**（`wsum += Math.max(0, weight)`） | `策略模板/strategy-template.js`、`强势盘策略/code-score.js` |

`campLibrary.js` 的 `buildAllChecksRow` 里 `const w = camp === 'evil' ? -Math.abs(weight) : ...`
——「发送到策略」写出去的邪恶因子权重就是负数，到了策略侧被 `Math.max(0, weight)` 夹成 0，
**分母里只剩勇者那一半**。

两边分子完全一致，分母差一个正的常数倍。所以这是一个**纯正数缩放**。

### 32.2 影响范围：只有 cutoff，但恰恰是决定买什么的那个数

- **不受影响**：`spearman(score, returnMax)`（北极星）、十分位形状、AUC、lift 曲线的形状、
  所有排序类结论 —— 正数缩放不改变秩序。**前面所有找因子的结论一个都不用推翻。**
- **受影响**：cutoff 的**绝对数值**。而 `replaceScoreRowsInAllChecks` 同步 CUTOFF 时是**原样搬**的。

用用户 >3x 那轮的真实因子池实测（勇者 29.7 / 邪恶 70.5 / 合计 100.2，**尺度比 3.37×**）：

| 样本 | review 分 | 线上分 |
| --- | --- | --- |
| 全踩邪恶、勇者全不中 | −70.4 | **−237.4** |
| 典型中位盘 | −39.0 | **−131.5** |
| 勇者全中、邪恶全不踩 | +29.2 | **+98.7** |

页面上的 `cutoff=-42` 搬到线上等价于 **−141.7**，但写出去的是 −42 —— 线上闸门比回测**紧得多**，
触发数会大幅缩水。症状跟第 8.4 节"映射不回 ctx 的因子拖低线上总分"一模一样，但成因完全不同，
而且**每一个含邪恶因子的池子都中招**，邪恶权重占比越高偏得越狠。

（顺带解释了一个一直没深究的现象：用户两轮报告的分数上限都只有 +1.2 / +1.9 —— 因为勇者权重
只占三成，review 口径下分子最高就只能到 Σ勇者/Σ全部 ≈ 30 分，再被邪恶因子的普扣压下来。）

### 32.3 这次改了什么 / 没改什么

**改了（文档口径，无行为变化）** —— [backtestReportExport.js](src/lib/backtestReportExport.js) 第 2 节：

- 公式改成 `/**Σ全部权重（含邪恶）** ×100`，不再用会被读成"只有勇者那一半"的 `Σ正权重`；
- 池里有邪恶因子时**自动加一条告警**，算出 Σ勇者 / Σ全部 / 尺度比，并给出"本报告的 cutoff
  搬到线上应约为 X"。这条直接落在报告里，是因为拿报告做诊断的人（和 AI）最容易在这里踩空。
- 纯勇者池不输出这条（两边分母本来就相同），空因子池不做除零。

**当时没改**：两边的归一化本身。用户选了 32.4 的**方案 2**，见第 33 节。

### 32.4 三条修法，各自的代价

1. **只在同步 CUTOFF 时换算**（改动最小，推荐）：`replaceScoreRowsInAllChecks` 按
   `Σ全部/Σ勇者` 缩放 CUTOFF 再写出去。两边分数尺度仍然不同，但搬过去的阈值是对的。
   代价：策略代码里的 CUTOFF 跟页面上显示的数字对不上，得在生成的注释里写明。
2. **review 跟策略对齐**（`wsum` 只累加勇者权重）：两边尺度彻底一致，最干净。
   代价：所有历史 cutoff / 十分位分数区间 / 报告快照全部变号变值，ρ 不变但页面上每个数字都要重读。
3. **策略跟 review 对齐**（`wsum += Math.abs(weight)`）：**不建议**。`strategySpec.js` 的
   `wsum-no-clamp` 规则是为了挡"邪恶权重把分母拉小、score 被推过 100（实测跑出过 120）"这个
   真实事故加的，改回去等于把那个 bug 请回来。

### 32.5 后续

用户选了**方案 2（review 跟策略对齐）**。上面那条"尺度比 / cutoff 换算"的报告告警因此在同一天
就作废了（两边尺度一致，不需要换算），被第 33 节替换成"分数下界不是 −100"和"纯邪恶池"两条。
本节保留是为了记住**这个分叉曾经存在过**，以及它是怎么被误判成文案笔误两次的。

## 33. 采纳方案 2：review 的归一分母改成「Σ勇者权重」，跟实盘策略对齐（2026-07-29）

第 32 节把分叉摆出来后，用户选了方案 2 —— **改 review，不改策略**。理由见 32.4：策略侧的
`Math.max(0, weight)` 是为了挡一个真实事故加的（邪恶负权重把分母拉小 → 邪恶没触发时 score 反而
被推过 100，实测跑出过 120），改回去等于把那个 bug 请回来。

### 33.1 核心改动

[factorLab.js](src/lib/factorLab.js) `scoreRow`：

```diff
- total += s * f.weight; wsum += f.weight;
+ total += s * f.weight;
+ if (f.camp !== 'evil') wsum += f.weight;   // 分母只累加勇者权重
```

分母的语义从"权重总和"变成「**满分上限**」：勇者全中、邪恶一个不踩 = 100 分，这也是 score 的
最大值。邪恶阵营的"最好情况"是 `s=0`（没踩中危险区、不贡献），不是 `-w`，所以它不该进分母。

新增 `heroWeightSum(factors)` —— UI 判死角、报告说尺度、cutoff 算下界三处都要，抽出来免得各写各的。

**验收**：用第 32 节那个真实因子池跑 review 与策略模板两份公式，三个代表性样本的分数
（−237.4 / −131.5 / +98.7）现在**逐位相等**，差值 0.0。

### 33.2 连带的三个后果（都处理了）

**① 分数下界不再是 −100。** 最低分 = −Σ邪恶/Σ勇者×100，邪恶占比越高越负（用户那个池子到 −237）。
`FactorLab.jsx` 的 `cutoffMin` 原本硬编码 `hasEvil ? -100 : 0`，会把 InputNumber 夹住、**负分段整段
选不到**。改成按实际权重算。阈值扫描 `sweepScoreCutoffs` 本来就是按实际最低分取下界的，不用动。

**② 纯邪恶池会让所有分数恒为 0。** Σ勇者=0 时满分上限是 0、归一无定义。这里**原样复刻策略侧的
`wsum > 0 ? … : 0` 返回 0**，而不是自作主张换个分母兜底 —— 在这一个最难察觉的场景上偷偷跟线上
不一致，正是这次要修的 bug 的形状。代价是分数全同、ρ 会变成 **0**（不是 NaN，`spearman` 对常数
序列给 0），而"ρ=0"跟"因子真的没用"长得一模一样，光看数字分辨不出来 —— 所以报告里加了一条
显式告警（"这个池子没有勇者因子…所有样本分数恒为 0"）。贪心是可能选出纯邪恶前缀的（用户 >3x
那轮的第 1~4 步全是邪恶），这不是假想场景。

**③ 存档里的 cutoff 是旧尺度的。** [factorPoolStore.js](src/lib/factorPoolStore.js) 加
`SCORE_SCALE_VERSION = 2`：版本不匹配时**只摘掉 cutoff**并回报 `cutoffScaleStale`，
因子池（字段/阵营/梯形四点/权重）跟归一分母无关、一个都不丢 —— 那才是耗时的手工成果，
为一个标量清掉整池子是本末倒置。UI 上配一条专门的橙色提醒，说明"秩序没变、ρ/十分位/AUC 都没受
影响，但请重新点一次「推荐阈值」"。不提示的话失败是**静默**的：页面显示一个默认值、触发数跟上次
对不上，且没有任何地方说得清为什么。

### 33.3 第 31 节的常数因子结论要跟着改口径

分母换了之后，常数因子的伤害分成两种（都仍然是"白占位置"、都仍然该被闸门拦）：

| | 进分母？ | 后果 |
| --- | --- | --- |
| **邪恶**常数因子 | 否 | 把所有样本的分数**整体下移**一个常数（纯平移） |
| **勇者**常数因子 | 是 | 进分母、贡献却恒定 → 真正的**稀释** |

两种都不改变秩序（测试里对 ρ 断言 `strictEqual`），但都让 cutoff 的含义漂移。
第 31 节里"常数因子稀释权重"那条测试拆成了两条，各自断言正确的机制。

### 33.4 文案与残留假设清理

`FactorLab.jsx` 的公式说明、权重合计那一行、BacktestCard 的总分上限提示、`factorLab.js` 里
`Σ权重 归一` 的注释 —— 全部改成 `Σ勇者权重`，并写明"跟实盘同尺度、cutoff 可直接搬"。
报告第 2 节同步：公式带上满分上限的**数值**，混合池多一行真实下界，纯邪恶池给专属告警。

### 33.5 验证

- **新增覆盖了一个真空白**：改 `scoreRow` 之后 727 条测试**一条都没红** —— 说明此前
  **没有任何一条测试覆盖混合阵营的分数尺度**。补的 6 条里最关键的是
  「scoreRow 的分数与策略模板公式逐位相等」，它在测试里**重新实现了一遍策略模板的公式**
  （`total += s*w; wsum += Math.max(0,w)`，邪恶权重取负）逐行比对，以后任何一边动了都会红。
- 727 → **737 个测试全通过**：`factor-degenerate.test.js` +6（两种常数因子的机制、ρ 不变、
  与模板逐位相等且能跌破 −100、纯勇者池行为不变、纯邪恶池返回 0、`heroWeightSum` 边界）、
  `backtest-report-export.test.js` 改 4 增 1、`factor-pool-store.test.js` +3（旧存档摘 cutoff、
  无 cutoff 不误报、同版本原样恢复）。
- `vite build` 通过；dev server 加载无新报错。
- **端到端仍没跑通**（原生文件对话框驱动不了）：建议首次打开时确认三件事 —— 顶部是否出现
  "分数口径已更新"提醒、cutoff 输入框能否设到 −100 以下、报告第 2 节的满分上限数值是否等于
  因子表里的勇者权重之和。

## 34. 第 8 节判定的缺陷：只看相对落差、不看绝对水平（2026-07-29）

用户 4 因子那轮的报告第 8 节：

```
| lift | 训练段 1.13 | 验证段 0.96 |
> train→val lift 落差 = 0.17（落差小，泛化较好）
```

**验证段 lift=0.96 的意思是"这个筛子比不筛还差"**——触发的那批里高倍率反而低于基准。
落差再小也不是泛化好，只说明训练段本来也没多好。

原判定只比 `trL - teL` 的差值，从头到尾**没有检查 `teL` 有没有过 1**：

```js
teL < trL * 0.6 ? '（验证段不到训练段 60%…）' : gap > 0.3 ? '（落差偏大…）' : '（落差小，泛化较好）'
```

`1.13 → 0.96`：`0.96 < 1.13*0.6=0.678`？否。`gap=0.17 > 0.3`？否。于是落进"泛化较好"。

这跟第 30 节修的「阈值失效」是**同一类错误的第二个实例**：那次是触发率≥95% 时 lift 恒≈1、
落差恒≈0，照样打"泛化较好"。当时只针对"阈值失效"这一个成因打了补丁，没有把
「**先看绝对水平，再看相对落差**」这条原则本身补上，于是换个成因又犯一次。

**改法**：判定改成三段，绝对水平优先——

| 验证段 lift | 结论 |
| --- | --- |
| `< 0.95` | ⚠️ **比不筛还差**——落差小只说明训练段也没多好 |
| `0.95 ~ 1.05` | ⚠️ 验证段没筛出超额，落差小不代表有效 |
| `> 1.05` | 再按原逻辑分 过拟合 / 泛化较好；文案改成"落差小**且验证段 lift>1**"，把前提写进结论里，免得又被简化成只看落差 |

第 10 节诊断清单第 1 条同步改写成"先看绝对值再看落差"。

**验证**：`backtest-report-export.test.js` +4（lift<1 不许说泛化较好、lift≈1 说没筛出超额、
lift>1 且落差小才给泛化较好且结论里带前提、lift>1 但落差大仍报过拟合）。
737 → **741 个测试全通过**，`vite build` 通过。

**没改**：walk-forward 那份报告的段判定（`assessSplitDecay`，走两比例检验 p 值）。它的措辞是
"略降未达显著"，只声称"衰减不显著"、没有声称"泛化好"，不构成同一个错误；但它同样看不见
"lift 绝对值低于 1"这件事（用户那轮 5 段里有 3 段 test lift ≤1.0，判定全是"略降未达显著"）。
要不要一并加绝对水平判据，等下次一起决定。

## 35. 同分饱和告警的量级错了一个数量级（2026-07-30）

### 35.1 起因

用户看散点图不满意——所有点挤在一条竖线上（那就是 262 个样本同为 −77.3 分的同分块，36%）。
顺着问"该不该拉宽梯形过渡带来加强趋势"，先量了一下这件事到底值多少 ρ。

结果推翻了报告自己的措辞，也推翻了我前一轮给的建议：

| 同分块占比（ρ≈0.19 时） | 对 ρ 的代价 |
| --- | --- |
| **10%（当时的告警触发线）** | **+0.000** |
| 20% | +0.001 |
| **36%（用户真实数据）** | **+0.004** |
| 55% | +0.016 |
| 76% | +0.059 |

| 信号强度（同分块固定 36%） | 对 ρ 的代价 |
| --- | --- |
| ρ≈0.19 | +0.004 |
| ρ≈0.36 | +0.008 |
| ρ≈0.68 | +0.018 |
| ρ≈0.90 | +0.025 |

**代价 = f(块大小, 信号强度)，两个方向都单调。** 直觉解释：ρ 已经很弱时，"块内那 36% 样本的
相对顺序"本来就没携带多少信息，把它打平损失有限。

于是报告里那句 `⚠️ 同分块内部无法排序，**直接压住 ρ 的上限**` 在弱信号下夸大了一个数量级，
而且它的触发线（10%）恰好落在代价为 **0.000** 的地方 —— 照它行动等于白干。

这跟第 30/34 节是同一族问题的第三例：**判定只看一个表面量（这里是"块占多大"），
不看它在当前条件下的实际后果。**

### 35.2 第一版实现是错的，被测试当场抓住

最初想"按当次数据实测"，写了 `tieBreakRhoCeiling`：主键 `score`、次键 `returnMax` 排序，
用排序位次当"完全没有并列的分数"重算 ρ，差值当天花板。

单调性测试立刻红了：

```
强信号 headroom +0.026   弱信号 headroom +0.118
```

**跟真实机制完全相反。** 原因：按 `returnMax` 拆结等于**把答案注入进去**——它测的是
"如果有神谕替我按倍数排序"，不是"如果分数粒度更细"。信号越弱，神谕能凭空造出的 ρ 越多。

**根本教训：这个量不可能实测。** 真实代价取决于"分数更细时并列样本本来该怎么排"，
而那正是被打平抹掉的那部分信息，从观测数据里算不出来。只能建模估计。

### 35.3 改成模型估计 `estimateTieRhoCost`

[factorLab.js](src/lib/factorLab.js)：假设潜在信号 `latent`，观测分数是它的单调量化
（中间一段压成同一个值），`returnMax` 的秩由 `strength·latent + (1−strength)·noise` 决定。
用观测到的 ρ **二分反解 strength**（打结后的 ρ 对 strength 单调递增），再在同一 strength 下
算"分数无并列"的 ρ，两者之差就是估计代价。固定种子，可复现。

模型假设写在函数注释里（latent 均匀、噪声可加、同分块位于分数分布中部——用户那 262 个正好
横跨第 5~7 十分位，跟假设吻合）。**只看量级，别当精确值**，报告文案里也这么写。

顺手踩到一个 JS 细节：`function f({a} = {})` 在**显式传 `null`** 时默认值不生效，直接抛
`TypeError`。改成先收 `opts` 再在函数体里解构。

### 35.4 报告第 4 节：一句笼统告警拆成三条各自有条件的真实后果

| 后果 | 触发条件 | 内容 |
| --- | --- | --- |
| **对 ρ 的代价** | 有估计值就报 | 给出估计数值；`≥0.02` → "值得拉宽梯形过渡带"，`<0.02` → "**瓶颈不在分数粒度上**，别在这上面花时间，要抬 ρ 只能加信息量" |
| **分段表可读性** | `tieRatio ≥ 10%` | 算出**约横跨几个十分位**，点明那几档之间的高倍率差异是随机切分的产物 |
| **cutoff 没有中间档位** | `tieRatio ≥ 10%` | 阈值跨过该分数时触发数一步跳掉多少样本（用户实测：−78 触发 472 → −76 触发 202，一步 270 个） |

后两条在 10% 就已经成立（一个 10% 的块至少吃掉一个十分位），**这两条原来的措辞是对的，保留**；
错的只有第一句。

### 35.5 验证

- [factor-degenerate.test.js](tests/factor-degenerate.test.js) **+6**：复现分析时报出的量级、
  代价随信号强度单调、随块大小单调、恒非负且 `rhoUntiedEst = |ρ| + 代价`、
  **确定性**（同输入 `deepStrictEqual`）、边界（无并列/n<20/脏输入/显式 `null`）。
  其中两条单调性测试就是抓出第一版错误实现的那两条，**常驻**。
- [backtest-report-export.test.js](tests/backtest-report-export.test.js) **+5**：代价小时说"瓶颈不在粒度上"
  且不出现旧断言、代价大时才说"值得拉宽"、≥10% 报跨档+cutoff 断崖、<10% 只报 ρ 代价那行、
  旧数据缺 `tieRhoCost` 时不崩不漏 NaN。
- 741 → **752 个测试全通过**，`vite build` 通过。

### 35.6 这次分析的结论（给后续找因子用）

用户那份 3 因子池，三条抬 ρ 的路全部量化过并堵死：

1. **换北极星目标字段**——不行。买入后只有 `initialMcap`/`currentMcap`/`maxMcap`/`min_mcap`
   四个标量，**没有价格路径**，构造不出"带止盈止损的可实现收益"。而且 ρ 是秩相关，
   `logReturnMax`/截断/开方这类**单调变换等于没换**。`currentMcap/initialMcap`（"现在能卖到多少"）
   看着像个独立目标，但 `currentMcap` 是**导出那一刻**的值、导出时点任意，它测的是"什么时候
   dump 了数据"——用户直接否掉，对的。
2. **拆同分块**——天花板 +0.004，不值当（就是本节）。
3. **加因子**——候选表 79 个可用候选里 test/train 比值健康的只剩池内那一个（见第 34 节）。

**剩下唯一的路是攒数据**：155 个正类是所有问题的上游（区间覆盖 95%+ 是它导致的，见第 31.3 节）。

## 36. 原字段轮次结案：有价值的字段、被否掉的字段、判据（2026-07-30）

**用途**：原字段（`字段范围=原字段`）这一轮跑到头了，这里把结论固定下来，作为**组装字段轮次的
对照基线**。下次别再从零试一遍同样的字段。

样本：**728 条 / 155 个正类（>3x）/ 基准高倍率 21.3% / 4 天（2026-07-26 ~ 07-29）**。

### 36.1 定版因子池（原字段轮次的最终产物）

| 字段 | 阵营 | 权重 | lo0 | lo1 | hi1 | hi0 |
| --- | --- | --- | --- | --- | --- | --- |
| `gmgn.stat.top_10_holder_rate` | 邪恶 | 64.0 | −∞ | −∞ | 24.7075 | 29.5584 |
| `chip_analysis.above_percent` | 勇者 | 20.1 | −1.6918 | 6.7947 | ∞ | ∞ |
| `gmgn.wallet_tags_stat.renowned_wallets` | 勇者 | 16.0 | −∞ | −∞ | 3 | 7.7 |

权重来自 `autoWeights`（∝ `interval.score`），跟数组顺序无关——**乱了不用手抄，清空重扫会给回同样的值**。
满分上限 Σ勇者 = **36.1**，下界 −177.3。**不要点「按 ρ 最优配权」**（实测让 held-out test 从 0.202 掉到 0.193）。

**基线数字（组装字段轮次拿这些对照）**：

| 指标 | 值 |
| --- | --- |
| 北极星 ρ | **0.190** |
| walk-forward 5 段 test lift | **1.25 / 1.11 / 1.01 / 1.10 / 1.24**（均值 1.14，**全部 ≥1.0**） |
| 第 8 节 | train 1.12 → val **1.24** |
| cutoff −80 | 触发 478（66%）· 命中 24.5% · 捕获 75.5% · lift **1.15** |
| cutoff −76 | 触发 202（28%）· 命中 25.7% · 捕获 33.5% · lift **1.21** |
| 同分饱和 | 262 个 @ −77.3（**36.0%**） |
| 十分位倍数中位 | 1.42 → 2.19（**+54%**，整体上行） |
| 十分位高倍率 | 8.3% → 段4 之后**基本走平** |

两个 cutoff 的命中率置信区间重叠（20.7~28.3% vs 19.7~31.7%），**按开仓能力选，不按 lift 选**；
中间没有档位（36% 同分块把 −78→−76 掏空了，一步掉 270 个）。

### 36.2 唯一真正站得住的字段：`gmgn.stat.top_10_holder_rate`（邪恶）

**三个互相独立的口径全部指向它**，这是整轮唯一一个：

1. **边际ρ 的 test/train 比值 = 0.85**（0.035 / 0.041）—— 79 个可用候选里**唯一健康的**（见 36.4 的判据）
2. **五段 walk-forward test AUC 0.552 ~ 0.603**，train 0.546 ~ 0.571，几乎无落差
3. **test 边际ρ 0.035 是全表最高**

**业务解释**：核心区 (−∞, 24.71] 命中扣分 = **前 10 大持有人占比太低 → 没有大户建仓 → 拉不动**。
方向跟"集中度高=危险"的常识相反，但在 meme 场景里合理。

它也是池里**唯一真在切割样本空间**的因子（值 28 得 0.32、值 40 得 0），其余两个都是单边斜坡。

### 36.3 另外两个：入选但证据弱，不要单独用

| 字段 | AUC | 证据强度 |
| --- | --- | --- |
| `chip_analysis.above_percent` | 0.532 | 候选表里**边际ρ 两列是空的**（算不出来） |
| `gmgn.wallet_tags_stat.renowned_wallets` | 0.528 | held-out Δρ 0.014，**低于噪声地板 0.064** |

**留着它们的理由不是它们强，是**：① 加上之后 walk-forward 五段才全部 ≥1.0；
② `top_10_holder_rate` 是**邪恶**阵营，纯邪恶池 Σ勇者=0 → **分数恒为 0**（review 和线上都一样），
必须至少有一个勇者因子撑起分母。

想单独验 `top_10_holder_rate` 的话用勇者版 `gmgn.dev.top_10_holder_rate`（[16.539, ∞)，AUC 0.548）——
`gmgn.dev.*` 和 `gmgn.stat.*` 是同一个量的两个路径。

### 36.4 判据：这一轮真正学到的筛子

按可信度排序，**下一轮直接用**：

1. **`边际ρ(test) / 边际ρ(train) > 0.4`** —— 工具的过拟合判据。79 个候选里只有 1 个过关。
   这是这几轮里唯一预测准过的筛子：`new_volume` 比值 0.18，被它标出来，后来 walk-forward 确认塌了。

   > ⚠️ **2026-07-30 修正：这个比值是【池子依赖】的，不是字段的固有属性。**
   > 边际ρ 的定义是"并进【当前】池子后的增量"，池子一变它就变。实测反例：`holder_fomo_ratio`
   > 在组装字段轮是 test 0.090 / train 0.100（比值 **0.90**），在全量轮同一份数据上变成
   > test 0.021 / train 0.110（比值 **0.19**）——同一个字段、同一批样本，差 4.7 倍。
   > **正确用法**：它只在【同一个池子基线下】跨字段可比，换了池子必须重算。
   > 本节原文把它当固有属性用，那是错的。这也解释了 `holder_fomo_ratio` 两轮都没被贪心选中：
   > 在真实池子里它的边际贡献远没有孤立评估时那么高。
2. **held-out Δρ 的噪声地板 ≈ 0.064**（test n≈218 时 ρ 的标准误）。**Δρ < 0.05 基本不可信**。
   `minGain=0.003` 在这个样本量下形同虚设——readme 自己也写过"它不是过拟合防线"。
3. **walk-forward 五段 test lift 全部 ≥1.0** 才算站住。**先看绝对值再看落差**（第 34 节）。
4. **别按 AUC 挑**（79 个候选的 CI 几乎全跨 0.5）、**别按样本内 ρ 挑**（`new_volume` 让样本内
   ρ 0.190→0.231 全是水分）。
5. **看 `倍数中位` 那一列判北极星，不看 `高倍率`**：ρ 由灰点（79% 的普通盘）驱动，
   橙/灰二元着色是 lift 的口径。散点图上"橙点没右倾"看的是 lift，不是 ρ（第 35 节起因）。

### 36.5 被明确否掉的字段 + 理由（别重复劳动）

| 字段 | 否掉理由 |
| --- | --- |
| `mcap` / `chip_analysis.current_mcap` / `signal_max_mcap` / `max_up_mcap` / `signal_open_mcap` | **市值影子**——`returnMax` 的分母就是进场市值，规律约等于"买小盘"，不是新信息。**黑名单要按 camp 拉**：只拉 `🛡chip_analysis.current_mcap` 挡不住 `☠` 那版，贪心换个别名照选（真实踩过） |
| `new_volume` | 79 个里**唯一过 BH 校正的**（pAdj 4.01e-2、AUC 0.565），但 test/train = **0.18**。加进去 walk-forward 五段 train lift 全涨 ~0.15、test 均值跌 0.11、两段破 1.0 → **回退**。教科书式过拟合 |
| `gmgn.wallet_tags_stat.top_wallets` | **准常数**：529/728（72.7%）落在同一档，AUC 0.515。删掉后 walk-forward 均值 **1.02 → 1.14** |
| `shit_volume` | **真常数因子**：724/728 命中度都是 1.00，对排序零贡献却占 8.1% 权重（已加闸门自动拦，见第 31 节） |
| `gmgn.stat.creator_token_balance` / `gmgn.dev.creator_token_balance` | **ρ=0.98 的同一量两个路径别名**，贪心两个都选了，配权时又都压到 0 |
| `gmgn.stat.bot_degen_rate`（0.078）/ `gmgn.dev.top_10_holder_rate`（0.13）/ `gmgn.dev.creator_open_count`（train 为负） | test/train 比值不合格 |
| `frequent_volume` / `bot_degen_rate` / `top_bundler_trader_percentage` / `fresh_wallet_rate` / `top_entrapment_trader_percentage` | >5x 那轮 **AUC 最高的一批（0.546~0.586）但方向全部违反业务常识**（"越脏越好"，跟 CLAUDE.md 的"高频>50/新钱包>60 危险"相反）。最可能是**热度代理**——有人炒 → 机器人/捆绑器/新钱包全涌进来，跟 returnMax 相关是同义反复，不是前瞻信号 |
| `holder_fomo_ratio` | **（2026-07-30 全量轮补否，理由已按 42.6 的实测数据订正过一次）** AUC 0.601 全表最高、pAdj 9.48e-4 是全表唯一过 BH 校正的。**否掉的理由只有业务这一条**：`tags` 含 fomo 的头部持有人占比 = "追高的散户越多越好"（见 dictionary.js），跟上一行那批"越脏越好"是**同源的热度代理**——FOMO 散户涌入本身就是"已经在涨"的结果，不是前瞻信号。⚠️ 曾按"lift=1.00、train 边际ρ 为负"否它，**那两个数字对不上 42 轮的导出**（实际 lift 1.16、边际ρ test 0.094 / train 0.184、比值 0.51 过 36.4 的门槛），已删除。统计面它其实是全表最强的候选之一，**这是一条纯人工判定的否决**，跟 `☠signal_open_mcap` 一样应该进黑名单而不是靠指标拦 |

### 36.6 这份数据的结构性上限（换字段也绕不开的）

1. **155 个正类是所有问题的上游。** `scanIntervalCore` 的评分 `(wilsonLo/base)×√coverage` 在小正类下
   **系统性偏好"几乎不筛"的宽窗**：实测 n=728/pos=80 时，lift=1.06/coverage=95% 的宽窗
   打得过 lift=1.5 和 lift=2.0 的真区间，**要正类 ~1000 才反转**（第 31.3 节）。
   所以候选表里 coverage 全是 90~98%、lift 全是 1.00~1.13。
2. **36% 同分饱和**：对 ρ 只值 **+0.004**（第 35 节量化过），真实代价在
   **cutoff 没有中间档位** + **第 7 节约 4 个十分位落在同一分数上**。
3. **抬 ρ 的三条路在原字段范围内全部堵死**：换北极星目标（数据里没有买入后的价格路径，
   单调变换等于没换）、拆同分块（+0.004）、加原字段候选（79 个里只剩池内那一个健康）。

### 36.7 组装字段轮次：怎么判断"赚到了"

**为什么值得跑**：前面所有轮次都是 `字段范围=原字段`，**64 个组装字段（`DERIVED_KEYS`）一次都没进过
候选池**。而且它们不是原字段的变体，是几个全新维度——现在池里三个全是**静态结构快照**：

| 维度 | 字段举例 |
| --- | --- |
| 订单流失衡 | `buy_sell_amount_ratio`、`smart_buy_sell_ratio`、`gmgn_net_buy_vol_ratio_5m`、`gmgn_vol_accel_5m_1h` |
| K线量能形态 | `kline_volume_cv`、`kline_volume_trend_ratio`、`kline_max_rise_speed_pct_per_min`、`kline_turnover_pct` |
| 持有人行为 | `holder_paper_hands_ratio`、`holder_never_bought_ratio`、`holder_gini`、`holder_in_profit_ratio` |
| 筹码峰形态 | `chip_analysis.price_concentration_hhi`、`price_to_peak_ratio`、`top5_transfer_in_ratio` |
| 可交易性 | `mcap_liquidity_ratio`、`gmgn_liquidity_change_ratio`、`gmgn_price_to_ath_ratio` |

**采信标准（两个都要满足，缺一不可）**：

- ρ 明显涨（比如 > 0.25）——**且**
- walk-forward 五段 test lift **仍然全部 ≥1.0**

只有样本内 ρ 涨**不算**（`new_volume` 那轮 0.190→0.231 是纯水分，见 36.5）。

**两个坑先知道**：

1. **组装字段映射不回实盘 ctx**，上线取不到值。`onlineExport` 里登记过派生算法的能内联算
   （第 14 节），没登记的要在实盘侧自己复刻。**先探索、确认有信号再考虑上线成本，别倒过来。**
2. **事后字段**：`post_buy_max_drawdown_pct`、`buy_max_retracement`、`mcap_to_max_up_ratio`、
   `max_up_speed_pct_per_min` 这几个含买入之后的信息。第 26.2.1 节记过一次事故：
   `post_buy_max_drawdown_pct` 拿到 +0.278 占全路径增量绝大头，还伴随 **test ρ 比 train 高**
   这个反直觉信号。**见到 test 明显高于 train，第一反应查泄漏，不是庆祝稳健。**

## 37. 全量字段轮：首次全面超过基线 + 修一个报告口径 bug（2026-07-30）

`字段范围=全部字段`（原字段 + 组装字段一起扫，351 个可用候选），缺失率闸门 ≤10%。
**这是这一系列里第一个在每个 held-out 口径上都超过基线的结果。**

### 37.1 结果对比

| | 原字段基线（第 36 节） | **全量** |
| --- | --- | --- |
| ρ | 0.190 | **0.214** |
| walk-forward 五段 test lift | 1.25/1.11/1.01/1.10/1.24（均值 1.14） | **1.14/1.07/1.25/1.26/1.38（均值 1.22）**，五段仍全 ≥1.0 |
| 第 8 节 val lift | 1.24 | **1.38** |
| lift@cutoff | 1.15（触发 478） | **1.26（触发 400）** ——触发更少、lift 更高 |
| 顶档高倍率 | 26.0% | **34.2%** ——首次顶档有真信号 |
| 同分饱和 | 36.0% | **9.5%**（不同分值 353 → **639**） |
| 基线库最差的一天 | 0.85（7-28） | **1.22**（四天全 >1.2） |

因子池 8 个：`gmgn_price_to_ath_ratio`(勇 6.9)、`avg_sell_amount`(邪 6.1)、
`gmgn.wallet_tags_stat.fresh_wallets`(勇 18.0)、`gmgn.stat.creator_token_balance`(邪 **0.0**)、
`chip_analysis.above_below_ratio`(勇 16.6)、`chip_analysis.price_to_peak_ratio`(勇 9.5)、
`signal_first_to_buy_min`(邪 26.1)、`holder_sniper_ratio`(勇 **0.0**)。Σ勇者 = 51.0。

### 37.2 最硬的证据：命中率的置信区间首次清过基准

前面所有轮次的 cutoff，命中率 95% CI 下界都**压在基准 21.3% 之下**——"高于基准"这件事本身都不显著。这一轮变了：

| cutoff | n | 命中率 | CI 下界 | 清过基准？ |
| --- | --- | --- | --- | --- |
| 原字段基线 −80 | 478 | 24.5% | 20.6% | ❌ |
| 全量 30 | 400 | 26.8% | **22.5%** | ✅ |
| 全量 34 | 286 | 28.0% | **22.8%** | ✅ |
| **全量 38** | 111 | 32.4% | **23.7%** | ✅ |
| 全量 42 | 64 | 34.4% | **22.8%** | ✅ |

**30 到 42 整段都清过**，不是挑出来的单点——比单个 lift 数字可信得多。
建议 cutoff = **38**（CI 下界最高、lift 1.52），开仓能力吃得下 400 笔的话 30 也成立（lift 1.26、捕获 69%）。

### 37.3 待处理（不改代码，属数据侧决策）

- **删两个 0 权重因子**：`gmgn.stat.creator_token_balance`、`holder_sniper_ratio`。删了分数不变
  （贡献 0、也不进 Σ勇者），但能清掉 K 折 k\* 的计数和去冗余表的噪声。

  > ⚠️ **2026-07-30 实测修正：「删了分数不变」只对全样本成立。**
  > 用户照这条删掉两个之后重跑，全样本口径逐位不变（ρ 0.214、同分块 69 个 @36.9、
  > cutoff30 触发 400/26.8%/lift 1.26 —— 确认无损），**但 walk-forward 五段从
  > 1.14/1.07/1.25/1.26/1.38 变成 1.08/1.07/1.71/0.99/1.55，第 4 段破了 1.0**，
  > 违反 36.7 的采信标准。
  > **原因**：walk-forward / 基线库对比这些口径是**每段重新 autoWeights** 的，
  > 一个字段在全样本上权重为 0，不代表在各段的训练子集上也是 0 —— 删掉它就改变了每段的权重分配。
  > **结论**：0 权重因子只在"全样本打分"这一个口径上是无害的。要删就得接受 walk-forward 换一份结果，
  > 不能只看前半句。（第 4 段验证集正类只有 7 个，0.99 差 1.0 只有 0.01，落在噪声里 —— 但 36.4
  > 第 3 条那条线是硬的，且 34 节的教训正是"先看绝对值"。）
- **一对要盯的相关**：`fresh_wallets` ↔ `signal_first_to_buy_min` ρ=**0.61**（未到 0.7 阈值但全表最高），
  而 `signal_first_to_buy_min` 拿了最高权重 26.1、AUC 只有 0.505。
- **贪心前两步仍有单刀切分的痕迹**：步1 held-out 0.153 / 样本内 0.040，步2 held-out 0.110 / 样本内 −0.003。
  跟组装字段轮同一个形态（readme 26.6 未做项第 3 条），只是这次最终结果没被它拖坏。

### 37.4 修：报告第 1 节把全量轮标成「原字段」

第 1 节输出的是 `字段范围：原字段`，而这次跑的是全部字段。原因在
[backtestReportExport.js](src/lib/backtestReportExport.js)：

```js
字段范围：${c.fieldScope === 'assembled' ? '组装字段' : '原字段'}   // ← 'all' 落进 else
```

**只判了 `assembled`。** 而同一次扫描的候选表导出走的是 `FactorLab.jsx` 里那份三档全覆盖的
`FIELD_SCOPE_LABEL`，写的是「全部字段」——**两份文件对同一次扫描给出矛盾口径**。报告存下来过几个月
回看，会直接误判成原字段轮的结果。

**根因是重复实现**，所以修法是去重不是把三元补全：`FIELD_SCOPE_LABEL` + `fieldScopeLabel()`
移到 [factorLab.js](src/lib/factorLab.js) 导出，报告和 UI 共用一份。
兜底返回**原始值本身**（`未指定` / `kline`）而不是静默归到某一档——这次的 bug 就是"看起来正常"造成的。

这是本 session 的第四个同族问题（第 32/33 节尺度、第 34 节 lift 判定、第 35 节同分代价）：
**口径变了但输出没跟着变**。共同点都是同一件事在两处各写一份。

**验证**：`backtest-report-export.test.js` +3（三档分别显示对、`all` 绝不能标成原字段、
未登记 scope 原样显示）。752 → **755 个测试全通过**，`vite build` 通过。

### 37.5 顺带修正第 36.4 节的判据

`边际ρ(test)/边际ρ(train)` 比值是**池子依赖**的，不是字段固有属性——`holder_fomo_ratio`
在组装字段轮 0.90、在全量轮同一份数据上 0.19，差 4.7 倍。已在 36.4 那条下加了修正块。

## 38. 推荐结果不可复现：并行扫描的完成顺序泄漏到了最终选字段（2026-07-30）

用户报「每次刷新跑出来的推荐结果都不一样」。**这条如果不修，前面所有轮次的对比都不成立**
（第 36/37 节一直在把两轮的数字当同源比较）。

### 38.1 定位

算法层全是确定性的：`scanIntervalCore` / `bootstrapAucCI` / `assignFoldsByToken` /
`permutationNullMarginalRho` / `estimateTieRhoCost` 全部固定种子，`coordinateAscentGeneric`
本身无随机。所以不确定性只可能来自**输入顺序**。根因在一行：

```js
// ui/factorLab/workerPool.js —— scanCandidatesWithWorkers
(batch.camp === 'evil' ? evilRaw : heroRaw).push(...(msg.raw || []));
```

字段切批派进**共享** worker 池（谁空谁取下一批，为了多核利用率），结果按**完成顺序** push。
完成顺序取决于各批耗时和 OS 调度 —— 每次刷新都不同。

**传导链**（四层，每层都靠 `Array#sort` 的稳定性"保留输入顺序"）：

```
worker 完成顺序 → rawList 顺序
  → finalizeAucScan  usable.sort 只按 |AUC−0.5|      → 打平时保留输入顺序 → candidates 顺序
  → recommendFactorPath  pool.sort 只按 interval.score → 打平时保留 candidates 顺序
  → 贪心  cands.sort 只按 testRho                     → 打平时保留 pool 顺序
  → 选中哪个候选
```

**精确打平在真实数据里很常见**，不是理论风险：组装字段轮里
`chip_analysis.inner_sell_ratio` 与 `inner_address_holding` 的 AUC（0.542）和边际ρ（0.110/−0.005）
**逐位相同**；`v_breakout_volume_signal_count` 与 `recent_prior_count` 同理（0.549 / 0.046）。
同一个量的两个路径别名建出来的因子打分完全一样 → `testRho` 必然精确打平。

**既有的「并行扫描等价性」测试为什么没抓到**：它喂的是 `scanned.map(...)`，即**按字段顺序**的
rawList，从来没测过乱序。它守的是"同一份输入算出同一个结果"，不是"顺序无关"。

### 38.2 复现

同一份 raw、只换顺序，跑 `assembleCampScan` + `recommendFactorPath`：

```
输入顺序  路径: f1       → n1 → f2       → f3
倒序      路径: f1_alias → n1 → f2_alias → f3_alias     ← 三个字段全换了
随机打乱  路径: f1_alias → n1 → f2_alias → f3
```

注意 `baseTestRho` 三次完全相同（0.907310）——**别名对是完全相关的，所以换谁分数一样**。
这解释了为什么这个 bug 能潜伏这么久：**症状是"字段名变了"，而不是"数字错了"**。
但一旦打平的两个候选不是完全相关（真实数据里 `gmgn.stat.*` / `gmgn.dev.*` 的 ρ 是 0.98 不是 1.0），
第一步选谁不同 → 后续每步都在不同的池子上评估 → 整条轨迹发散，数字也会变。

### 38.3 修法：两层

**① 让 rawList 顺序确定**（[workerPool.js](src/ui/factorLab/workerPool.js)）——
按**批次下标**回填 `slots[bIdx]`，最后按派发顺序展平，不再按完成顺序 push。
worker 路径因此与串行路径逐字节一致，跟调度无关。

**② 三处排序加确定性 tie-breaker**——不再依赖 `Array#sort` 的稳定性去"保留输入顺序"：

| 位置 | 加的兜底键 |
| --- | --- |
| [auc.js](src/lib/auc.js) `finalizeAucScan` | `String(a.field).localeCompare(...)` |
| [factorLab.js](src/lib/factorLab.js) `recommendFactorPath` 的 `pool.sort` | `'camp:field'` |
| 同上，贪心的 `cands.sort` | `'camp:field'` |

**为什么两层都要**：①治本次的病，②让结果只依赖候选**集合**、跟顺序彻底无关——
将来上游字段列表顺序一变（加个新字段、换个遍历方式），不会又悄悄改变推荐结果。

**注意这修改了一处既有的等价性声明**：`cands.sort` 原注释写着"平局保留 pool 顺序，与改动前
`deltaTest > best.deltaTest`（严格大于，平局取先出现的）逐字节等价"。加兜底键后不再是那个语义，
但由于 pool 顺序本身现在已按名字确定，整体结果反而**更**有定义。既有的 beam 等价性回归全部照常通过。

### 38.4 验证

新增 [tests/scan-order-determinism.test.js](tests/scan-order-determinism.test.js) **6 条**：
fixture 里确有精确打平（前提自检）、`finalizeAucScan` / `assembleCampScan` / `recommendFactorPath` /
`recommendFactorPool`（含权重与 k\*）/ beam3+后向+闸门 —— 全部在「输入顺序 / 倒序 / 随机打乱」三种
输入下断言结果完全一致。

**回归有效性验证过**：临时回退两处 tie-breaker，这 6 条里 **5 条立刻变红**（第 1 条是前提自检，
本来就该绿）；恢复后全绿。755 → **761 个测试全通过**，`vite build` 通过。

### 38.5 对前面结论的影响

- **第 36/37 节的数字仍然成立**：它们的差异（ρ 0.190 → 0.214、walk-forward 1.14 → 1.22、
  顶档 26.0% → 34.2%）远大于别名互换能造成的扰动，而且 walk-forward/基线库那些是每段重新配权的，
  不吃候选顺序。
- **但"某个字段被选中/没被选中"这件事此前不可复现**。第 36.5 节被否字段清单里，凡是理由为
  "贪心没选它"的都要打折扣——`holder_fomo_ratio` 两轮都没进池，现在无法确定是它真的边际贡献低，
  还是打平时输给了别名。**修复后重跑一次才能定论。**

## 39. 第 38 节修复验证 + 三个被那份结果暴露出来的判定缺陷（2026-07-30）

用户按第 38 节的建议连跑两次，两份结果**逐字节相同**（12 步路径、每步 Δρ、🌀 数、
K 折 12 个点、精配权 +0.199→+0.251、被压到 0 的两个字段）——**顺序不确定性确认修复**。

但那份结果本身暴露了三处判定缺陷，全是同一族：**判据只覆盖了一个方向/一种情形**。

### 39.1 过拟合校验是单向的：`test` 反常地【高于】`train` 时报"站得住脚"

那次跑出 `train ρ=+0.193 / held-out test ρ=+0.308`，UI 输出 **"test 没有明显塌陷，这份权重站得住脚"**。
判据只有一句：

```js
const overfit = rhoTrain > 0 && rhoTest < rhoTrain * 0.4;   // 只查"掉太多"
```

而 readme 26.2.1 记的那次**真实泄漏**（事后字段 `post_buy_max_drawdown_pct` 进池）正是这个形态
（train 0.243 / test 0.325），当时的结论原话：*"以后见到 test 显著高于 train，第一反应该是查泄漏，
不是庆祝稳健。"* —— 那条教训写进了 readme，却从没写进代码。

**改法**：`recommendFactorPool` 增返 `testAboveTrain`（`rhoTest > rhoTrain * 1.2` 且 `rhoTrain > 0`）
和 `rhoGapSe`，UI 的 Alert 从两态改三态（塌陷 / **反常偏高** / 正常）。

**刻意不做显著性门槛**——把两段 ρ 之差跟抽样噪声比一下就知道门槛没用：

| | train ρ | test ρ | z | 是否显著 | 实际是什么 |
| --- | --- | --- | --- | --- | --- |
| 26.2.1 那次 | 0.243 | 0.325 | ≈1.1 | 否 | **确认过的真泄漏** |
| 这次 | 0.193 | 0.308 | ≈1.5 | 否 | 未知 |

秩相关在 n=200~500 上的抽样噪声就能盖住这个量级的差距。所以第三态**只做形态提示、不下定论**，
文案里直说"**这不构成证据**，两段 ρ 之差的抽样噪声约 ±X"，并给出该去查什么
（事后字段 / 高缺失率字段）和怎么定位（悬停路径标签找 held-out Δρ ≫ 样本内 Δρ 的那一步）。

### 39.2 缺失率闸门活不过一次刷新

那条路径的第 10 步是 `whale_recent_notice_mcap`——**总 n=28、缺失率 96.2%**，
靠 28 条样本的 AUC 0.656（CI 0.4309~0.866）排到候选表榜首。

闸门本身是好的（`recommendCandidates` 里 `(c.missRate ?? 0) * 100 <= candFilter.maxMissRate`），
坏在两点叠加：

```js
useState({ minMarginal: 0.005, maxMissRate: 100 })          // 默认 100 = 全放行
saveFactorPoolState({ factors, threshold, ... })            // candFilter 不在里面
```

**默认全放行 + 不持久化 = 每次刷新静默回到全放行。** readme 第 102 节那次
"算推荐挑进缺失率 95%+ 字段"的事故就是这么复发的——不是逻辑坏了，是那个设置活不过一次刷新。
而按 SOP，缺失率是这几个过滤器里**唯一真正限制推荐能选到什么**的（其余只影响表格展示）。

**改法**：`candFilter` 进持久化，默认值 100 → **10**（跟第 36 节定的口径一致）。

### 39.3 K 折文案把"增益在噪声内"说成了"没有增益"

曲线是 `k7:0.169 … k11:0.184 k12:0.199`（**峰值在 k=12，一路在涨**），
文案却写「第 **8~12** 个在 K 折 held-out 上**不再有增益**（过拟合尾巴）」。

k*=7 是 **1-SE 规则**选的——"在峰值一个标准误之内的最小 k"，不是"后面没增益"。
这两件事的处理方式完全不同：前者是"多出来的增益分不出真假、按奥卡姆取省的"，
后者才是"再加就是过拟合"。

**改法**：按 `hc.kBest > recommendedCount` 分支。峰值在 k\* 之后时改说
"峰值其实在 k=N，但 k\* 处已落在峰值 1 个标准误之内 —— 多出来那几个的增益在噪声范围里，
**这不等于后面没增益**；想要就留整条，求稳就取前 k\* 个"。

### 39.4 验证

- `factor-recommend.test.js` **+2**：`testAboveTrain`/`rhoGapSe` 返回且与 `overfit` 互斥；
  判据边界表（**用户这次的 0.193/0.308 和 26.2.1 的 0.243/0.325 都必须被标出**、
  高 15% 不报、塌陷走另一分支、train≤0/NaN 不置位）。
- `factor-pool-store.test.js` **+3**：`candFilter` 往返持久化、`minMarginal:0` 不被当"未设置"丢掉、
  旧存档没有该字段时不报错。
- 761 → **766 个测试全通过**，`vite build` 通过，dev server 加载无新报错。
- **端到端未跑**（原生文件对话框驱动不了）：下次打开时留意三件事——缺失率闸门默认是否为 10、
  刷新后是否还是 10、以及 `test > train` 时那条 Alert 是否变成蓝色的"🔍 值得回头查一眼"。

### 39.5 这已经是本 session 第五个同族问题

第 32/33 节（归一分母两处各写一份）、34 节（lift 判定只看相对落差不看绝对水平）、
35 节（同分代价笼统断言、触发线落在代价为 0 的地方）、37 节（字段范围标签两处各写一份）、
本节（过拟合判据只查单向）。

**共同点：判定/口径只覆盖了实际会出现的情形的一部分，而漏掉的那部分恰好会输出一个"看起来正常"的结论。**
这比直接报错危险得多——报错会被立刻发现，"看起来正常"会被当成结论用下去。
排查思路也一致：**看那个判据的反面/边界会输出什么**。

## 40. 同字段跨阵营：贪心把 `holder_gini` 的勇者版和邪恶版都选进了同一条路径（2026-07-30）

3x 全量轮的推荐路径里，**`holder_gini` 出现了两次**：

```
第 3 步：☠ holder_gini（held-out Δρ 0.063，样本内 Δρ 0.044）
第 10 步：🛡 holder_gini（held-out Δρ 0.010，样本内 Δρ 0.031，⚠️疑似过拟合）
```

"集中度低要扣分"和"集中度高要加分"同时成立。

### 40.1 根因：去重键带了 camp

[factorLab.js](src/lib/factorLab.js) `recommendFactorPath` 的 `chosen` 集合存的是 `'camp:field'`，
所以 `hero:holder_gini` 和 `evil:holder_gini` 是两个互不相干的键，两个都能进。

**候选层面两阵营各自独立是有意设计、不能改** —— [fullFieldRecommend.js](src/lib/fullFieldRecommend.js)
头部注释写得很明确：*exclusions 按 camp+field 记，同一个字段完全可能"允许当勇者、不许当邪恶"*。
问题只在**贪心把同一字段的两个相反方向都选进同一条路径**。

### 40.2 它不是纯冗余 —— 这正是它能潜伏下来的原因

勇者梯形只能表达 `0 → +w`，邪恶只能 `0 → −w`，**单个梯形跨不过零**。
所以"低值扣分 / 高值加分"这种三段形状，两阵营并存**确实增加了表达力**，不是简单的重复计分。
但代价有三条：

1. **语义上无法向实盘复刻** —— 上线代码里没法写"这个字段既是加分项又是减分项"。
2. **归一分母被污染** —— 勇者版计入 Σ勇者（第 33 节那个满分上限/分母），邪恶版不计入。
   同一个字段既抬高满分上限、又能往下扣分。
3. **在报告里完全隐形** —— 真实案例两步隔了 7 步，谁都不会注意到是同一个字段。

而且这次它换来的表达力是拿噪声买的：第 10 步 held-out Δρ **0.010**，
远低于 36.4 的噪声地板 0.064，工具自己还标了 ⚠️疑似过拟合。

合成 fixture 复现（`x` 与 `returnMax` 同向，hero 取高值区、evil 取低值区）：

```
allowCrossCamp=false  path=[hero:x(0.9380)]                 blocked=[evil:x Δρ0.0318 by hero]
allowCrossCamp=true   path=[hero:x(0.9380), evil:x(0.0318)] blocked=[]
```

第二行就是改动前的行为 —— 0.0318 的增量足以让它挤进路径。

### 40.3 改法：默认拦住 + 三处让它可见

**闸门**（`recommendFactorPath` 新增 `opts.allowCrossCamp`，默认 **false**）：beam 除了
`chosen`（camp:field）再维护一份 `chosenFields`（只有字段名）。三个细节：

- 闸门放在 `deltaTest > minGain` 检查**之后** —— 这样报出来的都是"本来够格、只因另一阵营占位被拦"的，
  不会把本来也进不去的候选混进诊断列表。
- `chosenFields` 初值包含 **起点池的字段名**（`startFields`）—— 组合路径模式下起点池已占 `hero:X` 时，
  贪心也不该新增 `evil:X`。只管"新增之间"是管不住的。
- `shrinkBeam`（后向剔除）重建 `chosenFields` —— 被删掉的因子要把字段名腾出来，
  否则一个已经不在路径里的字段还占着闸门的位置。

**可见性**（静默拦跟静默放行是同一类毛病，只是方向反了）：

| 位置 | 做法 |
| --- | --- |
| `recommendFactorPath` / `recommendFactorPool` 返回值 | 新增 `crossCampBlocked: [{field, camp, deltaTest, blockedBy}]`，只保留占位因子**最终真的留在路径里**的那些（占位因子后来被后向剔除丢掉的，报出来会误导） |
| [FactorRecommendCard.jsx](src/ui/factorLab/FactorRecommendCard.jsx) | 路径下方一条蓝色 Alert，列出被拦的字段 + Δρ + 被谁占位 + 为什么不该并存 |
| [backtestReportExport.js](src/lib/backtestReportExport.js) `buildRecommendPathReport` | 抬头一行 `🔁 有 N 个候选被闸门拦下`；**外加一条自检** —— 扫一遍 path 里有没有同字段出现多次，有就顶到最前面告警。将来万一有人开了 `allowCrossCamp`，报告会自己把它说出来，不会再隐形 |

### 40.4 验证

- `factor-recommend.test.js` **+5**：默认拦住且 `crossCampBlocked` 内容正确、`allowCrossCamp:true`
  恢复旧行为、**起点池占位也要拦**、报告写明闸门 + 同字段重复的自检（用 `holder_gini` 那组真实数字）、
  `recommendFactorPool` 两条 return 路径都带 `crossCampBlocked`。
- **回归有效性验证过**：临时把默认值翻回 `true`，这 5 条里 **3 条立刻变红**；恢复后全绿。
- 766 → **771 个测试全通过**，`vite build` 通过。
- **端到端跑通**（这次不需要真实数据，合成 fixture 就能触发）：dev server 里直接 import
  `recommendFactorPool` + `buildRecommendPathReport`，确认因子池只留 `hero:x`、
  `crossCampBlocked` 回包正确、报告里有那行 `🔁 ... 已被 🛡 版占位`；两个改动的 UI 文件编译加载无新报错。

### 40.5 这是本 session 第六个同族问题

第 32/33（归一分母两处各写一份）、34（lift 判定只看相对落差）、35（同分代价笼统断言）、
37（字段范围标签两处各写一份）、39.1（过拟合判据只查单向）、本节（去重键漏了一个维度）。

**共同点仍然是那句**：判定/口径只覆盖了实际会出现情形的一部分，漏掉的那部分**恰好输出一个"看起来正常"的结论**。
这次的新变化是排查入口 —— 前五个是"看那个判据的反面/边界会输出什么"，
这次是**"看那个去重/归并键少了哪个维度"**：`camp:field` 少了"一个字段只能有一个方向"这条约束。

## 41. 单独审 `signal_first_to_buy_min`：不是泄漏，但它是全池最大的一根杠杆（2026-07-30）

> ⚠️ **本节的池子已经过期**：下一轮（第 42 节）的因子池换成了 4 个，`signal_first_to_buy_min`
> 在推荐路径里退到第 8 步、held-out Δρ 只有 **0.004**，被后向剔除丢出池子。
> 41.1 的**泄漏排除结论仍然有效**（那是字段固有属性）；41.2/41.3 里那些跟权重 26.1 绑定的
> 数字只对 37 节那个池子成立，**别照抄**。41.5 的注释修同样不受影响。

起因：3x 全量轮的池子里它拿了**全池最高权重 26.1**，AUC 却只有 **0.505**（等于抛硬币），
而且跟 `fresh_wallets` 的 ρ=**0.61** 是全表最高。三个数字凑在一起需要一个解释。

### 41.1 先排除泄漏：它是干净的

字段定义在 [data.js:1236](src/lib/data.js)：`(buyMs - firstT) / 60000`，
`firstT` 是六类信号 list 合并排序后的**最早一条**。关键在同一个函数上面几行：

```js
// data.js:1220
if (Number.isFinite(buyMs) && tMs > buyMs) continue;   // 晚于买入的信号一律丢弃
```

所以 `firstT ≤ buyMs` 是硬保证，算出来的分钟数**完全由买入时刻可见的信息构成**，
不属于 36.7 那条"事后字段"（`post_buy_max_drawdown_pct` 那一族）。
[onlineExport.js:843](src/lib/onlineExport.js) 是逐字同款实现、且已登记在 `produces` 里（811 行），
**上线能内联算出来，没有复刻成本**。

结论：泄漏这条排除掉，`test ρ > train ρ` 那个警报信号在它身上也没出现。

### 41.2 真正该盯的：邪恶因子不进分母，26.1 是全池最大摆幅

第 33 节把归一分母改成 **Σ勇者** 之后，一个因子能造成的分数摆幅是 `w / Σ勇者 × 100`。
本轮 Σ勇者 = 51.0，逐个算出来：

| 因子 | 阵营 | 权重 | 最大摆幅 |
| --- | --- | --- | --- |
| **`signal_first_to_buy_min`** | ☠ | **26.1** | **−51.2** |
| `gmgn.wallet_tags_stat.fresh_wallets` | 🛡 | 18.0 | +35.3 |
| `chip_analysis.above_below_ratio` | 🛡 | 16.6 | +32.5 |
| `chip_analysis.price_to_peak_ratio` | 🛡 | 9.5 | +18.6 |
| `gmgn_price_to_ath_ratio` | 🛡 | 6.9 | +13.5 |
| `avg_sell_amount` | ☠ | 6.1 | −12.0 |

**它一个因子的摆幅（51.2）比任何一个勇者因子都大，也比 cutoff 38 本身还大。**
换句话说：分数轴上最长的那一段，是一个 AUC 0.505 的字段在控制。这不必然是错的
（36.4 第 4 条明说"别按 AUC 挑"，梯形挖的是区间、AUC 量的是全局单调性，两者本来就会打架），
但它把"这个因子到底在做什么"从一个次要问题抬成了主要问题。

顺带记一个尺度事实：本轮下界 = −Σ邪恶/Σ勇者×100 = −32.2/51.0×100 = **−63.1**。

### 41.3 决定性检验是留一法，不是 AUC

因为**邪恶因子不进分母**，删掉它的效果分两种，正好可以互相区分：

- **如果它接近常数**（对绝大多数样本给同一命中度）→ 删掉它等于给所有样本加同一个常数
  → **ρ / 十分位 / lift 逐位不变，只有 cutoff 平移**。那它就是 `shit_volume` 同族，
  26.1 是 36.6 第 1 条那个"宽窗刷分"机制刷出来的，该删。
- **如果 ρ 明显掉** → 它确实在切样本空间，AUC 0.505 只是因为效应非单调，保留。

**操作**：把它从池子里删掉、**不要重新配权**（其余五个的 autoWeights 原值保持），看 ρ 动不动。
Δρ 要拿 36.4 第 2 条的噪声地板 **0.064** 比，不是拿 0 比。

**不用重跑就能先排掉一半**：`findDegenerateFactors` 的软线是 **0.90**
（[factorLab.js:346](src/lib/factorLab.js)），UI 上有常驻提醒。如果它没被挂提醒，
说明 `modalShare < 90%`，"准常数"这条假设就基本排除了 —— 先看一眼 UI 再决定要不要动手。

⚠️ 注意别把留一法和 walk-forward 的结论搞混：37.3 那条修正说得很清楚，
**walk-forward / 基线库每段都重新 autoWeights**，所以"全样本删了无损"推不出"walk-forward 无损"。
两个口径都要看。

### 41.4 那对 ρ=0.61 的相关：绿灯是"阈值没到"，不是"不冗余"

`signal_first_to_buy_min`(26.1) + `fresh_wallets`(18.0) = **44.1，占 Σ全部权重 83.2 的 53%**，
而这两个恰好又是全表相关性最高的一对。去冗余检查报绿灯只是因为 0.61 < 0.7 这条闸门。

业务上它们相关是讲得通的：一个 token 在信号池里挂得越久，累积涌进来的新钱包越多。
真要拆的话，把 `fresh_wallets` 换成"单位时间新钱包数"能剥掉这层共线 ——
但那是新字段，得走完整的 36.7 采信流程，不是现在这轮的事。

### 41.5 顺带修：常数因子那段注释还停在第 33 节之前的分母口径

审 41.2 的时候翻到 [factorLab.js:302](src/lib/factorLab.js) 常数因子检测那段头注释，里面写的是：

```
scoreRow 按 **Σ全部权重** 归一（`wsum += f.weight`，不分阵营），
所以这个因子的权重照样进分母，把其它因子的有效权重按比例稀释掉
```

但第 33 节（同一天）已经把分母改成 Σ勇者，实际代码是
`if (f.camp !== 'evil') wsum += f.weight`（[factorLab.js:1398](src/lib/factorLab.js)）。
33.4 节自称扫过一遍"`factorLab.js` 里 `Σ权重 归一` 的注释"，**这一处漏了**。

漏得还挺巧：它引的真实案例 `shit_volume` 恰恰是**邪恶**因子，
而邪恶常数因子**根本不进分母、不稀释任何人**，真实机制是"给所有样本减同一个常数"。
也就是说这段注释对着一个邪恶因子讲了一套只对勇者因子成立的危害。
`tests/factor-degenerate.test.js` 里两条分机制的测试（77 行邪恶=平移、90 行勇者=稀释）
早就是对的 —— **测试改了、注释没跟上**，这也是为什么它能潜伏一整天没被发现。

已改成按阵营分开讲，并点明邪恶常数因子"什么排序指标都不动、只漂 cutoff，比勇者版更难发现"。
同段里"每个样本一律 -8.1 分"也改成 `8.1/Σ勇者×100`（旧尺度残留）。

**这是本 session 第七个同族问题**，且这次是第 33 节那次清扫**自己漏下的**：
32/33（归一分母两处各写一份）、34（lift 判定只看相对落差）、35（同分代价笼统断言）、
37（字段范围标签两处各写一份）、39.1（过拟合判据只查单向）、40（去重键漏了一个维度）、本节。
新的排查入口：**"某次口径变更声称清扫过的范围，真的扫干净了吗"** —— 33.4 那句
"全部改成 Σ勇者权重"是一句无人复核的自我声明。

### 41.6 另外两项待办的执行要点

- **加回两个 0 权重因子重跑 walk-forward**：预期第 4 段从 0.99 回到 1.26、五段回到
  1.14/1.07/1.25/1.26/1.38（37.1 的原始记录）。这只是确认 37.3 那条修正的因果链
  （"每段重新 autoWeights" 而不是别的什么），**便宜且该做**。
- **cutoff 30 → 38**：37.2 那张表里 30~42 整段的 CI 下界都清过基准 21.3%，38 是下界最高的一点
  （23.7%、lift 1.52、触发 111）。选它还是选 30（触发 400、lift 1.26、捕获 69%）是**开仓能力问题，不是统计问题**。
  一个容易被忽略的好消息：第 33 节之后 review 的分数尺度**已经跟实盘策略对齐**，
  这个 cutoff 数值可以直接搬到线上，不用再按 `Σ全部/Σ勇者` 缩放（那是第 32 节时代的做法）。

## 42. 4 因子轮：ρ 创新高 0.228，但顶档塌了 —— 根因是「缺失记0」在邪恶阵营下是奖励（2026-07-30）

跨阵营闸门（第 40 节）上线后重跑的一轮。因子池被后向剔除压到 **4 个**，
`signal_first_to_buy_min` / `holder_sniper_ratio` / `avg_sell_amount` / `creator_token_balance` 全部出局。

| | 原字段基线(36) | 全量 8 因子(37) | **本轮 4 因子** |
| --- | --- | --- | --- |
| ρ | 0.190 | 0.214 | **0.228** ← 历史最高 |
| walk-forward 五段 test lift | 1.25/1.11/1.01/1.10/1.24（1.14） | 1.14/1.07/1.25/1.26/1.38（1.22） | **1.05/1.30/1.14/1.13/1.44（1.21）**，全 ≥1.0 ✅ |
| 第 8 节 val lift | 1.24 | 1.38 | **1.44**（train 1.15） |
| 基线库四天 lift | — | 四天全 >1.2 | 1.16/1.20/1.31/1.60，四天全 >1.0 |
| 同分饱和 | 36.0% | 9.5% | **22.1%** ← 退回去了 |
| **顶档（第10档）高倍率** | 26.0% | **34.2%** | **20.5%** ← **跌破基准 21.3%** |

**36.7 的采信标准是"ρ 明显涨（>0.25）**且**walk-forward 五段全 ≥1.0"** —— 第二条满足，
第一条 0.228 仍没到 0.25。而且这一轮出现了前两轮都没有的新毛病。

### 42.1 顶档塌陷：分数最高的那 73 个样本，高倍率低于不筛

第 7 节第 10 档（分数 79.5~100，n=73）高倍率 **20.5%**，**低于基准 21.3%**。
cutoff 扫描是同一件事的另一个切面，而且更干净：

| cut | 触发 | 命中率 | lift |
| --- | --- | --- | --- |
| 74 | 314 | 26.8% | **1.26** ← 全表最佳操作点 |
| 76 | 281 | 26.7% | 1.25 |
| 78 | 85 | 23.5% | 1.11 |
| **80** | **69** | **20.3%** | **0.95** ← 比不筛还差 |
| 82 | 58 | 20.7% | 0.97 |

**分数 ≥80 的那 69 个样本 lift 0.95。** 这是这一系列里第一次出现"越高分越差"的顶部反转
（37 轮是"首次顶档有真信号 34.2%"，这一轮直接反过来）。

⚠️ 第 7 节 8/9 两档要打折扣看：22.1% 的同分块（161 个 @77.5 分）横跨这两档，
段8 的 27.4% 和段9 的 32.9% 之间的差异是随机切分的产物。**只有第 10 档（79.5 起，在同分块之上）是干净的**，
而它恰好就是塌的那一档。

### 42.2 根因：`holder_gini`(☠) 把「缺失数据」顶到了分数最高处

先算清楚这个池子的分数结构（Σ勇者 = 18.1 + 26.8 + 36.8 = **81.7**）：

| 因子 | 阵营 | 权重 | 摆幅 | 核心区覆盖 | 候选表 lift | 路径 held-out Δρ |
| --- | --- | --- | --- | --- | --- | --- |
| `chip_analysis.above_below_ratio` | 🛡 | 36.8 | **+45.0** | 90.0%（655/728） | 1.05 | **0.023** |
| `gmgn.wallet_tags_stat.fresh_wallets` | 🛡 | 26.8 | +32.8 | — | 1.07 | 0.044 |
| `gmgn_price_to_ath_ratio` | 🛡 | 18.1 | +22.2 | — | 1.06 | **0.153** |
| `holder_gini` | ☠ | 18.4 | **−22.5** | 94.9%（653/688） | **1.00** | 0.063 |

**三个勇者全满命中 + 邪恶全踩中 = (36.8+26.8+18.1−18.4)/81.7×100 = 77.5** ——
正好就是那个 161 个样本的同分块分值。也就是说 22.1% 的样本在四个因子上**全部饱和**，池子对它们一个字都没说。

再看顶部。要爬到 77.5 以上，唯一的办法是**躲掉 `holder_gini` 那 −22.5 分**。谁能躲掉？

1. `holder_gini` > 0.6548 的 **35 个**样本（653/688 落在核心区，剩下 35 个）
2. `holder_gini` **缺失的 40 个**样本（缺失率 5.5% × 728）—— 缺失记 0 分 → 不扣分 → **白捡 22.5 分**

**35 + 40 = 75 ≈ 第 10 档的 n=73。** 顶档基本上就是这两批人，而它们合起来的高倍率是 20.5% = 基准。

**这就是「缺失记0」这条口径的不对称**（[factorLab.js:1387](src/lib/factorLab.js)）：

> 缺失口径只有一种：**缺失记 0 分**（不加不减）。惩罚的是数据覆盖而不是盘质量，偏保守

**"偏保守"只在勇者阵营下成立。** 勇者缺失 → 拿不到加分 → 惩罚；
**邪恶缺失 → 躲掉扣分 → 奖励**。同一条口径，两个阵营下方向相反。
这个池子里它的后果是：40 个"我们对它一无所知"的样本被系统性推到分数最高处，
把顶档的信号稀释成了噪声。

（注意这**不是**可以随手改的：1389 行写明它必须跟 `onlineExport` 的行为一致，
两边尺度不能分叉。要动就得两边一起动，属于口径变更不是 bug 修复。）

### 42.3 第二个问题：权重分配跟证据强度完全反着来

上表最后两列并排看：

- `gmgn_price_to_ath_ratio`：held-out Δρ **0.153**（唯一明确过 36.4 噪声地板 0.064 的），权重 18.1，摆幅只有 22.2
- `chip_analysis.above_below_ratio`：held-out Δρ **0.023**（不到地板的三分之一），权重 36.8，摆幅 **45.0 = 分母的 45%**

**证据最强的因子摆幅最小，证据最弱的因子摆幅最大。** 这是第 10 节诊断清单第 2 条
（"弱因子权重过高"）的教科书案例，机制还是 36.6 第 1 条那个：
`autoWeights ∝ interval.score = (wilsonLo/base)×√coverage`，小正类下系统性偏好宽窗，
而 `above_below_ratio` 的核心区盖住 90% 的样本，正是最宽的那种。

同时它也是 22.1% 同分块的主要成因：90% 的样本在它身上拿满分，它对这些样本**只贡献分母不贡献区分**
（第 31 节那段注释刚订正过的"勇者常数因子 = 真正的稀释"）。
`modalShare ≈ 90%` 正好压在 `NEAR_DEGENERATE_HIT_SHARE` 软线上 —— **去 UI 上确认一下有没有挂准常数提醒**。

推荐路径里 12 步的 held-out Δρ 排下来更能说明问题：
0.153 / 0.110 / 0.063 / 0.044 / 0.026 / 0.023 / 0.014 / 0.006 / 0.005 / 0.005 / 0.004 / 0.003 ——
**只有前两步明确过地板，第三步刚好压线，之后全是噪声量级**。
而后向剔除把第 2 步（`avg_sell_amount`，Δρ 0.110，全路径第二强）丢掉了，
留下的四个里有三个 Δρ 在地板上或以下。

### 42.4 这套策略是【排除型】不是【选择型】

cutoff=60 的 lift 1.18 全部来自砍掉底部，不是选出顶部：

- 第 1+2 档（分数 22.8~56.9，n=145）：高倍率 **9.0%**（13/145），lift 0.42 —— 这一段是真信号，而且很强
- 第 10 档（n=73）：20.5%，lift 0.96 —— 等于没筛

**结论：这个池子可靠地识别"不要买什么"，但识别不出"最该买什么"。**
所以 cutoff 该按"排除多少底部"来定，不该幻想靠拉高阈值买到更好的：

- **推荐 cutoff = 74**（触发 314、命中 26.8%、lift 1.26、捕获 54%）—— 全表最佳，且在同分块之上还有余量
- **绝对不要用 78 以上**（85 个 lift 1.11、69 个 lift 0.95）
- cutoff=60 只有排除底部的价值（触发 543、lift 1.18），开仓能力大时用它

### 42.5 一个要盯但暂不动的信号：`gmgn_price_to_ath_ratio` 连续三段 test AUC 高于 train

walk-forward 第 3 节归因表里，它在第 1/2/3 段的 test AUC 是 **0.650 / 0.615 / 0.675**，
对应 train 只有 0.554 / 0.540 / 0.528 —— 连续三段 test 高出 +0.10~0.15，第 4/5 段才回到 ±0.02。

36.7 坑 #2 写过"**见到 test 明显高于 train，第一反应查泄漏**"。这次查下来倾向于**不是泄漏**：

- 定义在 [data.js:1163](src/lib/data.js)：`price.price / ath_price`，两个都取自买入时刻抓的 GMGN 快照
- 真是泄漏的话 train AUC 也该被抬起来，但 train 只有 0.53~0.55

更可能是诊断清单第 2 条那种情况：这几段验证集正类只有 7~10 个，AUC 方差极大。
**但方向连续三段一致这点跟"纯噪声"不太像**，记在这里，下一轮样本变多之后回来复查。

### 42.6 顺带订正 36.5 里 `holder_fomo_ratio` 那条

上一节写进否决清单时用的是"lift = 1.00、train 边际ρ 为负"，**这两个数字跟本轮导出对不上**：
实际是 lift **1.16**（全表并列最高）、边际ρ test **0.094** / train **0.184**（比值 0.51，过 36.4 的 0.4 门槛）。
已把那两条理由删掉。

**订正后它的处境反而更尴尬**：统计上它是全表最强的候选之一（AUC 0.601 最高、唯一过 BH 校正、lift 并列最高），
否掉它**只剩业务判断这一条理由**（追高散户 = 热度代理）。
既然是纯人工判定，就该跟 `☠signal_open_mcap` 一样**进黑名单**，
而不是指望哪个指标能自动拦住它 —— 靠指标拦是拦不住的，这次数字对不上就是证据。

### 42.7 下一步（按性价比）

1. **删 `holder_gini`(☠)**：lift 1.00、94.9% 同命中度、22.5 分摆幅几乎全用在把 40 个缺失样本顶到顶档。
   删完是纯勇者 3 因子池（Σ勇者 44.9，没有 36.3 那个纯邪恶池死角）。**重点不是看 ρ 动不动**
   （准常数邪恶因子 ≈ 平移，ρ 本来就不该大动），**是看第 10 档还塌不塌、cutoff 80 那一段还是不是 0.95**。
2. **压 `above_below_ratio` 的权重或直接删**：Δρ 0.023、摆幅占分母 45%。
   ⚠️ 别用「按 ρ 最优配权」（原字段轮实测 held-out 0.202→0.193、0.346→0.288），
   手动改权重也要记得 walk-forward 每段重新 autoWeights（37.3），全样本改了不等于 walk-forward 跟着改。
3. **cutoff 从 60 改到 74**（见 42.4）。
4. **把 `holder_fomo_ratio` 加进黑名单**（42.6）。

## 43. 删掉 `holder_gini` 之后：顶档修好了，但 walk-forward 破线 —— 兼论那条判据的分辨率（2026-07-30）

执行 42.7 第 1 项的结果。纯勇者 3 因子池，Σ勇者仍是 **81.7**（gini 是邪恶，本来就不进分母）。

### 43.1 逐项对账

| 口径 | 42 轮（4 因子，带 gini） | **43 轮（3 因子，删 gini）** | |
| --- | --- | --- | --- |
| ρ | **0.228** | 0.204 | ❌ 掉 0.024 |
| 最佳 cutoff 的 lift | 1.26 @74（触发 314） | **1.28 @84（触发 458）** | ✅ 更高**且**触发更多 |
| **顶部反转** | 段10 20.5%（<基准）· cut80 lift **0.95** | 最高档 cut100 lift **1.16**，全程不破 1.0 | ✅ **修好了** |
| walk-forward 五段 test lift | 1.05/1.30/1.14/1.13/1.44（均值 1.21，全 ≥1.0） | 1.00/1.15/1.19/**0.96**/1.61（均值 1.18） | ❌ 第 4 段破线 |
| 第 8 节 val lift | 1.44（train 1.15） | **1.61**（train 1.18） | ✅ |
| 基线库整体命中率 | 25.7%（lift 1.13） | **28.3%（lift 1.24）** | ✅ |
| 基线库四天 lift | 1.16/1.20/1.31/1.60 | **1.28/1.32/1.27/2.00** | ✅ 四天全面更好 |
| 同分饱和 | 22.1% @77.5（中部） | 27.2% @**100.0**（顶部） | ❌ 更大，且移到顶部 |

**42.2 的诊断被证实了**：饱和块从 161 涨到 198，多出来的 **37 个 ≈ gini 缺失的 40 个**。
那批"数据缺失白捡 22.5 分"的样本，删掉 gini 之后回落，跟大部队并成了同一个 100 分块。

### 43.2 我的建议：采用 3 因子版

实盘真正吃的是触发集，这一列 3 因子版严格占优：**458 触发 / 27.3% / lift 1.28**
对 **314 触发 / 26.8% / lift 1.26** —— 触发多 46%、命中率还更高。
再加上基线库四天全面变好（最接近"换一批数据还灵不灵"的口径），以及顶部反转消失。

ρ 掉 0.024 是真的，但这正是 36.4 第 5 条 / 诊断清单第 5 条那个"ρ vs lift@cutoff 打架"，
只是方向反过来：**ρ 由灰点驱动，实盘买的是顶部薄片**。这次是 ρ 让步、薄片变好。

### 43.3 但那条 walk-forward 判据的分辨率，比它假装的粗得多

36.4 第 3 条写的是"五段 test lift 全部 ≥1.0 才算站住"，第 4 段 0.96 按字面就是不达标。
**这是同一段第二次破线**（37.3 那次是 0.99），值得把这条线本身算一遍账：

第 4 段：test n=43、正类 **7** 个、基准 16.3%、触发 32。
命中 5 个 → 15.6% → lift **0.96**；命中 6 个 → 18.8% → lift **1.15**。

**一个样本的差别 = 0.19 的 lift。** 也就是说这条"≥1.0"的线在正类 7 个的段上，
分辨率只有 ±0.19，而我们拿它做的是二元的采信/否决判定。
37.3 已经吐槽过一次（"0.99 差 1.0 只有 0.01，落在噪声里 —— 但那条线是硬的"），
这次是第二次撞上，可以下结论了：**这条判据在正类个位数的段上不该当硬闸用**。

**改判据（下一轮起用）**：

1. 看**五段均值**（更稳）：37 轮 1.22 / 42 轮 1.21 / **43 轮 1.18** —— 三轮基本持平，43 轮没有真的塌
2. 看有没有段**明确 <0.9**（超出单样本抖动范围的才算真衰减）：43 轮**没有**
3. 原来那条"任一段 <1.0 即否"降级成提醒，不再当闸门

按新判据 43 轮通过；按旧判据不通过。**这个分歧本身就是判据该改的证据** ——
它让"顶档从 lift 0.95 修到 1.16"这个明确的改进，被一个 5 个 vs 6 个样本的差别否掉。

### 43.4 顶档没有被"解决"，只是从垫底变成了持平

别高兴太早。198 个样本（**27.2%**）拿的都是 100 分，第 7 节的 8/9/10 三档基本全在这个块里：

段8 28.8% · 段9 24.7% · 段10 23.3% —— **合起来 219 个、25.6%、lift 1.20**，
段间差异全是随机切分的产物。cutoff 100 单独看：198 触发、24.7%、lift **1.16**。

所以现状是：**顶部 27% 的样本，池子给不出任何区分，整体只有 1.16 的 lift**。
比 42 轮"顶档全是缺失样本、lift 0.95"诚实，但信息量仍然接近零。

**根因是三个因子都是同一种形状。** 看它们各自饱和了多少样本：

| 因子 | 核心区 | 满命中样本数 | 那批样本的命中率 |
| --- | --- | --- | --- |
| `chip_analysis.above_below_ratio` | [0.1082, ∞) | ~655（90%） | — |
| `gmgn_price_to_ath_ratio` | [0.7381, ∞) | **501（69%）** | **21.8% = 基准** |
| `gmgn.wallet_tags_stat.fresh_wallets` | [61, ∞) | — | — |

`price_to_ath` 是全池 Δρ 最高的因子（0.153），但推荐路径第 1 步的样本内分档摆得很清楚：
它的区分力**全在下面那 227 个样本上**（命中率从 9.1% 一路爬到 40%），
对上面 501 个（69%）一视同仁，而那 501 个的命中率正好等于基准 21.8%。

**三个因子都是"低值扣分"的单边斜坡，核心区各自盖住大半样本。**
这不是某一个因子的毛病，是这个池子的共同形状 —— 也就是 42.4 那句"排除型不是选择型"的机制层解释。
诊断清单第 3 条对顶部饱和开的方子是"加邪恶因子拉开"，但我们刚删掉唯一的邪恶因子；
真正的出路是它最后半句：**换维度不同的因子**。

### 43.5 cutoff 建议 82 而不是 84：lift 看不见 208x

漏网之鱼第一行：`looong` 得分 **83.3**、倍数 **208.35x** —— 全样本最大的赢家，差 **0.7 分**没进触发集。

第 7 节段4（分数 80.4~85.4）就是它所在的段：高倍率只有 21.9%（全表中游），
但**倍数均值 5.75x 和倍数中位 2.05x 都是全表最高**。被一个 208x 拉起来的均值不必当真，
**中位数 2.05x 是硬的** —— 这一段的典型样本收益比顶上任何一段都好。

**cutoff 84 正好把段4 劈成两半。** 两个口径给出的最佳段不一样：
按高倍率是段5（32.9%），按倍数中位是段4（2.05x）。

| cut | 触发 | 命中率 | lift | 备注 |
| --- | --- | --- | --- | --- |
| 80 | 511 | 25.8% | 1.21 | |
| **82** | **492** | **26.2%** | **1.23** | 接住 83.3 分那个 208x |
| 84 | 458 | 27.3% | **1.28** | 净超额命中数最大（工具默认选它） |

**建议 82。** 用 0.05 的 lift 换整个段4 的下半段，而 lift 的口径缺陷正在这里：
它按">3x 与否"二元计数，**一个 208x 和一个 3.1x 在 lift 里完全等重**，
但在实盘 PnL 里前者顶后者几十单。这是 lift@cutoff 的固有盲区，
之前几轮 cutoff 都是照 lift 挑的，**这一条以后每轮都该看一眼倍数中位那列再定**。

### 43.6 下一步：补维度，不要再调这三个

顶部 27% 的样本在现有三个因子上全饱和 —— **调权重、拉宽梯形都动不了它们**
（第 4 节自己也算过：拆干净同分块 ρ 只涨 0.002）。只能加维度。

池里现在覆盖的三个维度：位置（`price_to_ath`）、持有人结构（`fresh_wallets`）、筹码形态（`above_below_ratio`）。
**K线量能** 和 **订单流** 两个维度完全空白（36.7 那张表里列过的五个维度，占了两个）。

按 边际ρ(test)/边际ρ(train) 比值筛（36.4 第 1 条，注意 37.5 的池子依赖修正 —— 只当粗筛）：

| 候选 | 维度 | 边际ρ test/train | 比值 | AUC | lift |
| --- | --- | --- | --- | --- | --- |
| `gmgn_liquidity_change_ratio` | 可交易性（新） | 0.132 / 0.113 | **0.86** ✅ | 0.544 | 1.09 |
| `smart_money_net_buy_count` | 订单流·聪明钱（新） | 0.111 / 0.212 | 0.52 ✅ | 0.553 | 1.10 |
| `kline_volume_cv` | K线量能（新） | 0.103 / **0.012** | 8.6 ⚠️ | 0.518 | 1.01 |

前两个值得试，**`kline_volume_cv` 别碰** —— train 只有 0.012、test 却 0.103，
比值大于 1 是 36.7 坑 #2 那个反直觉信号的同族形态，更可能是 test 集上的偶然。

加因子时的检查顺序（这一轮学到的）：
① 它在那 198 个满分样本内部**能不能分开**（不能分开就是白加）→ ② 五段均值 + 有没有 <0.9 → ③ 倍数中位那列 → ④ ρ。

## 44. 产品改造：让工具给「判决」而不是「证据」（2026-07-30）

### 44.0 回退点

改造前的状态已固化：commit **`acfc1aa`**，tag **`factor-lab-v1`**（771 测试 / build 通过）。
出问题直接回退：

```bash
git reset --hard factor-lab-v1
```

### 44.1 起因：用户说"推荐的字段没法直接拿来用"

回看 42/43 两轮，每一轮的收尾都是同一个动作 —— **人拿着 5 份报告交叉手算**出三五条结论：

- 摆幅 = 权重/Σ勇者×100（42.2 那张表）
- 满命中样本数、饱和块由哪几个因子拼出来（77.5 那个算式）
- 缺失样本被顶到哪一档（35+40≈73）
- 顶档 lift 是不是 <1（翻 cutoff 扫描表跟十分位表比对）

**这些手算全是固定套路。** 工具给了一堆正确的数字，但把"这些数字合起来意味着什么"留给了人 ——
所以推荐出来的字段拿不起来：不是推荐错了，是**没人告诉你它进池之后会干什么**。

还有一条更根本的：**推荐器在优化 ρ，决策却用 cutoff。**
43 轮是活证据 —— ρ 掉 0.024，而 lift@cutoff / 基线库四天 / 顶档全面变好。
**按 ρ 贪心推出来的因子，天生不是给 cutoff 用的。**

### 44.2 新增 `factorDiagnostics.js`（8 个纯函数 + 29 条测试）

| 函数 | 回答什么 | 固化的是哪次手算 |
| --- | --- | --- |
| `factorInfluence` | 摆幅 / 满命中占比 / 有效区分样本数 | 42.2、43.4 |
| `rhoNoiseFloor` + `splitPathByNoiseFloor` | 推荐路径该采纳前几步 | 43.3 |
| `weightEvidenceAlignment` | 权重跟证据是否反着来 | 42.3 |
| `topBinHealth` | 顶档 lift / 饱和块 / 高分段反转 | 42.1、43.4 |
| `missingImpact` | 缺失样本白得还是白失分、被打到哪一档 | 42.2 |
| `enrichSweepWithReturns` + `nearCutoffOutliers` | lift 看不见的倍数大小 | 43.5 |
| `leaveOneOutFactors` | 逐个删因子会怎样 | 42.7 第 1 项 |
| `makeTopLiftScorer` / `resolveObjective` | 第二个贪心目标 | 43.6 |

三个实现上的关键决定：

1. **噪声地板现算，不写死。** 36.4 第 2 条的 0.064 只对 n≈218 成立，实际是
   `1/√(n_test−3)`（spearman ρ 的标准误）。换切分比例、换样本量它就该跟着动。
2. **路径必须按【前缀】切。** 第 5 步的 Δρ 是"在前 4 步基础上"的增量 ——
   摘掉第 3 步之后那个数就不成立了。所以不能逐步过滤，更不能跳过噪声步去捡后面某个高的。
   `adoptCount=0`（连第一步都在噪声里）是有意义的结论，不是出错。
3. **留一法三条纪律写死在实现里**：不重新配权（否则"删因子"和"权重变了"混成一个变量）、
   cutoff 每次重新推荐（删邪恶因子等于给分数加常数，沿用旧 cutoff 测的是阈值漂移）、
   同时报 ρ / lift@cutoff / 顶档 lift 三个口径（它们在 42→43 轮打过架）。

### 44.3 UI 改动

| 位置 | 改了什么 |
| --- | --- |
| 因子权重表 | 新增 **摆幅 / 满命中 / 有效n** 三列，可排序；摆幅 ≥33.3 标橙、满命中 ≥90% 标橙 |
| **因子体检卡片**（新） | 权重↔证据对齐（含"最刺眼的一对"点名）· 缺失按阵营 · 一键留一法 |
| 回测卡片 | **顶档体检** 常驻告警（顶档 lift<1 / 高分段反转 / 饱和块）；**临界大鱼**告警（cutoff 下方 3 分内的 ≥10x） |
| 因子推荐 / 全字段贪心 | 按噪声地板**灰掉**噪声步 + 顶部"建议只采纳前 N 步"横幅 |
| 因子推荐 | 新按钮「⚖️ 按顶档 lift 再搜一条做对照」，两条路径的重合字段标蓝 |
| 导出报告 | 因子池表补三列；新增 **8.5 节因子体检**；cutoff 扫描表补**倍数中位**列 + 大鱼行；推荐路径报告加噪声地板建议 |

### 44.4 第二目标（顶档 lift）为什么是"对照"而不是替代

`recommendFactorPath` / `recommendFactorPool` 新增 `opts.objective`（`'rho'` 默认 / `'topLift'`）。

- **传字符串不传函数**：贪心跑在 Worker 里，函数过不了 `structuredClone`。
  所以 `makeTopLiftScorer` 放在 `factorLab.js`（`factorDiagnostics` 已经 import 了它，反向会成循环依赖），
  `factorDiagnostics` re-export 一份保持心智模型。
- **换目标必须换 `minGain`**：ρ 的增量量级 0.003、lift 是 0.05，沿用 0.003 等于没有下限。
  `resolveObjective` 一并给出建议值。
- **只影响选字段那一步**：收尾的精配权 / 影子权重 / K折 k\* 仍然全按 ρ 算 ——
  那三件套的判据（1-SE、train/test ρ 落差）都是围绕 ρ 定的，混着换会得到一份自相矛盾的报告。
- **显式 `scoreFn` 仍然优先**，既有调用方（测试 / `heldOutFactorCurve`）行为不变，有测试守着。
- 返回值带回 `objective`，UI/报告不能靠猜 `deltaTest` 是 Δρ 还是 Δlift。

**两条路径的重合度本身就是证据**：重合的字段最可信；零重合 = ρ 和实盘决策在这批数据上指向完全不同的字段。

### 44.5 顺手修的三个真 bug（都是测试抓出来的）

1. **`leaveOneOutFactors` 的排序有 NaN 陷阱**：`b.dRho - a.dRho` 在 dRho 为 NaN 时返回 NaN，
   被 `Array#sort` 当 0 处理 → 顺序未定义。改成显式沉底 + 字段名兜底（同
   `finalizeAucScan` / `recommendFactorPath` 的可复现顺序约定）。
2. **`utils.spearman` 对全常数输入返回 `0` 而不是 `NaN`**。所以"删剩下的池子人人同分"
   不能靠 ρ 是不是 NaN 来判 —— 0 看起来像"测出来没关系"，实际是"根本没得测"，
   混在一起会让它被当成"删了无损"。改成直接数不同分值的个数，单独标 `degenerate`。
3. **`buildRecommendPathReport` 会崩**：原来守了 `buckets` 却没守 `zigzag`。
   导出器崩掉的代价是整份报告都拿不到，比缺一行锯齿统计严重得多。

还有一个差点埋进去的：报告图例里写死一个 `⚠️` 图例行，会让"报告中出现 ⚠️"恒为真 ——
而既有测试正是拿这个当"没有凭空报警"的不变量。改成**只在真有因子命中时才输出图例**。
（这条值得单记：**静态图例会废掉基于告警符号的断言**。）

### 44.6 验证

- 771 → **808 个测试全通过**（新增 29 条 `factor-diagnostics.test.js` + 8 条报告导出）
- `vite build` 通过
- 既有行为的等价性有测试守着：`objective` 默认值跟不传时逐位一致、显式 `scoreFn` 优先、
  没有 `rows`/`nTest` 时新列退回 `-` 且不报警

### 44.7 没做的（明确留下）

- **`recommendFactorPool` 的收尾三件套仍然只按 ρ**（见 44.4），topLift 路径拿不到精配权和 k\*。
- **缺失口径没改**。邪恶阵营下"缺失记 0 分 = 奖励"这条不对称是真问题，但它必须跟
  `onlineExport` 保持一致（[factorLab.js:1389](src/lib/factorLab.js)），单改 review 侧会让
  回测分数和线上分数分叉。现在的处理是**把它显性化**（报出白得多少分、被打到哪个分位），
  由人决定删因子；要真改得两边一起改，属于口径变更不是 bug 修复。
- **walk-forward 的判据没动**。43.3 论证过"任一段 <1.0 即否"在正类个位数的段上分辨率只有 ±0.19，
  建议改成看五段均值 + 有没有段明确 <0.9 —— 但那会改变历史结论的可比性，留给下一轮决定。
