// Peer servers (M3 step 3, protocol v1 §4.6, §5.1, §6.2, §6.3, D47): KK sessions between two botlingd over the
// loopback listener's `/v3/ws` or the peer's relay room, one per pair, the revocation exchange on a refused handshake,
// and each peer's state.
export {
  ADVERTISE_PORT_ENV, addressesForUrl, addressesValue, advertisedPort, DEFAULT_PEER_TIMERS, loopbackAddress, peerAddresses,
  PEER_TIMERS_ENV, peerTimers, type AddressOptions, type PeerAddresses, type PeerTimers, type RelayAddress,
} from "./config";
export { webSocketConnector, type PeerConnection, type PeerConnector } from "./connector";
export { MAX_REVOCATION_SET, PeerSession, REVOCATIONS_PER_FRAME, serverKeys, serverPeerCheck, type PeerRoster, type PeerSessionEnd, type PeerSessionEvents, type PeerSessionHost } from "./peer-session";
export { PeerSessions, type PeerSessionsOptions, type PeerState } from "./peers";
export { relayConnector, type RelayConnectorBase, type RelayConnectorOptions, type RelayPeerConnection, type RelayPeerConnector } from "./relay-connector";
export { FIRST_FRAME_TIMEOUT_MS, hs1Offer, SessionRouter, type AcceptedSession, type DeviceAcceptor, type JoinAcceptor, type PeerAcceptor } from "./router";
