设置步骤：

1.策略触发方式：信号触发
2. 信号类型：回调反弹

import.txt 可以直接导入策略。已经与code 同步


止盈止损设置，推荐方案：

设置：允许一个代币允许同一个代币同时持有多笔仓位（反复加仓）

止损在50% 守住成本线以下 跌破成本线20%就止损，回来回继续买入

v29:增加筹码检测，必须要下面筹码占多数。

v30:
 新增"前10持有占比"限制：gmgn.stat.top_10_holder_rate（原始0-1小数×100转%）< 30。
 新增"创建者持仓"限制：gmgn.stat.creator_hold_rate（原始0-1小数×100转%）< 0.5。
 新增"top_rat_trader占比"限制：gmgn.stat.top_rat_trader_percentage（原始0-1小数×100转%）< 1。
 新增"dev团队持仓"限制：gmgn.stat.dev_team_hold_rate（原始0-1小数×100转%）< 1。

