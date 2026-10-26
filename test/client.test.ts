import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { GameClient } from '../src/client.js'
import type { Game, Message } from '../src/protocol.js'

function game(): Game {
    return {
        stage: { round: 0, playerIndex: 0, operate: 4 },
        players: [
            {
                id: 'ai',
                internalId: 1,
                name: 'AI',
                hand: {
                    cards: [
                        { id: 'A', color: 0 },
                        { id: 'A', color: 1 },
                        { id: 'JOK', color: 0 }
                    ]
                },
                stored: { cards: [] }
            },
            {
                id: 'human',
                internalId: 2,
                name: 'Human',
                hand: { cards: [{ id: 'K', color: 3 }] },
                stored: { cards: [] }
            }
        ],
        allCards: { cards: [{ id: 'Q', color: 2 }] },
        pinnedCard: [],
        allShown: { cards: [] },
        lastOperatedCards: { cards: [] }
    }
}

async function fixture(t: test.TestContext, handle?: (message: Message, socket: WebSocket) => void, timeout = 500) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await once(wss, 'listening')
    let peer: WebSocket
    const received: Message[] = []
    wss.on('connection', (socket) => {
        peer = socket
        socket.on('message', (data) => {
            const message = JSON.parse(data.toString())
            received.push(message)
            if (message.type === 'reg') {
                socket.send(JSON.stringify({ type: 'hello' }))
                socket.send(JSON.stringify({ type: 'join', id: 1, playerId: 'ai', player: game().players }))
            } else handle?.(message, socket)
        })
    })
    const client = new GameClient(timeout)
    t.after(async () => {
        client.leave()
        for (const socket of wss.clients) socket.terminate()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
    })
    await client.join(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, 'test', 'AI', 'ai')
    return {
        client,
        received,
        async push(message: Message) {
            const before = client.revision
            peer!.send(JSON.stringify(message))
            await client.wait(before, 500)
        },
        peer: () => peer!
    }
}

test('compact state and incremental events retain only the latest 40 summaries', async (t) => {
    const f = await fixture(t)
    const before = f.client.revision
    for (let i = 0; i < 41; i++) await f.push({ type: 'msg', from: 'Human', msg: `message ${i}` })
    const state = f.client.state()
    assert.equal('events' in state, false)
    assert.equal('chat' in state, false)
    assert.equal(state.latestChatId, 41)
    assert.equal(f.client.getChatMessages(40).messages[0].msg, 'message 40')
    const history = f.client.getEvents(before)
    assert.equal(history.events.length, 40)
    assert.equal(history.truncated, true)
    assert.equal(history.latestRevision, state.revision)
    assert.equal(f.client.getEvents(state.revision - 1).events.length, 1)
    assert.equal(f.client.getEvents(state.revision - 40).truncated, false)
    assert.deepEqual(f.client.getEvents(state.revision).events, [])
    history.events[0].type = 'mutated'
    assert.equal(f.client.getEvents().events[0].type, 'msg')
})

test('settlement retains score changes through next round and game over without private data', async (t) => {
    const f = await fixture(t)
    const settled = game()
    settled.stage.operate = 9
    settled.players[0].score = 260
    settled.players[1].score = 20
    await f.push({ type: 'calcDone', game: settled, player: 1, antiCalc: [2], res: [60, 0], secret: 'hidden' })
    const result = f.client.state().lastSettlement!
    assert.deepEqual(result, {
        revision: f.client.revision,
        gameOver: false,
        calcPlayerId: 1,
        antiCalcPlayerIds: [2],
        players: [
            { id: 'ai', internalId: 1, name: 'AI', score: 260, delta: 60 },
            { id: 'human', internalId: 2, name: 'Human', score: 20, delta: 0 }
        ]
    })
    result.players[0].score = -1
    await f.push({ type: 'next', game: game() })
    assert.equal(f.client.state().lastSettlement?.players[0].score, 260)
    await f.push({ type: 'gameOver', game: settled })
    assert.equal(f.client.state().game, undefined)
    assert.equal(f.client.state().lastSettlement?.gameOver, true)
    assert.equal(f.client.state().lastSettlement?.players[0].delta, 60)
    await f.push({ type: 'start', game: game() })
    assert.equal(f.client.state().lastSettlement, undefined)
    await f.push({ type: 'calcDone', game: settled, player: -1, res: [0, 0] })
    assert.equal(f.client.state().lastSettlement?.calcPlayerId, -1)
    assert.deepEqual(f.client.state().lastSettlement?.antiCalcPlayerIds, [])
    assert.equal(f.client.leave().lastSettlement, undefined)
})

