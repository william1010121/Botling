// botlingd's network side (M2 step 6): the loopback HTTP listener (page, `/v3/ws`, `/v3/c/…`) and the device WebSocket.
export {
  CHAT_CSP, CSP, DEFAULT_LISTEN_PORT, defaultPageDir, FRAME_HOST_CSP, LISTEN_FILE, LISTEN_HOST, LISTEN_PORT_ENV, listenPort, LoopbackListener, PLACEHOLDER_PAGE,
  SECURITY_HEADERS, tailscaleServeCommand, type LoopbackListenerOptions,
} from "./http";
export { DeviceSockets, MAX_CONNECTIONS, MAX_HANDSHAKING, refuseUpgrade, WS_MAX_PAYLOAD, type DeviceSocketsOptions, type SessionAcceptor } from "./ws";
