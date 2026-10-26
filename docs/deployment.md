# 部署说明

本文记录 `mcp.chiyukiruon.top` 的部署结构，以及在同一个域名下新增其他 MCP 服务的约定。

## 结构

nginx 终止 TLS，按路径前缀转发到各自只监听 `127.0.0.1` 的 MCP 进程；进程由 pm2 以 `www` 用户托管。

| 对外路径 | pm2 名称 | 本地端口 | 目录 |
| --- | --- | --- | --- |
| `/250` | `250game-mcp` | `3250` | `/www/wwwroot/250game-mcp` |

- nginx 站点：`/etc/nginx/sites-available/mcp.chiyukiruon.top.conf`
- 公共反代片段：`/etc/nginx/snippets/mcp-proxy.conf`
- 进程配置：`/www/wwwroot/250game-mcp/ecosystem.config.cjs`（含令牌，权限 `600`）
- 证书：通配符 `*.chiyukiruon.top`，复用 `/etc/nginx/ssl/chiyukiruon.top/fullchain.pem`

每个 HTTP 会话在 MCP 进程内创建独立的 `GameClient`；多个客户端连接同一个路径互不影响。

## 250game-mcp 的运行参数

```sh
HOST=127.0.0.1
PORT=3250
BASE_PATH=/250
MCP_AUTH_TOKEN=<随机 32 字节十六进制>
# GAME_SERVER_URL 未设置：由客户端在 join_game 时传 url
```

`/250/health` 不需要令牌，返回 `{"ok":true,...}`，可用于探活。其余请求需 `Authorization: Bearer <令牌>`。

令牌保存在 `ecosystem.config.cjs` 的 `env.MCP_AUTH_TOKEN` 中。查看：

```sh
sudo -n grep -o 'MCP_AUTH_TOKEN: .*' /www/wwwroot/250game-mcp/ecosystem.config.cjs
```

## 更新与发布

在本地构建并同步源码（排除 `node_modules`、`dist`、`.git`）：

```sh
tar czf /tmp/250game-mcp.tar.gz --exclude=node_modules --exclude=dist --exclude=.git \
    package.json package-lock.json tsconfig.json src test docs README.md LICENSE THIRD-PARTY-NOTICES .prettierrc.json
scp -o BatchMode=yes /tmp/250game-mcp.tar.gz chiyukiruon.top:/tmp/
```

在服务器上：

```sh
sudo -n -u www -H bash -c 'cd /www/wwwroot/250game-mcp && tar xzf /tmp/250game-mcp.tar.gz'
sudo -n -u www -H bash -c 'cd /www/wwwroot/250game-mcp && npm ci && npm run build'
sudo -n -u www -H bash -c 'export PATH=/usr/local/bin:/usr/bin:$PATH; pm2 restart 250game-mcp --update-env'
```

`npm ci` 使用服务器已配置的腾讯云镜像。`ecosystem.config.cjs` 不在压缩包内，更新不会覆盖令牌。

## nginx 站点

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name mcp.chiyukiruon.top;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name mcp.chiyukiruon.top;

    ssl_certificate     /etc/nginx/ssl/chiyukiruon.top/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/chiyukiruon.top/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers EECDH+CHACHA20:EECDH+AES128:RSA+AES128:EECDH+AES256:RSA+AES256:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_tickets off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    add_header Strict-Transport-Security "max-age=31536000";

    client_max_body_size 8m;

    access_log /var/log/nginx/mcp.chiyukiruon.top.log;
    error_log  /var/log/nginx/mcp.chiyukiruon.top.error.log;

    location ~ ^/250(/|$) {
        proxy_pass http://127.0.0.1:3250;
        include snippets/mcp-proxy.conf;
    }

    location / {
        return 404;
    }
}
```

`/etc/nginx/snippets/mcp-proxy.conf`：

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

`proxy_buffering off` 保证 SSE 事件即时下发；超时时间覆盖 `wait_for_action` 的 25 秒长轮询。

## 新增其他 MCP 服务

1. 选一个未占用端口（从 `3251` 起），确认：`sudo -n ss -tln | grep ':3251 '`。
2. 部署到 `/www/wwwroot/<服务名>`，设置 `HOST=127.0.0.1`、`PORT=<端口>`、`BASE_PATH=/<服务名>`，在 pm2 中用独立名称启动并 `pm2 save`。
3. 在同一个 nginx server 块中加一段：

   ```nginx
   location ~ ^/<服务名>(/|$) {
       proxy_pass http://127.0.0.1:<端口>;
       include snippets/mcp-proxy.conf;
   }
   ```

4. `sudo -n nginx -t && sudo -n systemctl reload nginx`。
5. 访问 `https://mcp.chiyukiruon.top/<服务名>/health` 探活，再按服务自身的鉴权方式配置客户端。

路径前缀由各服务自行处理（`BASE_PATH`），nginx 不剥离；这样日志和 MCP 会话标识里的路径保持一致。
