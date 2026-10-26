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

## HTTP 部署

除 stdio 外，`dist/http.js` 提供 Streamable HTTP 入口，适合部署到服务器供远程 MCP 客户端使用：

```sh
PORT=3250 BASE_PATH=/250 MCP_AUTH_TOKEN=<随机令牌> node dist/http.js
```

- `PORT`：监听端口，默认 `3250`
- `HOST`：监听地址，默认 `127.0.0.1`，通常由 nginx 反代
- `BASE_PATH`：对外路径前缀，默认 `/250`；同时接受 `/250`、`/250/`、`/250/mcp`
- `MCP_AUTH_TOKEN`：设置后所有 MCP 请求需带 `Authorization: Bearer <令牌>`；`/250/health` 不需要
- `GAME_SERVER_URL`：可选默认游戏地址；未设置时由 `join_game` 的 `url` 参数传入

每个 HTTP 会话拥有独立的游戏连接，多个客户端互不影响。服务器上的 nginx、pm2 配置与新增 MCP 服务的约定见 [部署说明](docs/deployment.md)。

详细说明见 [接入与使用](docs/usage.md)、[实现与验证](docs/implementation.md)。

```sh
npm run build
npm test
npm run format:check
```

`npm test` 默认查找相邻的 `../250game-server` 进行原服务端集成测试；未找到源码或依赖时跳过该项，其他测试仍执行。可通过 `GAME_SERVER_SOURCE` 指定源码目录，详见验证文档。

协议适配基于上游提交 `77372d4202b6344e87697a817a7650fc1182ec21`。本项目移植了上游的摆牌检查函数，许可见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)。
