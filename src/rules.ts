// Adapted from zxy19/250game-server (MIT), commit 77372d4. See THIRD-PARTY-NOTICES.
import type { Card as ICard, Deck as IDeck, Game as IGame } from './protocol.js'
const CARDS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'JOK']
export function hasMultiPut(cards: ICard[]): boolean {
    let hasCard: ICard | undefined,
        jokerCnt = 0
    for (let i = 0; i < cards.length; i++) {
        if (cards[i].id != 'JOK') {
            if (hasCard) {
                return false
            }
            hasCard = cards[i]
        } else {
            jokerCnt++
        }
    }
    if (!hasCard) return false
    if ((Math.abs(CARDS.indexOf(hasCard.id) - 6) - 1) * 2 + 1 >= jokerCnt) return false
    return true
}
function _isValidPut(
    game: IGame,
    cards: ICard[],
    c: Record<string, number>,
    jokerCnt: number,
    shunziOnly?: boolean
): { n: number; c: string | string[]; color?: number }[] {
    let targetCardId: { n: number; c: string | string[]; color?: number }[] = []
    //case 1:XXX
    if (Object.keys(c).length == 1 && !shunziOnly) {
        if (c[Object.keys(c)[0]] + jokerCnt >= 3) {
            targetCardId.push({ n: jokerCnt, c: Object.keys(c)[0] })
        } else {
            throw new Error('摆牌非法')
        }
    }
    //case 2:56789
    else {
        let left = -1,
            right = -1,
            col = -1
        //花色
        for (let i = 0; i < cards.length; i++) {
            if (cards[i].id == 'JOK') {
                continue
            }
            if (col == -1) {
                col = cards[i].color
            } else if (col != cards[i].color) {
                throw new Error('顺子必须同花色')
            }
        }
        //数量和范围
        for (let i = 0; i < CARDS.length; i++) {
            let card = CARDS[i]
            if (c[card] == 1) {
                if (left == -1) left = i
                if (left != -1) right = i
            } else if (c[card] > 1) {
                throw new Error('顺子不能含有多张牌')
            }
        }
        let cnt = 0
        for (let i = left; i <= right; i++) {
            if ((c[CARDS[i]] ?? 0) == 0) {
                cnt++
            }
        }
        if (cnt > jokerCnt) {
            throw new Error('摆牌非法')
        }
        for (let i = left; i <= right; i++) {
            if ((c[CARDS[i]] ?? 0) == 0) {
                targetCardId.push({ n: 1, c: CARDS[i], color: col })
            }
        }
        while (jokerCnt - cnt > 0) {
            if (6 - left < right - 6) {
                if (left == 0) throw new Error('摆牌非法')
                left--
                targetCardId.push({ n: 1, c: CARDS[left], color: col })
            } else if (6 - left > right - 6) {
                if (right >= CARDS.length - 2) throw new Error('摆牌非法')
                right++
                targetCardId.push({ n: 1, c: CARDS[right], color: col })
            } else if (jokerCnt - cnt == 1) {
                let tc = []
                if (left != 0) tc.push(CARDS[left - 1])
                if (right != CARDS.length - 2) tc.push(CARDS[right + 1])
                if (tc.length == 0) throw new Error('摆牌非法')
                targetCardId.push({ n: 1, c: tc, color: col })
            } else {
                if (left != 0) {
                    left--
                    targetCardId.push({ n: 1, c: CARDS[left], color: col })
                } else if (right != CARDS.length - 2) {
                    right++
                    targetCardId.push({ n: 1, c: CARDS[right], color: col })
                } else throw new Error('摆牌非法')
            }
            cnt++
        }
        /**
         * 5,6,7,8,9=>6
         * 5,6,7,8=>5.5
         * 6,7,8,9=>6.5
         */
        if (Math.abs((left + right) / 2 - 6) >= 1) {
            throw new Error('顺子必须以7为中心')
        }
    }
    return targetCardId
}
function _isValidCha(
    game: IGame,
    cards: ICard[],
    c: Record<string, number>,
    jokerCnt: number,
    additCard: ICard
): { n: number; c: string | string[]; color?: number }[] {
    let targetCardId: { n: number; c: string }[] = []
    //case 1:XXX
    if (Object.keys(c).length == 1) {
        if (c[Object.keys(c)[0]] + jokerCnt >= 3) {
            if (jokerCnt) targetCardId.push({ n: jokerCnt, c: Object.keys(c)[0] })
        } else {
            throw new Error('插牌非法')
        }
    } else {
        throw new Error('摆牌非法')
    }
    return targetCardId
}
function _isValidExt(
    game: IGame,
    cards: ICard[],
    c: Record<string, number>,
    jokerCnt: number,
    stored: IDeck
): { n: number; c: string | string[]; color?: number }[] {
    let targetCardId: { n: number; c: string | string[] }[] = []
    //case 1:XXX
    if (Object.keys(c).length == 1) {
        let cnt = 0
        stored.cards.forEach((card) => {
            let id = card.id
            if (card.real) id = card.real.id
            if (id == Object.keys(c)[0]) cnt++
        })
        if (cnt >= 3) {
            if (jokerCnt) targetCardId.push({ n: jokerCnt, c: Object.keys(c)[0] })
        } else {
            throw new Error('补牌非法')
        }
    } else if (Object.keys(c).length == 0) {
        //补牌，选择的王牌
        let cd: Record<string, number> = {}
        stored.cards.forEach((card) => {
            let id = card.id
            if (id == 'JOK') {
                if (card.real) id = card.real.id
                else return
            }
            cd[id] = (cd[id] || 0) + 1
        })
        let useableCards: string[] = []
        Object.keys(cd).forEach((key) => {
            if (cd[key] >= 3) {
                useableCards.push(key)
            }
        })
        if (jokerCnt) targetCardId.push({ n: jokerCnt, c: useableCards })
    }
    return targetCardId
}

