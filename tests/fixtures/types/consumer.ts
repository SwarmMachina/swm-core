import Server, { cors, defineConfig, prepareHeaders, serveStatic } from '@swarmmachina/swm-core'
import type {
  CommonServerOptions,
  CorsOptions,
  EffectiveHttpConfig,
  EffectiveServerConfig,
  EffectiveWSConfig,
  Handler,
  HttpBaseOptions,
  HttpBody,
  HttpContext,
  HttpErrorDeliveryContext,
  HttpErrorDeliveryOptions,
  HttpErrorDeliveryStats,
  HttpErrorEvent,
  HttpHeaders,
  HttpMethod,
  HttpOptions,
  HttpTransportOptions,
  NativeCapabilities,
  PreparedHeaders,
  RawWebSocket,
  ResponseHeaders,
  Route,
  ServeStaticOptions,
  Server as ServerType,
  ServerOptions,
  UWebSocket,
  UpgradeMeta,
  UpgradeResult,
  WSContext,
  WSOptions,
  WSSendStatus
} from '@swarmmachina/swm-core'
import uWS, {
  App,
  DISABLED,
  LIBUS_LISTEN_EXCLUSIVE_PORT,
  capabilities,
  createApp,
  us_listen_socket_close,
  us_socket_local_port,
  version
} from '@swarmmachina/swm-uws'
import type {
  AppInstance,
  AppOptions,
  HttpHandler,
  HttpRequest,
  HttpResponse,
  ListenOptions,
  ListenSocket,
  NativeData,
  RecognizedString,
  Socket,
  SocketContext,
  TemplatedApp,
  WebSocket,
  WebSocketBehavior,
  us_listen_socket,
  us_socket,
  us_socket_context_t
} from '@swarmmachina/swm-uws'

type CorePublicTypes = [
  HttpMethod,
  HttpBody,
  HttpHeaders,
  PreparedHeaders,
  ResponseHeaders,
  Handler,
  Route,
  UpgradeMeta,
  UpgradeResult,
  WSOptions,
  HttpBaseOptions,
  HttpOptions,
  HttpTransportOptions,
  CommonServerOptions,
  ServerOptions,
  EffectiveHttpConfig,
  EffectiveWSConfig,
  EffectiveServerConfig,
  HttpContext,
  HttpErrorEvent,
  HttpErrorDeliveryContext,
  HttpErrorDeliveryOptions,
  HttpErrorDeliveryStats,
  WSSendStatus,
  RawWebSocket,
  UWebSocket,
  WSContext,
  CorsOptions,
  ServeStaticOptions,
  ServerType
]

type BindingPublicTypes = [
  NativeData,
  RecognizedString,
  ListenSocket,
  Socket,
  SocketContext,
  us_listen_socket,
  us_socket,
  us_socket_context_t,
  HttpRequest,
  HttpResponse,
  WebSocket<object>,
  WebSocketBehavior<object>,
  HttpHandler,
  AppOptions,
  ListenOptions,
  AppInstance,
  TemplatedApp
]

const upgradeResult: UpgradeResult = { userId: 'reader' }
const rejectedUpgrade: UpgradeResult = null
const uploadRoute: Route = {
  method: 'post',
  path: '/upload',
  maxBodySize: 1024,
  prefetchHeaders: ['authorization'],
  handler: (ctx) => ctx.headers.authorization
}
const wsOptions: WSOptions = {
  maxPayloadLength: 32 * 1024,
  maxBackpressure: 64 * 1024,
  closeOnBackpressureLimit: true,
  prefetchHeaders: ['authorization'],
  onUpgrade: async (meta) => ({ token: meta.headers.authorization }),
  selectProtocol: (requested, userData) => {
    void userData

    return requested.includes('chat') ? 'chat' : undefined
  }
}

