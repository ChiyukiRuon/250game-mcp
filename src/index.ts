import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

const { server, client } = createServer()
const close = async () => {
    client.leave()
    await server.close()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
process.stdin.once('end', () => client.leave())
await server.connect(new StdioServerTransport())
