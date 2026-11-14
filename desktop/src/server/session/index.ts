// botlingd's local sessions (M1 step 9): the Unix socket, one session per front end, the live-frame cap per connection,
// and where the socket and token live.
export { LiveGate, type LiveGateClock } from "./live-gate";
export { botlingdPaths, PathsError, readToken, refuse2xData, sameToken, SOCKET_PATH_LIMIT, writeToken, type BotlingdPaths } from "./paths";
export { REQ_ALSO, servedAsReq, Session, type ContentHandler, type SessionHost, type SessionOptions } from "./session";
export { SessionServer, socketAnswers } from "./socket-server";
