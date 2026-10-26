// Run the original server classes on an ephemeral port without editing upstream files.
const { resolve } = require('node:path')
const source = process.env.GAME_SERVER_SOURCE
if (!source) throw new Error('GAME_SERVER_SOURCE is required')
// Deterministic deals for integration assertions only; upstream source remains untouched.
if (process.env.GAME_TEST_ORDERED_DECK === '1') Math.random = () => 0
const WSS = require(resolve(source, 'modules/wss/index.ts')).default
const RoomManager = require(resolve(source, 'modules/roommgr/index.ts')).default
const wss = new WSS(0)
new RoomManager(wss)
wss.wss.on('listening', () => {
    process.send?.({ port: wss.wss.address().port })
})
