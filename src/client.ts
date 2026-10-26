import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { Card, Game, Message, Player, PlayerProfile } from './protocol.js'
import { playerProfileSchema, publicProfile, requireOwned, visibleGame } from './protocol.js'
import { hasMultiPut, isValidPutCard } from './rules.js'

type Pending =
    | { kind: 'putMethod'; options: { title: string; value: number }[]; cards: Card[] }
    | { kind: 'cards'; options: Card[]; count: number }

export class GameClient {
    private socket?: WebSocket
    private changes = new EventEmitter()
    private game?: Game
    private players: Player[] = []
    private uid = ''
    private name = ''
    private chatMessages: { id: number; from: string; msg: string }[] = []
    private chatSequence = 0
    private ownId?: number
    private observer = false
    private joined = false
    private pending?: Pending
    private responded = new Set<string>()
    private busy = false
    private uncertain = false
    private expected = new Set<string>()
    private lastError?: string
    private events: { revision: number; type: string; error?: string }[] = []
    revision = 0

    constructor(private readonly actionTimeout = 5000) {}

    private publish(type: string, error?: string) {
        this.revision++
        this.events.push({ revision: this.revision, type, ...(error ? { error } : {}) })
        this.events = this.events.slice(-40)
        this.changes.emit('change', type)
    }

    private receive(message: Message) {
        if (message.type === 'ping') {
            this.send({ type: 'pong' })
            return
        }
        if (message.type === 'msg') {
            if (typeof message.from !== 'string' || typeof message.msg !== 'string') return
            this.chatMessages.push({
                id: ++this.chatSequence,
                from: message.from.slice(0, 128),
                msg: message.msg.slice(0, 2000)
            })
            this.chatMessages = this.chatMessages.slice(-100)
            this.publish('msg')
            return
        }
        if (['pong', 'pingResult', 'firstCard'].includes(message.type)) return
        if (message.type === 'hello') {
            this.joined = true
            this.observer = false
        }
        if (message.type === 'observer') {
            this.joined = true
            this.observer = true
            this.ownId = undefined
        }
        if (Array.isArray(message.player)) this.players = message.player
        if (message.type === 'join' && message.playerId === this.uid) this.ownId = message.id
        if (message.game && Array.isArray(message.game.players)) {
            const game = message.game as Game
            if (!this.observer) this.ownId = game.players.find((player) => player.id === this.uid)?.internalId
            // Strip leaked private data immediately, including direct unmasked responses.
            this.game = {
                stage: { round: game.stage.round, playerIndex: game.stage.playerIndex, operate: game.stage.operate },
                players: game.players.map((player) => ({
                    id: player.id,
                    internalId: player.internalId,
                    name: player.name,
                    profile: publicProfile(player.profile),
                    score: player.score,
                    ready: player.ready,
                    offline: player.offline,
                    hand: {
                        cards:
                            player.internalId === this.ownId
                                ? (player.hand?.cards ?? [])
                                : (player.hand?.cards ?? []).map(() => ({ id: 'JOK', color: 2 }))
                    },
                    stored: player.stored
                })),
                allCards: { cards: game.allCards.cards.map(() => ({ id: 'JOK', color: 2 })) },
                pinnedCard: game.pinnedCard,
                lastDiscard: game.lastDiscard,
                lastOperatedCards: game.lastOperatedCards,
                allShown: game.allShown
            }
        }
        if (
            [
                'start',
                'takeGame',
                'next',
                'cha',
                'drawCard',
                'discardCard',
                'calc',
                'calcDone',
                'gameOver',
                'putCardDone'
            ].includes(message.type)
        ) {
            this.pending = undefined
        }
        if (
            ['start', 'takeGame', 'next', 'cha', 'discardCard', 'calc', 'calcDone', 'gameOver'].includes(message.type)
        ) {
            this.responded.clear()
        }
        if (message.type === 'optSelect') {
            this.pending = {
                kind: 'putMethod',
                cards: message.orgData.cards,
                options: message.selections.map((option: { title: string; value: number }) => ({
                    title: option.title,
                    value: option.value
                }))
            }
        }
        if (message.type === 'putCardSelect') {
            this.pending = { kind: 'cards', options: message.selection, count: message.count }
        }
        if (message.type === 'gameOver') {
            this.players = this.game?.players ?? this.players
            this.game = undefined
        }
        if (message.type === 'error') {
            this.lastError = String(message.msg ?? '服务端拒绝操作')
            this.responded.clear()
        }
        if (message.type === 'setProfile') {
            for (const player of [...this.players, ...(this.game?.players ?? [])]) {
                if (player.internalId === message.id) player.profile = publicProfile(message.profile)
            }
        }
        if (
            (this.expected.has(message.type) && (message.type !== 'setProfile' || message.id === this.ownId)) ||
            message.type === 'error'
        ) {
            this.uncertain = false
            this.expected.clear()
        }
        this.publish(message.type, message.type === 'error' ? this.lastError : undefined)
    }

