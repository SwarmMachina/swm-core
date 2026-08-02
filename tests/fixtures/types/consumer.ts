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
  HttpHeaders,
  HttpMethod,
  HttpOptions,
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
  CommonServerOptions,
  ServerOptions,
  EffectiveHttpConfig,
  EffectiveWSConfig,
  EffectiveServerConfig,
  HttpContext,
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
const wsOptions: WSOptions = {
  maxPayloadLength: 32 * 1024,
  maxBackpressure: 64 * 1024,
  closeOnBackpressureLimit: true,
  onUpgrade: async (meta) => ({ token: meta.getHeader('authorization') }),
  selectProtocol: (requested, userData) => {
    void userData

    return requested.includes('chat') ? 'chat' : undefined
  }
}

const configuredOptions = defineConfig({
  http: {
    prefetch: true,
    maxBodySize: 16 * 1024 * 1024,
    maxBodyBudget: 256 * 1024 * 1024,
    onRequest: () => 'ok'
  }
})
const server: ServerType = new Server(configuredOptions)
const unlimitedServer: ServerType = new Server({
  http: { maxBodyBudget: null, onRequest: () => 'ok' }
})

const effectiveConfig: Readonly<EffectiveServerConfig> = server.effectiveConfig
const effectiveHttp: Readonly<EffectiveHttpConfig> | null = effectiveConfig.http
const effectiveWs: Readonly<EffectiveWSConfig> | null = effectiveConfig.ws

export function verifyHttpContextReaders(ctx: HttpContext): void {
  const ip: string = ctx.getIP()
  const method: string = ctx.getMethod()
  const url: string = ctx.getUrl()
  const fullQuery: string = ctx.getQuery()
  const queryValue: string | undefined = ctx.getQuery('page')
  const parameter: string | undefined = ctx.getParameter('id')
  const header: string = ctx.getHeader('x-test')
  const headers: Record<string, string> = ctx.getHeaders()
  const contentLength: number | null = ctx.getContentLength()

  void ip
  void method
  void url
  void fullQuery
  void queryValue
  void parameter
  void header
  void headers
  void contentLength

  ctx.ip()
  ctx.method()
  ctx.url()
  ctx.fullQuery()
  ctx.query('page')
  ctx.param('id')
  ctx.header('x-test')
  ctx.contentLength()
  ctx.setStatus(201)
  ctx.status(201)
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
void serveStatic
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
void wsOptions
