'use strict'

const debug = require('debug')('bfx:hf:data-server')
const _isFunction = require('lodash/isFunction')
const { RESTv2 } = require('bfx-api-node-rest')
const { WSv2 } = require('bitfinex-api-node')
const { nonce } = require('bfx-api-node-util')
const WS = require('ws')

const getCandles = require('./cmds/get_candles')
const getMarkets = require('./cmds/get_markets')
const getTrades = require('./cmds/get_trades')
const getBTs = require('./cmds/get_bts')
const execBT = require('./cmds/exec_bt')
const submitBT = require('./cmds/submit_bt')
const proxyBFXMessage = require('./cmds/proxy_bfx_message')
const sendError = require('./wss/send_error')
const send = require('./wss/send')
const ERRORS = require('./errors')

const COMMANDS = {
  'exec.bt': execBT,
  'get.bts': getBTs,
  'get.markets': getMarkets,
  'get.candles': getCandles,
  'get.trades': getTrades,
  'submit.bt': submitBT,
  'bfx': proxyBFXMessage
}

module.exports = class DataServer {
  /**
   * @param {Object} args
   * @param {string} apiKey - for bfx proxy
   * @param {string} apiSecret - for bfx proxy
   * @param {Object} agent - optional proxy agent for bfx proxy connection
   * @param {string} wsURL - bitfinex websocket API URL
   * @param {string} restURL - bitfinex RESTv2 API URL
   * @param {boolean} transform - for bfx proxy
   * @param {boolean} proxy - if true, a bfx proxy will be opened for every client
   * @param {number} port - websocket server port
   */
  constructor ({
    apiKey,
    apiSecret,
    agent,
    restURL,
    wsURL,
    transform,
    proxy,
    port
  } = {}) {
    this.wssClients = {}
    this.bfxProxies = {} // one per client ID if enabled
    this.bfxProxyEnabled = proxy
    this.bfxProxyParams = {
      url: wsURL,
      apiKey,
      apiSecret,
      transform,
      agent
    }

    this.rest = new RESTv2({
      agent,
      transform: true,
      url: restURL,
    })

    this.wss = new WS.Server({
      clientTracking: true,
      port
    })

    this.wss.on('connection', this.onWSConnected.bind(this))

    debug('websocket API open on port %d', port)
  }

  close () {
    this.wss.close()

    Object.values(this.bfxProxies).forEach(proxy => proxy.close())
    this.bfxProxies = {}
  }

  onWSConnected (ws) {
    debug('ws client connected')

    const clientID = nonce()

    this.wssClients[clientID] = ws

    ws.on('message', this.onWSMessage.bind(this, clientID))
    ws.on('close', this.onWSDisconnected.bind(this, clientID))

    if (this.bfxProxyEnabled) {
      this.bfxProxies[clientID] = this.openBFXProxy(clientID)
      debug('opened bfx proxy for client %d', clientID)
    }

    send(ws, ['connected'])
    getMarkets(this, ws)
  }

  onWSDisconnected (clientID) {
    debug('ws client %s disconnected', clientID)

    delete this.wssClients[clientID]

    if (this.bfxProxies[clientID]) {
      if (this.bfxProxies[clientID].isOpen()) {
        this.bfxProxies[clientID].close()
      }

      delete this.bfxProxies[clientID]
    }
  }

  onWSMessage (clientID, msgJSON = '') {
    const ws = this.wssClients[clientID]

    let msg

    try {
      msg = JSON.parse(msgJSON)
    } catch (e) {
      debug('error reading ws client msg: %s', msgJSON)
    }

    if (!Array.isArray(msg)) {
      return sendError(ws, ERRORS.GENERIC.MSG_NOT_ARRAY)
    }

    const [ cmd ] = msg
    const handler = COMMANDS[cmd]

    if (!_isFunction(handler)) {
      return sendError(ws, ERRORS.GENERIC.UNKNOWN_COMMAND)
    }

    handler(this, ws, msg, clientID).catch((err) => {
      debug('error processing message: %s', err.stack)
      return sendError(ws, ERRORS.GENERIC.INTERNAL)
    })
  }

  openBFXProxy (clientID) {
    const proxy = new WSv2(this.bfxProxyParams)

    proxy.on('message', (msg) => {
      const ws = this.wssClients[clientID]

      if (!ws) {
        debug('recv proxy message for unknown client ID: %s', clientID)

        if (!this.bfxProxies[clientID]) {
          debug('proxy %d no longer needed, closing...', clientID )
          proxy.close()
        }

        return
      }

      if (ws.readyState !== 1) {
        return
      }

      debug('proxying message %j to client %s', msg, clientID)

      ws.send(JSON.stringify(['bfx', msg]))
    })

    proxy.on('open', () => {
      debug('bfx proxy connection opened')
    })

    proxy.on('auth', () => {
      debug('bfx proxy connection authenticated')
    })

    proxy.on('close', () => {
      debug('bfx proxy connection closed')
    })

    proxy.on('error', (err) => {
      debug('bfx proxy error: %j', err)
    })

    proxy.once('open', () => {
      if (this.bfxProxyParams.apiKey && this.bfxProxyParams.apiSecret) {
        proxy.auth()
      }
    })

    proxy.open()

    return proxy
  }
}