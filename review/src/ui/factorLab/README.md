FactorLab 前端 worker 使用说明

目的
- 把`computeHeldOutDeltaRho`等耗时候选评估任务卸载到 Web Worker，避免主线程卡顿。

主要文件
- `recommendWorker.js` — ESM worker 脚本，接收批量候选并返回每条候选的 `result` 或 `error`。
- `workerPool.js` — 简单的 Worker 池，支持并发、分批、取消 (`AbortSignal`) 与进度回调 (`onProgress`)。
- `FactorRecommendCard.jsx` — UI 集成范例：按下“算推荐”时把整条 `recommendFactorPool`（选字段贪心 + 精配权 + K折曲线）交给 worker 跑，无 Worker/失败时兜底回主线程直算。
  （2026-07-29 起不再有 `evaluateCandidatesWithWorkers` 那道候选预评估——贪心内部本来就会跳过评估不出来的候选，那是纯重复的全量计算。）
  卡片里的**黑名单**（`lib/factorBlacklist.js`）通过 `opts.blacklist` 随 payload 一起进 worker，无需额外协议。

API 摘要

evaluateCandidatesWithWorkers(rows, currentFactors, candidates, opts)
- rows: 样本数组（目前以序列化传输为主）
- currentFactors: 当前已选因子数组（可为空）
- candidates: 候选因子数组（会被分批发送到 worker）
- opts: 可选字段
  - concurrency: 并发 worker 数（默认 4）
  - batchSize: 每个任务批大小（默认 8）
  - signal: `AbortSignal`，用于取消正在进行的评估
  - onProgress: 回调函数，接收 `{ completed, total }`

返回值: Promise -> 成功项数组，元素形如 `{ field, camp, result }`。
错误条目会被收集到内部 `errors`，不会抛出整个任务失败（worker 返回的每条错误会以 `{ field, camp, error }` 形式记录）。

快速本地调试

1. 启动 dev 服务器：
```bash
cd review
npm run dev
```
2. 在浏览器打开 `http://localhost:5175/`（端口可能递增），打开包含 `FactorRecommendCard` 的页面。
3. 触发“算推荐”，观察 UI 的进度条、网络/控制台日志以及结果 chips 的交互。

注意与优化方向
- 当前实现将 `rows` 完整序列化并发送至 worker，若样本量大建议改为：
  - 只传索引和共享只读数据，或
  - 在 worker 初始化时传一次只读副本，后续只发候选元数据。

- 错误隔离策略：单个候选抛错不会中断整批评估，会在结果中以 `error` 字段报告。

维护者备注
- 如果需要把这套逻辑迁移到 Node（后台批处理），建议使用 `worker_threads` 并保留相同的批量/取消/进度契约以便前后端行为一致。