import Server, { cors, prepareHeaders, serveStatic } from '@swarmmachina/swm-core'
import type {
  CommonServerOptions,
  CorsOptions,
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
  onUpgrade: async (meta) => ({ token: meta.getHeader('authorization') }),
  selectProtocol: (requested, userData) => {
    void userData

    return requested.includes('chat') ? 'chat' : undefined
  }
}

const server: ServerType = new Server({ http: { prefetch: true, onRequest: () => 'ok' } })
// @ts-expect-error prefetch belongs to the HTTP application options
new Server({ prefetch: true, http: { onRequest: () => 'ok' } })
const app: AppInstance = createApp()

void server
void app
void cors
void serveStatic
void prepareHeaders
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
