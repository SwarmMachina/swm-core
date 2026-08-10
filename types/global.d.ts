import type * as Core from './index.js'

/**
 * Opt-in type-only namespace for JavaScript/JSDoc consumers.
 *
 * This declaration intentionally contains no values and does not declare a
 * runtime `globalThis.Swm` object.
 */
declare global {
  namespace Swm {
    type HttpMethod = Core.HttpMethod
    type HttpBody = Core.HttpBody
    type HttpHeaders = Core.HttpHeaders
    type PreparedHeaders = Core.PreparedHeaders
    type ResponseHeaders = Core.ResponseHeaders
    type Handler = Core.Handler
    type HeaderPrefetch = Core.HeaderPrefetch
    type Route = Core.Route
    type UpgradeMeta = Core.UpgradeMeta
    type UpgradeResult = Core.UpgradeResult
    type WSOptions = Core.WSOptions
    type HttpBaseOptions = Core.HttpBaseOptions
    type HttpOptions = Core.HttpOptions
    type HttpTransportOptions = Core.HttpTransportOptions
    type CommonServerOptions = Core.CommonServerOptions
    type ServerOptions = Core.ServerOptions
    type EffectiveHttpConfig = Core.EffectiveHttpConfig
    type EffectiveWSConfig = Core.EffectiveWSConfig
    type EffectiveServerConfig = Core.EffectiveServerConfig
    type NativeCapabilities = Core.NativeCapabilities
    type HttpContext = Core.HttpContext
    type WSSendStatus = Core.WSSendStatus
    type RawWebSocket = Core.RawWebSocket
    type UWebSocket = Core.UWebSocket
    type WSContext = Core.WSContext
    type Server = Core.Server
    type CorsOptions = Core.CorsOptions
    type ServeStaticOptions = Core.ServeStaticOptions
  }
}

export {}
