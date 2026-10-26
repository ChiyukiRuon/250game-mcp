import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { GameClient } from '../src/client.js'

const source = resolve(process.env.GAME_SERVER_SOURCE ?? '../250game-server')
const available =
    existsSync(resolve(source, 'modules/gameroom/index.ts')) && existsSync(resolve(source, 'node_modules/ws'))

test(
    'original unmodified upstream: lobby, turns, calc, next round, observer and reconnect',
    { skip: !available, timeout: 20000 },
    async (t) => {
        const child = fork(resolve('test/upstream-host.cts'), [], {
            execArgv: ['-r', resolve(source, 'node_modules/ts-node/register/transpile-only')],
            env: {
                ...process.env,
                GAME_SERVER_SOURCE: source,
                GAME_TEST_ORDERED_DECK: '1',
                TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' })
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        })
        let errors = ''
        child.stderr?.on('data', (data) => {
            errors += data.toString()
        })
        const clients = [new GameClient(), new GameClient(), new GameClient()]
        t.after(() => {
            clients.forEach((client) => client.leave())
            child.kill()
        })
        const port = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Upstream startup timeout: ${errors}`)), 5000)
            child.once('message', (message: any) => {
                clearTimeout(timer)
                resolve(message.port)
            })
            child.once('exit', (code) => {
                clearTimeout(timer)
                reject(new Error(`Upstream exited ${code}: ${errors}`))
            })
        })
        const url = `ws://127.0.0.1:${port}`
        const [a, b, observer] = clients
        async function until(client: GameClient, predicate: () => boolean) {
            const deadline = Date.now() + 3000
            while (!predicate() && Date.now() < deadline) await client.wait(client.revision, 200)
            assert.ok(predicate(), JSON.stringify(client.state()))
        }
        await a.join(url, 'integration', 'AI A', 'a')
        await b.join(url, 'integration', 'AI B', 'b')
        await until(a, () => a.state().lobby?.length === 2)
        await a.ready(a.revision, true)
        await until(b, () => b.state().lobby?.[0].ready === true)
        await b.ready(b.revision, true)
        await until(a, () => !!a.state().game)
        await until(b, () => !!b.state().game)
        assert.equal(a.state().game?.players[0].hand?.length, 6)
        assert.equal(b.state().game?.players[0].hand, undefined)
        await a.play(
            a.revision,
            [0, 1, 2, 3].map((color) => ({ id: 'A', color })),
            2
        )
        await a.discard(a.revision, { id: '2', color: 0 })
        await until(b, () => b.state().availableActions.includes('respond_cha'))
        b.respond(b.revision, 'cha', true, [
            { id: '2', color: 1 },
            { id: '2', color: 2 }
        ])
        await until(b, () => b.state().availableActions.includes('draw_card'))
        await b.draw(b.revision)
        await b.discard(b.revision, b.state().game!.players[1].hand![0])
        await until(a, () => a.state().availableActions.includes('respond_cha'))
        a.respond(a.revision, 'cha', false)
        await until(a, () => a.state().availableActions.includes('call_calc'))
        await a.calc(a.revision)
        await until(b, () => b.state().availableActions.includes('respond_anti_calc'))
        b.respond(b.revision, 'antiCalc', false)
        await until(a, () => a.state().game?.stage.operate === 9)
        await until(b, () => b.state().game?.stage.operate === 9)
        // Settlement is broadcast unmasked upstream, but remains filtered in the MCP client.
        assert.equal(a.state().game?.players[1].hand, undefined)
        await a.ready(a.revision, true)
        await until(b, () => b.state().game?.players[0].ready === true)
        await b.ready(b.revision, true)
        await until(a, () => a.state().game?.stage.operate === 4)
        assert.equal((await observer.join(url, 'integration', 'Observer', 'c')).role, 'observer')
        assert.deepEqual(observer.state().availableActions, [])
        assert.ok(observer.state().game?.players.every((player) => !player.hand))
        b.leave()
        await until(a, () => a.state().game?.players[1].offline === true)
        const rejoined = await b.join(url, 'integration', 'AI B', 'b')
        assert.equal(rejoined.role, 'player')
        assert.equal(rejoined.game?.players[1].offline, false)
        assert.ok(rejoined.game?.players[1].hand)
        assert.equal(rejoined.game?.players[0].hand, undefined)
        if (rejoined.game?.stage.operate === 5) {
            await until(a, () => a.state().availableActions.includes('respond_cha'))
            a.respond(a.revision, 'cha', false)
            await until(a, () => a.state().availableActions.includes('call_calc'))
            await until(b, () => b.state().game?.stage.operate === 2)
        }
        // Finish an entire game, including the >250 condition and return to the lobby.
        for (let round = 0; round < 40 && a.state().game; round++) {
            const current = a.state().game!.stage.playerIndex === 0 ? a : b
            const other = current === a ? b : a
            await until(current, () => current.state().availableActions.includes('call_calc'))
            await current.calc(current.revision)
            await until(other, () => other.state().availableActions.includes('respond_anti_calc'))
            other.respond(other.revision, 'antiCalc', false)
            await until(a, () => a.state().game?.stage.operate === 9)
            await until(b, () => b.state().game?.stage.operate === 9)
            await a.ready(a.revision, true)
            await until(b, () => b.state().game?.players[0].ready === true)
            await b.ready(b.revision, true)
            await until(a, () => !a.state().game || a.state().game?.stage.operate === 4)
        }
        assert.equal(a.state().game, undefined)
        await until(b, () => !b.state().game)
        assert.equal(b.state().game, undefined)
        assert.equal(a.state().lobby?.length, 2)
        assert.equal(errors, '')
    }
)
