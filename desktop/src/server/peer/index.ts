// Peer servers (M3 step 3, protocol v1 §4.6, §5.1, §6.2, D47): KK sessions between two botlingd over the loopback
// listener's `/v3/ws`, one per pair, the revocation exchange on a refused handshake, and each peer's state.
export { addressesValue, DEFAULT_PEER_TIMERS, loopbackAddress, PEER_TIMERS_ENV, peerTimers, type PeerTimers } from "./config";
export { webSocketConnector, type PeerConnection, type PeerConnector } from "./connector";
export { PeerSession, REVOCATIONS_PER_FRAME, serverKeys, serverPeerCheck, type PeerRoster, type PeerSessionEnd, type PeerSessionEvents, type PeerSessionHost } from "./peer-session";
export { PeerSessions, type PeerSessionsOptions, type PeerState } from "./peers";
export { FIRST_FRAME_TIMEOUT_MS, SessionRouter, type AcceptedSession, type DeviceAcceptor, type PeerAcceptor } from "./router";