test('game over without a cached settlement exposes only final scores', async (t) => {
    const f = await fixture(t)
    await f.push({ type: 'gameOver', game: game() })
    assert.equal(f.client.state().lastSettlement?.gameOver, true)
    assert.equal(f.client.state().lastSettlement?.players[0].delta, undefined)
    assert.equal('hand' in f.client.state().lastSettlement!.players[0], false)
})

test('profile updates preserve other fields, validate inputs and wait for own broadcast', async (t) => {
    const f = await fixture(
        t,
        (message, socket) => {
            if (message.type === 'setProfile') socket.send(JSON.stringify({ ...message, id: 2 }))
        },
        50
    )
    await f.push({
        type: 'setProfile',
        id: 1,
        profile: { name: 'Existing', back: 'https://example.com/old.png', secret: 'hidden' }
    })
    await assert.rejects(f.client.setPlayerProfile(f.client.revision, {}))
    await assert.rejects(f.client.setPlayerProfile(f.client.revision, { back: 'javascript:alert(1)' }))
    await assert.rejects(f.client.setPlayerProfile(f.client.revision - 1, { name: 'New' }), /牌局已更新/)
    await assert.rejects(f.client.setPlayerProfile(f.client.revision, { back: '' }), /未收到操作确认/)
    assert.equal(f.client.state().awaitingConfirmation, true)
    assert.deepEqual(f.received.at(-1), { type: 'setProfile', profile: { name: 'Existing', back: '' } })
    await f.push({ type: 'setProfile', id: 1, profile: { name: 'Existing', back: '' } })
    assert.equal(f.client.state().awaitingConfirmation, false)
    assert.deepEqual(f.client.state().lobby?.[0].profile, { name: 'Existing', back: '' })
    await f.push({ type: 'observer' })
    await assert.rejects(f.client.setPlayerProfile(f.client.revision, { name: 'New' }), /只有已加入/)
})

test('chat sends upstream protocol, wakes waiters, bounds history and clears on leave', async (t) => {
    const f = await fixture(t, (message, socket) => {
        if (message.type === 'msg') socket.send(JSON.stringify(message))
    })
    const before = f.client.revision
    assert.deepEqual(f.client.sendChat('你好'), { status: 'sent' })
    await f.client.wait(before, 500)
    assert.deepEqual(f.client.getChatMessages().messages, [{ id: 1, from: 'AI', msg: '你好' }])
    assert.deepEqual(f.received.at(-1), { type: 'msg', from: 'AI', msg: '你好' })
    assert.throws(() => f.client.sendChat('  '), /不能为空/)
    assert.throws(() => f.client.sendChat('x'.repeat(2001)), /2000/)
    const cursor = f.client.getChatMessages().latestId
    for (let i = 0; i < 101; i++) await f.push({ type: 'msg', from: 'Human', msg: String(i), game: game() })
    const history = f.client.getChatMessages(cursor)
    assert.equal(history.messages.length, 100)
    assert.equal(history.truncated, true)
    assert.equal(f.client.state().game, undefined)
    history.messages[0].msg = 'mutated'
    assert.equal(f.client.getChatMessages().messages[0].msg, '1')
    assert.deepEqual(f.client.getChatMessages(history.latestId).messages, [])
    f.client.leave()
    assert.deepEqual(f.client.getChatMessages().messages, [])
    assert.throws(() => f.client.sendChat('hello'), /先加入/)
})

test('filters full private snapshots and responds to heartbeat without changing revision', async (t) => {
    const f = await fixture(t)
    const raw = game() as Game & { secret: string }
    raw.secret = 'SECRET'
    await f.push({ type: 'start', game: raw })
    const state = f.client.state()
    assert.equal(state.game?.players[0].hand?.length, 3)
    assert.equal(state.game?.players[1].hand, undefined)
    assert.equal(state.game?.players[1].handCount, 1)
    assert.equal(state.game?.deckCount, 1)
    assert.ok(!JSON.stringify(state).includes('SECRET'))
    assert.ok(!JSON.stringify(state).includes('"id":"Q"'))
    assert.ok(!JSON.stringify(state).includes('"id":"K"'))
    const before = f.client.revision
    f.peer().send(JSON.stringify({ type: 'ping' }))
    await once(f.peer(), 'message')
    assert.equal(f.received.at(-1)?.type, 'pong')
    assert.equal(f.client.revision, before)
})