const configuredOptions = defineConfig({
  transport: {
    maxHeaderSize: 16 * 1024,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000
  },
  http: {
    prefetch: true,
    prefetchHeaders: ['authorization', 'traceparent'],
    maxBodySize: 16 * 1024 * 1024,
    maxBodyBudget: 256 * 1024 * 1024,
    onRequest: () => 'ok'
  }
})
const server: ServerType = new Server(configuredOptions)
const unlimitedServer: ServerType = new Server({
  http: { maxBodyBudget: null, onRequest: () => 'ok' }
})
const reportingServer: ServerType = new Server({
  http: {
    onRequest: () => 'ok',
    errorDelivery: {
      concurrency: 4,
      queueLimit: 256,
      timeoutMs: 5_000,
      headers: ['x-request-id'],
      query: ['requestId'],
      includeIp: true
    },
    async onError(event, error, { signal }) {
      const status: number = event.status
      const header: string | undefined = event.headers['x-request-id']
      const requestId: string | undefined = event.query.requestId
      const aborted: boolean = signal.aborted

      void error
      void status
      void header
      void requestId
      void aborted
    }
  }
})

const effectiveConfig: Readonly<EffectiveServerConfig> = server.effectiveConfig
const effectiveHttp: Readonly<EffectiveHttpConfig> | null = effectiveConfig.http
const effectiveWs: Readonly<EffectiveWSConfig> | null = effectiveConfig.ws
const effectiveTransport: Readonly<HttpTransportOptions> | null = effectiveConfig.transport
const nativeCapabilities: Readonly<NativeCapabilities> = server.bindingCapabilities
const errorDeliveryStats: Readonly<HttpErrorDeliveryStats> = reportingServer.httpErrorDeliveryStats

void effectiveTransport
void nativeCapabilities.requestPrefetch
void nativeCapabilities.responseBatch
void errorDeliveryStats.oldestInFlightMs

export function verifyHttpContextReaders(ctx: HttpContext): void {
  const ip: string = ctx.getIP()
  const method: string = ctx.getMethod()
  const url: string = ctx.getUrl()
  const fullQuery: string = ctx.getQuery()
  const queryValue: string | undefined = ctx.getQuery('page')
  const parameter: string | undefined = ctx.getParameter('id')
  const header: string = ctx.getReqHeader('x-test')
  const prefetchedHeaders: Readonly<Record<string, string>> = ctx.headers
  const headers: Record<string, string> = ctx.getHeaders()
  const contentLength: number | null = ctx.getContentLength()

  void ip
  void method
  void url
  void fullQuery
  void queryValue
  void parameter
  void header
  void prefetchedHeaders
  void headers
  void contentLength

  ctx.getIP()
  ctx.getMethod()
  ctx.getUrl()
  ctx.getQuery()
  ctx.getQuery('page')
  ctx.getParameter('id')
  ctx.getReqHeader('x-test')
  ctx.getContentLength()
  ctx.setStatus(201)
  ctx.setHeader('set-cookie', ['access=one; Path=/', 'refresh=two; Path=/refresh'] as const)
}

// @ts-expect-error prefetch belongs to the HTTP application options
new Server({ prefetch: true, http: { onRequest: () => 'ok' } })
const app: AppInstance = createApp()

void server
void unlimitedServer
void effectiveHttp
void effectiveWs
void app
void cors
void serveStatic('./public', {
  cacheByteLimit: 64 * 1024 * 1024,
  maxFileSize: 16 * 1024 * 1024,
  maxInflightBytes: 64 * 1024 * 1024,
  maxInflightFiles: 32
})
void prepareHeaders
void defineConfig
void uWS
void App
void version
void capabilities
void us_listen_socket_close
void us_socket_local_port
void LIBUS_LISTEN_EXCLUSIVE_PORT
void DISABLED

declare const coreTypes: CorePublicTypes
declare const bindingTypes: BindingPublicTypes

void coreTypes
void bindingTypes
void upgradeResult
void rejectedUpgrade
void uploadRoute
void wsOptions
