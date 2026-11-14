// botlingd's sessions: the session core (M2 step 4), the local Unix socket (M1 step 9: one session per front end, the
// live-frame cap per connection, where the socket and token live) and remote device sessions over the session layer.
export { LiveGate, type LiveGateClock } from "./live-gate";
export { botlingdPaths, PathsError, readToken, refuse2xData, sameToken, SOCKET_PATH_LIMIT, writeToken, type BotlingdPaths } from "./paths";
export { REQ_ALSO, servedAsReq, Session, type ContentHandler, type SessionHost, type SessionOptions } from "./session";
export { DEAD_AFTER_MS, PING_AFTER_MS, SessionCore, type AdminHost } from "./session-core";
export { devicePeerCheck, LIVE_SOFT_BYTES, RemoteSession, RemoteSessions, type PairingHook, type RemoteHost, type RemoteRoster, type RemoteSessionOptions } from "./remote-session";
export { REMOTE_READS, remoteReadRefusal, slotAuthorize, statedScope, type DeviceRoster } from "./remote-reads";
export { SessionServer, socketAnswers } from "./socket-server";