test('rejects stale revisions, wrong hand cards and duplicate response without sending', async (t) => {
    const f = await fixture(t)
    const snapshot = game()
    await f.push({ type: 'start', game: snapshot })
    const count = f.received.length
    await assert.rejects(f.client.discard(0, { id: 'A', color: 0 }), /已更新/)
    await assert.rejects(f.client.discard(f.client.revision, { id: 'K', color: 3 }), /手牌/)
    assert.equal(f.received.length, count)
    snapshot.stage.operate = 5
    snapshot.stage.playerIndex = 1
    snapshot.lastDiscard = { id: 'A', color: 2 }
    await f.push({ type: 'discardCard', game: snapshot })
    assert.deepEqual(f.client.state().availableActions, ['respond_cha'])
    f.client.respond(f.client.revision, 'cha', false)
    assert.deepEqual(f.client.state().availableActions, [])
    assert.throws(() => f.client.respond(f.client.revision, 'cha', false), /不能执行/)
})

test('multi-step joker choices validate options and resume actions after confirmation', async (t) => {
    const snapshot = game()
    const f = await fixture(t, (message, socket) => {
        if (message.type === 'putCard') {
            socket.send(
                JSON.stringify({
                    type: 'putCardSelect',
                    game: snapshot,
                    selection: [
                        { id: 'A', color: 2 },
                        { id: 'A', color: 3 }
                    ],
                    count: 1
                })
            )
        }
        if (message.type === 'putCardSelect') {
            snapshot.players[0].hand!.cards = []
            socket.send(JSON.stringify({ type: 'putCardDone', game: snapshot }))
        }
    })
    await f.push({ type: 'start', game: snapshot })
    await f.client.play(f.client.revision, snapshot.players[0].hand!.cards, 2)
    assert.deepEqual(f.client.state().availableActions, ['select_cards'])
    await assert.rejects(f.client.selectCards(f.client.revision, [{ id: 'K', color: 0 }]), /手牌/)
    const response = await f.client.selectCards(f.client.revision, [{ id: 'A', color: 2 }])
    assert.equal(response.status, 'confirmed')
    assert.equal(response.state.awaitingConfirmation, false)
    assert.ok(response.state.availableActions.includes('call_calc'))
    assert.equal(response.state.pending, undefined)
})

test('silent server leaves action uncertain; late confirmation unlocks it', async (t) => {
    const f = await fixture(t, undefined, 30)
    await f.push({ type: 'start', game: game() })
    await assert.rejects(f.client.discard(f.client.revision, { id: 'A', color: 0 }), /未收到操作确认/)
    assert.equal(f.client.state().awaitingConfirmation, true)
    assert.deepEqual(f.client.state().availableActions, [])
    const snapshot = game()
    snapshot.stage.operate = 5
    await f.push({ type: 'discardCard', game: snapshot })
    assert.equal(f.client.state().awaitingConfirmation, false)
})

test('waiting detects new state, times out, cancels and wakes on disconnect', async (t) => {
    const f = await fixture(t)
    const before = f.client.revision
    assert.equal((await f.client.wait(before, 10)).revision, before)
    const controller = new AbortController()
    const cancelled = f.client.wait(before, 20000, controller.signal)
    controller.abort()
    await cancelled
    const waiting = f.client.wait(before, 500)
    f.peer().close()
    assert.equal((await waiting).connected, false)
})

test('a previous server error does not cause wait polling to spin', async (t) => {
    const f = await fixture(t)
    await f.push({ type: 'error', msg: 'Rejected' })
    let settled = false
    const waiting = f.client.wait(f.client.revision, 500).then((state) => {
        settled = true
        return state
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    await f.push({ type: 'start', game: game() })
    assert.ok((await waiting).game)
})

test('put-method choice preserves the original cards and accepts server rejection safely', async (t) => {
    const snapshot = game()
    snapshot.players[0].hand!.cards = [
        { id: '7', color: 0 },
        { id: 'JOK', color: 0 },
        { id: 'JOK', color: 1 }
    ]
    const f = await fixture(t, (message, socket) => {
        if (message.type !== 'putCard') return
        if (!message.putMethod) {
            socket.send(
                JSON.stringify({
                    type: 'optSelect',
                    game: snapshot,
                    orgData: message,
                    selections: [
                        { title: '顺子', value: 1 },
                        { title: '同点数', value: 2 }
                    ]
                })
            )
        } else {
            assert.deepEqual(message.cards, snapshot.players[0].hand!.cards)
            socket.send(JSON.stringify({ type: 'error', msg: 'Test rejection' }))
        }
    })
    await f.push({ type: 'start', game: snapshot })
    await f.client.play(f.client.revision, snapshot.players[0].hand!.cards)
    assert.deepEqual(f.client.state().availableActions, ['select_put_method'])
    await assert.rejects(f.client.selectMethod(f.client.revision, 1), /Test rejection/)
    assert.equal(f.client.state().awaitingConfirmation, false)
    assert.deepEqual(f.client.state().availableActions, ['select_put_method'])
})