    private send(message: Message) {
        if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('尚未连接游戏服务器')
        this.socket.send(JSON.stringify(message))
    }

    async join(url: string, room: string, name: string, playerId: string = randomUUID()) {
        if (this.busy) throw new Error('上一项操作尚未结束，请等待其返回后再连接')
        if (this.socket) throw new Error('已有连接，请先 leave_game；重连时使用原 playerId')
        const parsed = new URL(url)
        if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('地址必须使用 ws:// 或 wss://')
        this.uid = playerId
        this.name = name
        this.chatMessages = []
        this.game = undefined
        this.players = []
        this.ownId = undefined
        this.observer = false
        this.joined = false
        this.pending = undefined
        this.responded.clear()
        this.uncertain = false
        this.expected.clear()
        this.lastError = undefined
        this.events = []
        const socket = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 1024 * 1024 })
        this.socket = socket
        socket.on('message', (data) => {
            if (this.socket !== socket) return
            try {
                const message = JSON.parse(data.toString())
                if (!message || typeof message.type !== 'string') throw new Error('无效消息')
                this.receive(message)
            } catch {
                this.lastError = '服务端消息格式不兼容，连接已关闭'
                this.publish('protocolError', this.lastError)
                socket.close()
            }
        })
        socket.on('error', (error) => {
            if (this.socket !== socket) return
            this.lastError = error.message
            this.publish('connectionError', error.message)
        })
        socket.on('close', () => {
            if (this.socket !== socket) return
            this.socket = undefined
            this.joined = false
            this.publish('disconnected')
        })
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('open', resolve)
                socket.once('error', reject)
                socket.once('close', () => reject(new Error('连接已关闭')))
            })
            const result = this.waitUntil(() => this.joined && (this.observer || this.ownId !== undefined), 10000)
            this.send({ type: 'reg', group: room, id: playerId, name })
            await result
            if (!this.joined || (!this.observer && this.ownId === undefined))
                throw new Error(this.lastError ?? '加入房间超时')
            return this.state()
        } catch (error) {
            this.leave()
            throw error
        }
    }

    leave() {
        const socket = this.socket
        this.socket = undefined
        this.joined = false
        this.pending = undefined
        this.game = undefined
        this.players = []
        this.chatMessages = []
        this.ownId = undefined
        this.uncertain = false
        this.expected.clear()
        this.responded.clear()
        socket?.close()
        if (socket) {
            const timer = setTimeout(() => socket.terminate(), 1000)
            timer.unref()
            socket.once('close', () => clearTimeout(timer))
        }
        this.publish('disconnected')
        return this.state()
    }

    private availableActions(): string[] {
        if (!this.joined || this.observer || this.busy || this.uncertain) return []
        if (this.pending) return [this.pending.kind === 'cards' ? 'select_cards' : 'select_put_method']
        if (!this.game) return ['set_ready']
        const game = this.game
        const current = game.players[game.stage.playerIndex]?.internalId === this.ownId
        if (game.stage.operate === 9) return this.me()?.ready ? [] : ['set_ready']
        if (current) {
            if ([2, 8].includes(game.stage.operate)) return ['play_cards', 'draw_card', 'call_calc']
            if (game.stage.operate === 4) return ['play_cards', 'discard_card', 'call_calc']
        } else {
            if (game.stage.operate === 5 && !this.responded.has('cha')) return ['respond_cha']
            if (game.stage.operate === 7 && !this.responded.has('antiCalc')) return ['respond_anti_calc']
        }
        return []
    }

    sendChat(message: string) {
        if (!this.joined) throw new Error('请先加入游戏房间')
        if (!message.trim() || message.length > 2000) throw new Error('聊天内容不能为空，且不能超过 2000 个字符')
        this.send({ type: 'msg', from: this.name, msg: message })
        return { status: 'sent' }
    }

    async setPlayerProfile(revision: number, changes: PlayerProfile) {
        const profile = playerProfileSchema.parse(changes)
        if (!this.joined || this.observer) throw new Error('只有已加入房间的玩家可以修改角色资料')
        if (revision !== this.revision) throw new Error('牌局已更新，请 get_state 后使用新的 revision')
        if (this.busy || this.uncertain) throw new Error('请等待上一项操作确认后再修改角色资料')
        const result = await this.command(
            { type: 'setProfile', profile: { ...publicProfile(this.me()?.profile), ...profile } },
            ['setProfile']
        )
        return {
            ...result,
            ...(profile.name !== undefined
                ? {
                      displayName: this.me()?.name,
                      note: '原版后端仅保存 profile.name，不修改当前角色显示名；加入房间时通过 join_game.name 设置名称。对局中重连同一玩家会保留原显示名。'
                  }
                : {})
        }
    }

    getChatMessages(afterId = 0) {
        return {
            messages: this.chatMessages.filter((message) => message.id > afterId).map((message) => ({ ...message })),
            latestId: this.chatSequence,
            truncated: afterId < (this.chatMessages[0]?.id ?? this.chatSequence + 1) - 1
        }
    }

    private me() {
        return (this.game?.players ?? this.players).find((player) => player.internalId === this.ownId)
    }

    state() {
        return {
            connected: this.socket?.readyState === WebSocket.OPEN,
            joined: this.joined,
            role: this.observer ? 'observer' : 'player',
            playerId: this.uid,
            internalId: this.ownId,
            revision: this.revision,
            chat: this.getChatMessages(),
            awaitingConfirmation: this.busy || this.uncertain,
            lastError: this.lastError,
            availableActions: this.availableActions(),
            pending: this.pending ? structuredClone(this.pending) : undefined,
            game: this.game ? visibleGame(this.game, this.ownId) : undefined,
            lobby: this.game
                ? undefined
                : this.players.map((player) => ({
                      id: player.id,
                      internalId: player.internalId,
                      name: player.name,
                      profile: publicProfile(player.profile),
                      ready: !!player.ready
                  })),
            events: [...this.events]
        }
    }

    private waitUntil(predicate: () => boolean, timeoutMs: number, signal?: AbortSignal) {
        const since = this.revision
        return new Promise<void>((resolve) => {
            const finish = () => {
                clearTimeout(timer)
                this.changes.off('change', check)
                signal?.removeEventListener('abort', cancel)
                resolve()
            }
            const cancel = () => {
                finish()
                // Cancellation is surfaced through the MCP request signal as well.
            }
            const check = () => {
                if (predicate() || !this.socket || (this.lastError && this.revision > since)) finish()
            }
            const timer = setTimeout(finish, timeoutMs)
            this.changes.on('change', check)
            signal?.addEventListener('abort', cancel, { once: true })
            if (signal?.aborted) cancel()
            else check()
        })
    }

    async wait(afterRevision: number, timeoutMs: number, signal?: AbortSignal) {
        await this.waitUntil(() => this.revision > afterRevision, timeoutMs, signal)
        return this.state()
    }

    private check(action: string, revision: number) {
        if (revision !== this.revision) throw new Error('牌局已更新，请 get_state 后使用新的 revision')
        if (!this.availableActions().includes(action))
            throw new Error(`当前不能执行 ${action}，请查看 availableActions`)
        this.lastError = undefined
    }

    private async command(message: Message, expected: string[]) {
        this.busy = true
        this.expected = new Set(expected)
        const before = this.revision
        try {
            const confirmation = this.waitUntil(() => this.expected.size === 0, this.actionTimeout)
            this.send(message)
            await confirmation
            if (this.lastError) throw new Error(this.lastError)
            if (!this.joined) throw new Error('连接中断；操作结果未知，请重连检查状态，不要自动重试')
            if (this.expected.size > 0) {
                this.uncertain = true
                throw new Error('未收到操作确认；已暂停后续操作，请等待事件或重连检查状态，不要重复提交')
            }
            this.busy = false
            this.publish('actionConfirmed')
            return { status: 'confirmed', fromRevision: before, state: this.state() }
        } finally {
            if (this.busy) {
                this.busy = false
                this.publish('actionFinished')
            }
        }
    }

    async ready(revision: number, ready: boolean) {
        this.check('set_ready', revision)
        if (!!this.me()?.ready === ready) return { status: 'unchanged', state: this.state() }
        return this.command({ type: 'ready', ready }, ['ready', 'start', 'next', 'gameOver'])
    }

    async play(revision: number, cards: Card[], putMethod?: 1 | 2) {
        this.check('play_cards', revision)
        this.validatePlay(cards, putMethod)
        return this.command({ type: 'putCard', cards, putMethod }, ['putCardDone', 'putCardSelect', 'optSelect'])
    }

    private validatePlay(cards: Card[], putMethod?: 1 | 2) {
        if (!cards.length) throw new Error('至少选择一张牌')
        requireOwned(this.me()?.hand?.cards ?? [], cards)
        if (putMethod || !hasMultiPut(cards)) {
            isValidPutCard(this.game!, cards, this.me()?.stored, undefined, putMethod === 1)
        }
    }

    async selectMethod(revision: number, value: 1 | 2) {
        this.check('select_put_method', revision)
        const pending = this.pending!
        if (pending.kind !== 'putMethod' || !pending.options.some((option) => option.value === value))
            throw new Error('无效摆牌方式')
        this.validatePlay(pending.cards, value)
        return this.command({ type: 'putCard', cards: pending.cards, putMethod: value }, [
            'putCardDone',
            'putCardSelect'
        ])
    }

    async selectCards(revision: number, cards: Card[]) {
        this.check('select_cards', revision)
        const pending = this.pending!
        if (pending.kind !== 'cards' || cards.length !== pending.count) throw new Error('选择数量不正确')
        requireOwned(pending.options, cards)
        return this.command({ type: 'putCardSelect', selection: cards }, ['putCardSelect', 'putCardDone'])
    }

    async draw(revision: number) {
        this.check('draw_card', revision)
        return this.command({ type: 'draw' }, ['drawCard', 'calcDone'])
    }

    async discard(revision: number, card: Card) {
        this.check('discard_card', revision)
        requireOwned(this.me()?.hand?.cards ?? [], [card])
        return this.command({ type: 'discard', card }, ['discardCard'])
    }

    async calc(revision: number) {
        this.check('call_calc', revision)
        return this.command({ type: 'calc' }, ['calc', 'calcDone'])
    }

    respond(revision: number, type: 'cha' | 'antiCalc', participate: boolean, cards: Card[] = []) {
        this.check(type === 'cha' ? 'respond_cha' : 'respond_anti_calc', revision)
        if (type === 'cha' && participate) {
            if (!cards.length) throw new Error('插牌必须选择手牌')
            requireOwned(this.me()?.hand?.cards ?? [], cards)
            if (!this.game?.lastDiscard) throw new Error('没有可插的弃牌')
            isValidPutCard(this.game, cards, undefined, this.game.lastDiscard)
        }
        this.responded.add(type)
        try {
            this.send({ type, do: participate, ...(type === 'cha' && participate ? { cards } : {}) })
        } catch (error) {
            this.responded.delete(type)
            throw error
        }
        this.publish('responseSent')
        // Server has no per-player acknowledgement; do not claim the response was accepted.
        return { status: 'sent', state: this.state() }
    }
}
