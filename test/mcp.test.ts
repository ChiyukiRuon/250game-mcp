import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { createServer } from '../src/server.js'

test('MCP discovery, resources, tool result and input errors over protocol transport', async (t) => {
    const { server, client: game } = createServer()
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    t.after(async () => {
        game.leave()
        await client.close()
        await server.close()
    })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    assert.equal(tools.tools.length, 16)
    assert.ok(tools.tools.some((tool) => tool.name === 'respond_cha'))
    assert.ok(tools.tools.some((tool) => tool.name === 'send_chat'))
    const chat = await client.callTool({ name: 'get_chat_messages', arguments: {} })
    assert.deepEqual(JSON.parse((chat.content as any)[0].text).messages, [])
    const emptyChat = await client.callTool({ name: 'send_chat', arguments: { message: '  ' } })
    assert.equal(emptyChat.isError, true)
    const disconnectedChat = await client.callTool({ name: 'send_chat', arguments: { message: 'hello' } })
    assert.equal(disconnectedChat.isError, true)
    const state = await client.callTool({ name: 'get_state', arguments: {} })
    assert.equal(JSON.parse((state.content as any)[0].text).connected, false)
    const failure = await client.callTool({
        name: 'discard_card',
        arguments: { revision: 0, card: { id: 'A', color: 0 } }
    })
    assert.equal(failure.isError, true)
    const rules = await client.readResource({ uri: 'game250://instructions' })
    assert.ok('text' in rules.contents[0] && rules.contents[0].text.includes('WAIT_CHA'))
})

test('compiled entry point serves actual stdio MCP without stdout noise', async (t) => {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve('.test-build/src/index.js')],
        stderr: 'pipe'
    })
    const client = new Client({ name: 'stdio-test', version: '1.0.0' })
    t.after(async () => {
        await client.close()
    })
    await client.connect(transport)
    assert.equal((await client.listTools()).tools.length, 16)
    const response = await client.callTool({ name: 'get_state', arguments: {} })
    assert.equal(response.isError, undefined)
    assert.equal(JSON.parse((response.content as any)[0].text).connected, false)
})
