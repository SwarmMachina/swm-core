import { validateWsClose } from './server/utils.js'

export type WebSocketData = string | ArrayBuffer | ArrayBufferView

export interface WSServer {
  publish(topic: string, message: WebSocketData, isBinary?: boolean): boolean
}

export interface RawWebSocket {
  send(data: WebSocketData, isBinary?: boolean): number
  getUserData(): object
  getBufferedAmount(): number
  getRemoteAddress(): ArrayBuffer
  getRemoteAddressAsText(): ArrayBuffer
  getRemotePort(): number
  isSubscribed(topic: string): boolean
  getTopics(): string[]
  end(code?: number, reason?: string): void
  close(): void
  subscribe(topic: string): boolean
  unsubscribe(topic: string): boolean
}

export default class WSContext {
  declare server: WSServer | null
  declare ws: RawWebSocket | null
  declare data: object | null
  declare key: string | number | null

  constructor() {
    this.server = null
    this.ws = null
    this.data = null
    this.key = null
  }

  reset(server: WSServer, ws: RawWebSocket, userData: object): this {
    this.server = server
    this.ws = ws
    this.data = userData

    return this
  }

  clear(): void {
    this.server = null
    this.ws = null
    this.data = null
    // noinspection JSConstantReassignment
    this.key = null
  }

  decode(message: ArrayBuffer | ArrayBufferView): string {
    if (ArrayBuffer.isView(message)) {
      return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString()
    }

    return Buffer.from(message).toString()
  }

  send(data: WebSocketData, isBinary?: boolean): number {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    if (typeof data !== 'string' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw new TypeError('WSContext.send: unsupported data type')
    }

    return this.ws.send(data, isBinary ?? typeof data !== 'string')
  }

  end(code = 1000, reason = ''): void {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    validateWsClose(code, reason)
    this.ws.end(code, reason)
  }

  terminate(): void {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    this.ws.close()
  }

  subscribe(topic: string): boolean {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    return this.ws.subscribe(topic)
  }

  unsubscribe(topic: string): boolean {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    return this.ws.unsubscribe(topic)
  }

  publish(topic: string, msg: WebSocketData, isBinary?: boolean): boolean {
    if (this.server === null) {
      throw new Error('WSContext: server is null (did you forget reset?)')
    }

    return this.server.publish(topic, msg, isBinary)
  }
}
