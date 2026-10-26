import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { StreamableHTTPServerTransport as HttpTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { GameClient } from './client.js'
import { createServer } from './server.js'

type Session = {
    transport: StreamableHTTPServerTransport
    server: McpServer
    client: GameClient
}

const port = Number(process.env.PORT ?? 3250)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT 无效: ${process.env.PORT}`)

const host = process.env.HOST ?? '127.0.0.1'
const basePath = normalizeBasePath(process.env.BASE_PATH ?? '/250')
const authToken = process.env.MCP_AUTH_TOKEN?.trim() || undefined
const maxBodyBytes = 1024 * 1024

// 同时接受 /250、/250/ 和 /250/mcp，客户端填哪个都能用
const mcpPaths = new Set([`${basePath}/mcp`])
if (basePath) {
    mcpPaths.add(basePath)
    mcpPaths.add(`${basePath}/`)
}
const healthPath = `${basePath}/health`

const sessions = new Map<string, Session>()

function normalizeBasePath(value: string) {
    const trimmed = value.trim()
    if (!trimmed || trimmed === '/') return ''
    return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).replace(/\/+$/, '')
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
    const data = JSON.stringify(body)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', Buffer.byteLength(data))
    res.end(data)
}

function sendError(res: ServerResponse, status: number, code: number, message: string) {
    sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null })
}

function applyCors(res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Game-Server-Url'
    )
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
}

function isAuthorized(req: IncomingMessage) {
    if (!authToken) return true
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return false
    const provided = Buffer.from(header.slice('Bearer '.length))
    const expected = Buffer.from(authToken)
    return provided.length === expected.length && timingSafeEqual(provided, expected)
}

async function readJsonBody(req: IncomingMessage) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        size += buffer.length
        if (size > maxBodyBytes) throw new Error('请求体过大')
        chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) throw new Error('请求体为空')
    return JSON.parse(text) as unknown
}

function sessionIdOf(req: IncomingMessage) {
    const header = req.headers['mcp-session-id']
    return typeof header === 'string' && header ? header : undefined
}

async function createSession(defaultGameServerUrl?: string) {
    const { server, client } = createServer(undefined, defaultGameServerUrl)
    let session: Session | undefined
    const transport = new HttpTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, { transport, server, client })
        }
    })
    transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
        try {
            client.leave()
        } catch (error) {
            console.error('[250game-mcp] 关闭游戏连接失败:', error)
        }
    }
    await server.connect(transport)
    session = { transport, server, client }
    return session
}

async function handle(req: IncomingMessage, res: ServerResponse) {
    applyCors(res)

    if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname

    if (pathname === healthPath && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, { ok: true, sessions: sessions.size, uptime: process.uptime() })
        return
    }

    if (!isAuthorized(req)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="250game-mcp"')
        sendError(res, 401, -32001, 'Unauthorized')
        return
    }

    if (!mcpPaths.has(pathname)) {
        sendError(res, 404, -32001, 'Not Found')
        return
    }

    const sessionId = sessionIdOf(req)

    if (req.method === 'POST') {
        let body: unknown
        try {
            body = await readJsonBody(req)
        } catch (error) {
            if (error instanceof SyntaxError) {
                sendError(res, 400, -32700, 'Parse error')
            } else {
                sendError(res, 400, -32600, error instanceof Error ? error.message : 'Invalid request')
            }
            return
        }

        let session = sessionId ? sessions.get(sessionId) : undefined
        if (!session && sessionId) {
            sendError(res, 404, -32001, 'Session not found')
            return
        }
        if (!session) {
            if (!isInitializeRequest(body)) {
                sendError(res, 400, -32600, '缺少 Mcp-Session-Id，且请求不是 initialize')
                return
            }
            const gameServerHeader = req.headers['x-game-server-url']
            const defaultGameServerUrl = typeof gameServerHeader === 'string' ? gameServerHeader.trim() : undefined
            if (gameServerHeader !== undefined) {
                try {
                    if (!defaultGameServerUrl) throw new Error('empty URL')
                    const parsed = new URL(defaultGameServerUrl)
                    if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('invalid protocol')
                } catch {
                    sendError(res, 400, -32600, 'X-Game-Server-Url 必须是有效的 ws:// 或 wss:// 游戏后端地址')
                    return
                }
            }
            session = await createSession(defaultGameServerUrl)
        }
        await session.transport.handleRequest(req, res, body)
        return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
        const session = sessionId ? sessions.get(sessionId) : undefined
        if (!session) {
            sendError(res, 404, -32001, 'Session not found')
            return
        }
        await session.transport.handleRequest(req, res)
        return
    }

    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS')
    sendError(res, 405, -32000, 'Method Not Allowed')
}

const httpServer = createHttpServer((req, res) => {
    void handle(req, res).catch((error) => {
        console.error('[250game-mcp] 请求处理失败:', error)
        if (res.headersSent) {
            res.destroy()
            return
        }
        sendError(res, 500, -32603, 'Internal error')
    })
})

let shuttingDown = false
async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[250game-mcp] 收到 ${signal}，关闭 ${sessions.size} 个会话`)
    for (const session of sessions.values()) {
        try {
            session.client.leave()
        } catch (error) {
            console.error('[250game-mcp] 关闭游戏连接失败:', error)
        }
        await session.transport.close().catch((error) => console.error('[250game-mcp] 关闭会话失败:', error))
    }
    sessions.clear()
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

httpServer.listen(port, host, () => {
    const auth = authToken ? 'bearer token required' : 'no auth (MCP_AUTH_TOKEN 未设置)'
    const address = httpServer.address()
    const listeningPort = address && typeof address === 'object' ? address.port : port
    console.log(`[250game-mcp] HTTP 监听 http://${host}:${listeningPort}${basePath || '/'}（${auth}）`)
})
