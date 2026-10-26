import { z } from 'zod'

export const cardSchema = z.object({
    id: z.enum(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'JOK']),
    color: z.number().int().min(0).max(3)
})

export type Card = z.infer<typeof cardSchema> & { real?: Card }
export const playerProfileSchema = z
    .object({
        name: z.string().trim().min(1).max(64).optional(),
        back: z
            .string()
            .max(4096)
            .refine((value) => {
                if (value === '') return true
                try {
                    return ['http:', 'https:'].includes(new URL(value).protocol)
                } catch {
                    return false
                }
            }, '头像必须是 http:// 或 https:// 图片地址，空字符串表示清除')
            .optional()
    })
    .refine((value) => value.name !== undefined || value.back !== undefined, '至少提供名称或头像')
export type PlayerProfile = { name?: string; back?: string }
export function publicProfile(profile?: PlayerProfile): PlayerProfile {
    return {
        ...(typeof profile?.name === 'string' ? { name: profile.name.slice(0, 64) } : {}),
        ...(typeof profile?.back === 'string' ? { back: profile.back.slice(0, 4096) } : {})
    }
}
export interface Deck {
    cards: Card[]
}
export interface Player {
    id: string
    internalId: number
    name: string
    profile?: PlayerProfile
    score?: number
    ready?: boolean
    offline?: boolean
    hand?: Deck
    stored?: Deck
}
export interface Game {
    stage: { round: number; playerIndex: number; operate: number }
    players: Player[]
    allCards: Deck
    pinnedCard: Card[]
    lastDiscard?: Card
    lastOperatedCards?: Deck
    allShown?: Deck
}
export type Message = Record<string, any>
export const stages: Record<number, string> = {
    1: 'ROUND_START',
    2: 'PUTCARD',
    3: 'DRAWCARD',
    4: 'DISCARD',
    5: 'WAIT_CHA',
    6: 'DO_CHA',
    7: 'CALC',
    8: 'AFTER_CHA',
    9: 'SCORE'
}
export const sameCard = (a: Card, b: Card) => a.id === b.id && a.color === b.color

export function requireOwned(hand: Card[], cards: Card[]) {
    const remaining = [...hand]
    for (const card of cards) {
        const index = remaining.findIndex((candidate) => sameCard(candidate, card))
        if (index < 0) throw new Error('所选牌不在手牌中，或重复选择了同一张牌')
        remaining.splice(index, 1)
    }
}

// Explicit allowlist: never expose an arbitrary server game object or event payload.
function publicCard(card: Card): Card & { real?: Card; from?: number } {
    const source = card as Card & { real?: Card; from?: number }
    return {
        id: source.id,
        color: source.color,
        ...(source.real ? { real: { id: source.real.id, color: source.real.color } } : {}),
        ...(source.from !== undefined ? { from: source.from } : {})
    }
}

export function visibleGame(game: Game, ownId?: number) {
    return {
        stage: {
            round: game.stage.round,
            playerIndex: game.stage.playerIndex,
            operate: game.stage.operate,
            name: stages[game.stage.operate]
        },
        players: game.players.map((player) => ({
            id: player.id,
            internalId: player.internalId,
            name: player.name,
            profile: publicProfile(player.profile),
            score: player.score,
            ready: player.ready,
            offline: player.offline,
            handCount: player.hand?.cards.length ?? 0,
            ...(player.internalId === ownId ? { hand: player.hand?.cards.map(publicCard) ?? [] } : {}),
            stored: player.stored?.cards.map(publicCard) ?? []
        })),
        deckCount: game.allCards.cards.length,
        pinnedCards: game.pinnedCard.map(publicCard),
        lastDiscard: game.lastDiscard ? publicCard(game.lastDiscard) : undefined,
        discards: game.lastOperatedCards?.cards.map(publicCard) ?? [],
        shownCards: game.allShown?.cards.map(publicCard) ?? []
    }
}
