// @ts-check

/** @typedef {import('@swarmmachina/swm-core').ServerOptions} ServerOptions */
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
 * @param {WebSocketBehavior} behavior
 */
export function verifyJsConsumer(ctx, ws, req, res, options, behavior) {
  ctx.ip()
  ctx.method()
  ctx.header('x-test')
  void ctx.json()
  ws.send('hello')
  ws.subscribe('topic')
  void ws.data
  void ws.key
  req.getUrl()
  req.getHeader('x-test')
  req.snapshot()
  res.getRemoteAddress()
  res.getProxiedRemoteAddress()
  res.collectBody(1024, () => {})
  void options
  void behavior
}