//检查摆牌/插牌合法。返回需要钉的牌的选项
export function isValidPutCard(
    game: IGame,
    cards: ICard[],
    putedCard?: IDeck,
    additCard?: ICard,
    shunzi?: boolean
): { select: ICard[]; count: number }[] {
    let c: Record<string, number> = {}
    let jokerCnt = 0
    cards.forEach((card) => {
        if (card.id == 'JOK') {
            jokerCnt += 1
        } else if (isCardPinned(game, card)) {
            throw new Error('不能摆被钉的牌')
        } else {
            c[card.id] = (c[card.id] || 0) + 1
        }
    })
    if (additCard) {
        if (isCardPinned(game, additCard)) {
            throw new Error('不能插被钉的牌')
        } else if (additCard.id != 'JOK') c[additCard.id] = (c[additCard.id] || 0) + 1
        else throw new Error('王牌不可插')
    }
    let targetCardId: { n: number; c: string | string[]; color?: number }[] = []
    if (additCard) {
        targetCardId = _isValidCha(game, cards, c, jokerCnt, additCard)
    } else if (cards.length <= 2 && putedCard) {
        targetCardId = _isValidExt(game, cards, c, jokerCnt, putedCard)
    } else {
        targetCardId = _isValidPut(game, cards, c, jokerCnt, shunzi)
    }
    let hasPinColor = -1,
        hasPinId = ''
    let ret: { select: ICard[]; count: number }[] = []
    targetCardId.forEach((targetCard) => {
        let _cardId = targetCard.c
        let num = targetCard.n
        let col = targetCard.color
        if (jokerCnt >= num) {
            jokerCnt -= num
            if (typeof _cardId === 'string') {
                _cardId = [_cardId]
            }
            let tmp: { select: ICard[]; count: number } = {
                select: [],
                count: num
            }
            _cardId.forEach((cardId) => {
                let selectColor = [true, true, true, true]
                if (col !== undefined) {
                    for (let i = 0; i < 4; i++) {
                        selectColor[i] = i == col
                    }
                }
                game.allShown?.cards.forEach((card) => {
                    if (cardId == card.id) {
                        selectColor[card.color] = false
                    }
                })
                if (hasPinId == cardId) {
                    selectColor[hasPinColor] = false
                }
                cards.forEach((card) => {
                    if (card.id == cardId) {
                        selectColor[card.color] = false
                    }
                })
                game.pinnedCard.forEach((card) => {
                    if (card.id == cardId) {
                        selectColor[card.color] = false
                    }
                })
                let trueCnt = 0
                selectColor.forEach((flg, idx) => {
                    if (flg) {
                        trueCnt += 1
                    }
                })
                if (trueCnt < num) {
                    throw new Error('摆牌非法')
                }
                selectColor.forEach((flg, idx) => {
                    if (flg) {
                        tmp.select.push({
                            id: cardId as ICard['id'],
                            color: idx
                        })
                    }
                })
            })
            ret.push(tmp)
        } else {
            throw new Error('摆牌非法')
        }
    })
    return ret
}
export function isCardPinned(game: IGame, card: ICard) {
    if (game.pinnedCard) {
        for (let c of game.pinnedCard) {
            if (c.id == card.id && c.color == card.color) {
                return true
            }
        }
    }
    return false
}
