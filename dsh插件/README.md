# dsh-auto-idle-compact

一个最小 DSH Host 插件：当某个面向用户的会话**同时**满足以下条件时，自动调用 DSH 自带的压缩引擎（等价于 `/compact`）：

- 最近一轮已正常结束；
- 会话未归档；
- 当前没有后台任务或子 Agent 在运行；
- 已连续闲置达到 `idleSeconds`（默认 1200 秒 = 20 分钟）；
- 当前上下文 token 数**超过** `contextThresholdTokens`（默认 131072 = 128 Ki token）。

同一轮已结束的对话最多自动尝试一次；用户或 Agent 恢复活动会取消尚未完成的定时器/压缩。插件不自行生成摘要，而是使用当前 profile 已挂载的 `compaction` 后端。

## 配置

默认配置写在 `cordis.patch.yml`：

```yaml
- id: auto-idle-compact
  name: 'dsh-auto-idle-compact'
  config:
    idleSeconds: 1200
    contextThresholdTokens: 131072
```

可在当前 Web profile 的 `cordis.patch.yml` 中用相同 `id` 覆盖配置。

## 安装

在 DSH 网页的 **插件 → 添加插件** 中填写本目录的绝对路径：

```text
/home/cygao/WORK/DSH/dsh插件
```

或使用 CLI：

```bash
dsh plugin --profile web add /home/cygao/WORK/DSH/dsh插件
```

安装后启用插件并重启或等待 Web profile 热加载。

## 行为边界

- 只处理非 subagent 的顶层用户会话。
- 跳过 `workspaceRegistry.archivedSessionIds` 中已归档的会话；归档时若定时器或压缩仍在进行，会被立即取消。
- 上下文 token 数来自 DSH 的 `tokenMeter.measure(session).totalTokens`。
- 如果压缩失败或被取消，会记录日志，但不会自动重试同一轮。
- 20 分钟后模型提供方的 KV cache 很可能已经失效，因此摘要请求可能按完整上下文计费。
