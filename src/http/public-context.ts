import type HttpContext from './context.js'
import type { HeaderInput, HttpBody } from './context.js'
import type RequestBodyStream from './request-body-stream.js'
import type { Readable } from 'node:stream'

type HeaderMap = Record<string, string>

/** Extensible request object. Only its internal resource owner is pooled. */
export default class PublicHttpContext {
  #owner: HttpContext | null

  constructor(owner: HttpContext) {
    this.#owner = owner
  }

  static detach(context: PublicHttpContext): void {
    context.#owner = null
  }

  #requireOwner(): HttpContext {
    if (this.#owner === null) {
      throw new Error('HTTP context is no longer active')
    }

    return this.#owner
  }

  get headers(): HeaderMap {
    return this.#requireOwner().headers
  }

  get done(): boolean {
    return this.#requireOwner().done
  }

  set done(value: boolean) {
    this.#requireOwner().done = value
  }

  get replied(): boolean {
    return this.#requireOwner().replied
  }

  set replied(value: boolean) {
    this.#requireOwner().replied = value
  }

  get aborted(): boolean {
    return this.#requireOwner().aborted
  }

  set aborted(value: boolean) {
    this.#requireOwner().aborted = value
  }

  get terminating(): boolean {
    return this.#requireOwner().terminating
  }

  set terminating(value: boolean) {
    this.#requireOwner().terminating = value
  }

  get streaming(): boolean {
    return this.#requireOwner().streaming
  }

  set streaming(value: boolean) {
    this.#requireOwner().streaming = value
  }

  /** Compatibility view; valid only during this request's lifetime. */
  get req(): HttpContext['req'] {
    return this.#owner?.req ?? null
  }

  /** Compatibility view; valid only during this request's lifetime. */
  get res(): HttpContext['res'] {
    return this.#owner?.res ?? null
  }

  /** Compatibility view; valid only during this request's lifetime. */
  get server(): HttpContext['server'] {
    return this.#owner?.server ?? null
  }

  body(maxSize?: number): Promise<Buffer> {
    return this.#requireOwner().body(maxSize)
  }

  bodyStream(maxSize?: number): RequestBodyStream {
    return this.#requireOwner().bodyStream(maxSize)
  }

  buffer(maxSize?: number): Promise<Buffer> {
    return this.#requireOwner().buffer(maxSize)
  }

  text(maxSize?: number): Promise<string> {
    return this.#requireOwner().text(maxSize)
  }

  json<T = unknown>(maxSize?: number): Promise<T> {
    return this.#requireOwner().json(maxSize) as Promise<T>
  }

  prefetchBody(): Error | null {
    return this.#requireOwner().prefetchBody()
  }

  getIP(): string {
    return this.#requireOwner().getIP()
  }

  getMethod(): string {
    return this.#requireOwner().getMethod()
  }

  getUrl(): string {
    return this.#requireOwner().getUrl()
  }

  getQuery(): string

  getQuery(name: string): string | undefined

  getQuery(name?: string): string | undefined {
    const owner = this.#requireOwner()

    return name === undefined ? owner.getQuery() : owner.getQuery(name)
  }

  getParameter(i: number | string): string | undefined {
    return this.#requireOwner().getParameter(i)
  }

  getReqHeader(name: string): string {
    return this.#requireOwner().getReqHeader(name)
  }

  getHeaders(): HeaderMap {
    return this.#requireOwner().getHeaders()
  }

  getContentLength(): number | null {
    return this.#requireOwner().getContentLength()
  }

  setStatus(code: number): this {
    this.#requireOwner().setStatus(code)

    return this
  }

  setHeader(key: string, value: string | number | readonly string[] | null | undefined): this {
    this.#requireOwner().setHeader(key, value)

    return this
  }

  appendHeader(key: string, value: string | number | null | undefined): this {
    this.#requireOwner().appendHeader(key, value)

    return this
  }

  setHeaders(headers: HeaderInput): void {
    return this.#requireOwner().setHeaders(headers)
  }

  flushHeaders(headers?: HeaderInput): void {
    return this.#requireOwner().flushHeaders(headers)
  }

  send(result: unknown): void {
    return this.#requireOwner().send(result)
  }

  sendJson(data: object | unknown[], status?: number): void {
    return this.#requireOwner().sendJson(data, status)
  }

  sendText(text: string, status?: number): void {
    return this.#requireOwner().sendText(text, status)
  }

  sendBuffer(buffer: Buffer | Uint8Array | ArrayBuffer, status?: number): void {
    return this.#requireOwner().sendBuffer(buffer, status)
  }

  sendError(error: unknown): void {
    return this.#requireOwner().sendError(error)
  }

  reply(status?: number, headers?: HeaderInput, body?: HttpBody | null | undefined): void {
    return this.#requireOwner().reply(status, headers, body)
  }

  replyAndClose(status?: number, headers?: HeaderInput, body?: HttpBody | null | undefined): void {
    return this.#requireOwner().replyAndClose(status, headers, body)
  }

  terminate(): void {
    return this.#requireOwner().terminate()
  }

  startStreaming(status?: number, headers?: HeaderInput): this {
    this.#requireOwner().startStreaming(status, headers)

    return this
  }

  write(chunk: HttpBody): boolean {
    return this.#requireOwner().write(chunk)
  }

  tryEnd(chunk: HttpBody, totalSize: number): [boolean, boolean] {
    return this.#requireOwner().tryEnd(chunk, totalSize)
  }

  end(chunk?: HttpBody): void {
    return this.#requireOwner().end(chunk)
  }

  onWritable(callback: (offset: number) => void): void {
    return this.#requireOwner().onWritable(callback)
  }

  getWriteOffset(): number {
    return this.#requireOwner().getWriteOffset()
  }

  stream(readable: Readable, status?: number, headers?: HeaderInput): Promise<void> {
    return this.#requireOwner().stream(readable, status, headers)
  }
}
