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
