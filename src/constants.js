export const TEXT_PLAIN_HEADER = Object.freeze({ 'content-type': 'text/plain; charset=utf-8' })
export const JSON_HEADER = Object.freeze({ 'content-type': 'application/json; charset=utf-8' })
export const OCTET_STREAM_HEADER = Object.freeze({ 'content-type': 'application/octet-stream' })

export const STATUS_TEXT = Object.freeze({
  100: '100 Continue',
  101: '101 Switching Protocols',
  102: '102 Processing',

  200: '200 OK',
  201: '201 Created',
  202: '202 Accepted',
  203: '203 Non-Authoritative Information',
  204: '204 No Content',
  205: '205 Reset Content',
  206: '206 Partial Content',

  300: '300 Multiple Choices',
  301: '301 Moved Permanently',
  302: '302 Found',
  303: '303 See Other',
  304: '304 Not Modified',
  307: '307 Temporary Redirect',
  308: '308 Permanent Redirect',

  400: '400 Bad Request',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  405: '405 Method Not Allowed',
  406: '406 Not Acceptable',
  408: '408 Request Timeout',
  409: '409 Conflict',
  410: '410 Gone',
  413: '413 Payload Too Large',
  414: '414 URI Too Long',
  415: '415 Unsupported Media Type',
  418: "418 I'm a teapot",
  422: '422 Unprocessable Entity',
  429: '429 Too Many Requests',

  500: '500 Internal Server Error',
  501: '501 Not Implemented',
  502: '502 Bad Gateway',
  503: '503 Service Unavailable',
  504: '504 Gateway Timeout'
})

export const CACHED_ERRORS = Object.freeze({
  bodyTooLarge: Object.assign(new Error('Request body too large'), { status: 413 }),
  aborted: Object.assign(new Error('Request aborted'), { status: 418 }),
  sizeMismatch: Object.assign(new Error('Request body size mismatch'), { status: 400 }),
  invalidJSON: Object.assign(new Error('Invalid JSON'), { status: 400 }),
  serverError: Object.assign(new Error('Internal Server Error'), { status: 500 })
})
