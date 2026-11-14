// Device pairing (M2 step 5, protocol v1 §4.4): offers, the pairing session's server side, the CLI over the local socket.
export { PAIR_ACK_TIMEOUT_MS, PAIR_HELLO_TIMEOUT_MS, PairingError, PairingService, type DeviceRow, type PairAddresses, type PairChannel, type PairingOptions, type PairLink, type PairOfferResult } from "./service";
export { AdminClient, AdminRefused } from "./admin-client";
export { addMachineCommand, devicesCommand, joinCommand, pairCommand, revokeDeviceCommand, type CliIo } from "./cli";
export { qrModules, qrTerminal } from "./qr";
export { JOIN_CLUSTER, JOIN_HELLO_TIMEOUT_MS, JOIN_REPLY_TIMEOUT_MS, JoinError, ServerJoin, type JoinOfferResult, type MachineAddResult, type MachineCodeResult, type ServerJoinOptions } from "./join";
