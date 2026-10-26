import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketServer } from 'ws'

test('HTTP defaults are optional, isolated per session, validated and overridable', async (t) => {
    const backends = await Promise.all(
        [0, 1, 2].map(async () => {
            const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
            await once(server, 'listening')
            const rooms: string[] = []
            server.on('connection', (socket) => {
                socket.on('message', (data) => {
                    const message = JSON.parse(data.toString())
                    if (message.type !== 'reg') return
                    rooms.push(JSON.stringify(message))
                    socket.send(JSON.stringify({ type: 'hello' }))
                    socket.send(JSON.stringify({ type: 'join', id: 1, playerId: message.id, player: [] }))
                })
            })
            t.after(async () => {
                for (const socket of server.clients) socket.terminate()
                await new Promise<void>((done) => server.close(() => done()))
            })
            return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, rooms }
        })
    )
    const child = spawn(process.execPath, [resolve('.test-build/src/http.js')], {
        env: {
            ...process.env,
            PORT: '0',
            HOST: '127.0.0.1',
            BASE_PATH: '/250',
            MCP_AUTH_TOKEN: '',
            GAME_SERVER_URL: backends[2].url
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    t.after(() => {
        child.kill()
    })
    const endpoint = await new Promise<string>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('HTTP startup timed out')), 10000)
        child.once('error', reject)
        child.stdout.on('data', (data) => {
            const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+\/250/)
            if (match) {
                clearTimeout(timer)
                done(match[0])
            }
        })
    })
    const connect = async (url?: string) => {
        const client = new Client({ name: 'http-test', version: '1.0.0' })
        const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
            requestInit: { headers: url === undefined ? {} : { 'X-Game-Server-Url': url } }
        })
        t.after(async () => {
            await client.close()
        })
        await client.connect(transport)
        return client
    }
    await assert.rejects(connect('https://example.com'), /X-Game-Server-Url/)
    const a = await connect(backends[0].url)
    const b = await connect(backends[1].url)
    const fallback = await connect()
    for (const client of [a, b, fallback]) {
        const result = await client.callTool({ name: 'join_game', arguments: { room: 'default' } })
        assert.equal(result.isError, undefined)
    }
    assert.deepEqual(
        backends.map((backend) => backend.rooms.length),
        [1, 1, 1]
    )
    await a.callTool({ name: 'leave_game', arguments: {} })
    const overridden = await a.callTool({ name: 'join_game', arguments: { room: 'override', url: backends[1].url } })
    assert.equal(overridden.isError, undefined)
    assert.deepEqual(
        backends.map((backend) => backend.rooms.length),
        [1, 2, 1]
    )
})
