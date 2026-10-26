# 接入与使用

## 连接游戏

安装依赖并构建后，由 MCP 宿主运行 `node /绝对路径/250game-mcp/dist/index.js`。服务使用 stdio，因此直接在终端运行后等待输入是正常现象；标准输出仅用于 MCP 协议。

通过环境变量 `GAME_SERVER_URL` 设置默认地址，或向 `join_game` 传入 `url`。原服务端默认监听 `19981`，有证书时使用 `wss://`，无证书时使用 `ws://`。线上部署可能使用不同域名、路径或反向代理端口，需要填写实际 WebSocket 地址，不能直接填游戏网页 URL。

`join_game` 参数示例：

```json
{
    "url": "ws://localhost:19981",
    "room": "friends",
    "name": "AI玩家",
    "playerId": "my-ai-player-01"
}
```

省略 `playerId` 会生成 UUID，返回值会提供它。重连应使用原 ID；不要借用其他玩家的 ID。原服务端用 ID 区分玩家，未实现账号认证。

确认返回的 `role` 为 `player`，且大厅人数符合预期后再准备。全员准备会立即开局，服务端没有等待指定人数的设置。开局后新 ID 只能旁观，同 ID 重复连接也可能成为旁观者。

## 决策循环

1. 获取 `get_state`，读取 `availableActions`、`pending`、自己的手牌和 `revision`。
2. 选择当前可执行的动作，并传入同一份状态的 `revision`。
3. 如果返回选牌要求，先完成 `select_put_method` 或 `select_cards`。
4. 没有需要执行的动作时，调用 `wait_for_action`，传入当前 `afterRevision`。一次最多等待 25 秒；超时返回相同版本后可以继续等待。
5. 插牌阶段调用 `respond_cha`，反算阶段调用 `respond_anti_calc`，不参与也要显式传入 `participate: false`。
6. 结算后准备下一轮，直到收到 `gameOver` 并回到大厅。

`availableActions` 表示当前阶段允许使用的工具，不表示每一种牌组合都合法，也不表示应该立即算牌。算牌可能造成包牌惩罚，需要 AI 自行决策。当前实现不枚举全部合法组合；提交摆牌前会使用移植的服务端规则进行检查。

工具结果通常包含状态快照。其他玩家可能在工具返回后继续操作；出现版本过期错误时重新读取状态，不要沿用旧版本。

## 工具

| 工具 | 参数与用途 |
| --- | --- |
| `join_game` | `url?`、`room`、`name?`、`playerId?`，加入或创建房间 |
| `get_state` | 获取当前缓存状态 |
| `wait_for_action` | `afterRevision`、`timeoutMs?`，等待新事件或超时 |
| `set_ready` | `revision`、`ready?`，大厅准备/取消，结算后准备下一轮 |
| `play_cards` | `revision`、`cards`、`putMethod?`，摆牌/补牌；方式 1 为顺子，2 为同点数组 |
| `select_put_method` | `revision`、`value`，响应摆牌方式选择 |
| `select_cards` | `revision`、`cards`，从待选列表选择指定数量的牌 |
| `draw_card` | `revision`，抽牌 |
| `discard_card` | `revision`、`card`，弃牌 |
| `respond_cha` | `revision`、`participate`、`cards?`，插牌或放弃；牌列表不含桌面的弃牌 |
| `call_calc` | `revision`，发起算牌 |
| `respond_anti_calc` | `revision`、`participate`，反算或放弃 |
| `leave_game` | 断开连接；游戏中服务端会托管离线玩家 |

牌使用原协议的 `{ "id": "7", "color": 0 }` 表示。`id` 为 A、2～10、J、Q、K 或 JOK；`color` 是服务端数值编码，应直接使用手牌中的值。不要自行猜测花色对应关系。

还提供 `game250://instructions` 资源，包含模型使用说明。该说明也通过 MCP 初始化的 instructions 返回。

## 状态与操作确认

- `revision`：本地状态版本，发生游戏事件、发送插牌/反算响应或操作等待结束时递增；心跳不会递增。
- `availableActions`：允许立即提交的动作；旁观、断线、等待确认时为空。
- `pending`：摆牌方式或王牌替代牌选择，必须先处理。
- `awaitingConfirmation`：存在尚未确认的操作，不能继续提交变更。
- `events`：最近 40 个事件的类型和错误摘要，不包含原始牌局数据。
- `game.players[].hand`：只在自己的玩家对象中出现；其他玩家只有手牌数量。
- `game.deckCount`：剩余牌数，不提供牌堆内容。

普通变更会等待相关服务端事件，默认 5 秒。超时后工具报错，并暂停后续变更，避免重复出牌；迟到的确认事件会解除暂停。服务端没有请求 ID，关联只能依靠事件类型，因此不要在其他连接中同时控制同一玩家。

插牌与反算没有逐人确认消息，工具返回 `status: sent` 仅表示已发送。该阶段会禁止重复响应，服务端最终结果或错误通过后续状态更新返回。

## 断线和限制

不会自动重连或自动放弃插牌，以免静默改变玩家决策。连接中断后，用原 `playerId` 再次调用 `join_game`；仍持有连接时先调用 `leave_game`。断线期间服务端托管可能已经出牌，必须重新读取状态。

原协议没有查询完整状态或恢复所有待选项的接口。特别是王牌选择进行中断线，重连快照可能不包含待选项，不能保证恢复。客户端可以过滤收到的隐藏信息，但无法修复服务端向其他客户端泄露数据的问题。

单个 MCP 进程维护一个玩家连接。多个 AI 玩家应使用多个进程和不同 `playerId`。本项目提供 stdio 接口，不提供 HTTP MCP 托管服务，也不绑定某一家模型供应商。
