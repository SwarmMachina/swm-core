// @ts-check

import { defineConfig } from '@swarmmachina/swm-core'

/** @typedef {import('@swarmmachina/swm-core').ServerOptions} ServerOptions */
/** @typedef {import('@swarmmachina/swm-core').EffectiveServerConfig} EffectiveServerConfig */
/** @typedef {import('@swarmmachina/swm-core').HttpContext} HttpContext */
/** @typedef {import('@swarmmachina/swm-core').WSContext} WSContext */
/** @typedef {import('@swarmmachina/swm-uws').HttpRequest} HttpRequest */
/** @typedef {import('@swarmmachina/swm-uws').HttpResponse} HttpResponse */
/** @typedef {import('@swarmmachina/swm-uws').WebSocketBehavior<object>} WebSocketBehavior */

/**
 * @param {HttpContext} ctx
 * @param {WSContext} ws
 * @param {HttpRequest} req
 * @param {HttpResponse} res
 * @param {ServerOptions} options
 * @param {EffectiveServerConfig} effectiveConfig
 * @param {WebSocketBehavior} behavior
 */
export function verifyJsConsumer(ctx, ws, req, res, options, effectiveConfig, behavior) {
  ctx.getIP()
  ctx.getMethod()
  ctx.getUrl()
  ctx.getQuery()
  ctx.getQuery('page')
  ctx.getParameter('id')
  ctx.getReqHeader('x-test')
  ctx.headers
  ctx.getHeaders()
  ctx.getContentLength()
  ctx.setStatus(201)
  void ctx.json()
  ws.send('hello')
  ws.subscribe('topic')
  void ws.data
  void ws.key
  req.getUrl()
  req.getHeader('x-test')
  res.getRemoteAddress()
  res.getProxiedRemoteAddress()
  res.collectBody(1024, () => {})
  void options
  void effectiveConfig.http?.maxBodyBudget
  void effectiveConfig.transport?.maxHeaderSize
  void behavior
}

export const jsOptions = defineConfig({
  transport: { maxHeaderSize: 16 * 1024 },
  http: {
    maxBodyBudget: 256 * 1024 * 1024,
    prefetchHeaders: ['authorization'],
    errorDelivery: { query: ['requestId'] },
    onRequest: (ctx) => ({ method: ctx.getMethod() }),
    onError: (event) => {
      void event.query.requestId
    }
  }
})
