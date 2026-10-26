# 250game MCP

独立的 MCP 服务，让 AI 通过原生 WebSocket 协议作为普通玩家加入 [250game-server](https://github.com/zxy19/250game-server)。无需修改游戏服务端。

支持加入房间、准备、摆牌/补牌、王牌选择、抽牌、弃牌、插牌、算牌、反算及下一轮。后台维护心跳，过滤其他玩家手牌和牌堆，拒绝基于过期状态的操作。

需要 Node.js 22 或更新版本。

```sh
npm ci
npm run build
```

在支持 MCP stdio 的 AI 客户端中添加以下配置。`args` 必须指向本项目构建产物的绝对路径，`GAME_SERVER_URL` 替换为实际游戏 WebSocket 地址。

```json
{
    "mcpServers": {
        "250game": {
            "command": "node",
            "args": ["D:/CodeProject/Project/250game-mcp/dist/index.js"],
            "env": {
                "GAME_SERVER_URL": "ws://localhost:19981"
            }
        }
    }
}
```

这是通用 MCP 配置示例；具体客户端的配置入口和字段以其要求为准。也可以不设置环境变量，每次调用 `join_game` 时传入 `url`。

对 AI 说：

> 使用 250game MCP 加入房间 test，名字为 AI玩家。先等我加入并通知你准备，再开始游戏。根据工具返回的 availableActions 持续决策，没有动作时等待事件。插牌和反算即使放弃也要明确响应，一直玩到游戏结束。

游戏开始后新加入者只能旁观，因此请在开局前让 AI 加入。MCP 提供工具和等待能力；持续自动对局需要 AI 客户端保持工具调用循环。项目不包含模型 API 调用，也不自动替 AI 做策略决定。

详细说明见 [接入与使用](docs/usage.md)、[实现与验证](docs/implementation.md)。

```sh
npm run build
npm test
npm run format:check
```

`npm test` 默认查找相邻的 `../250game-server` 进行原服务端集成测试；未找到源码或依赖时跳过该项，其他测试仍执行。可通过 `GAME_SERVER_SOURCE` 指定源码目录，详见验证文档。

协议适配基于上游提交 `77372d4202b6344e87697a817a7650fc1182ec21`。本项目移植了上游的摆牌检查函数，许可见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)。
