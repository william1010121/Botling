// The front end's side of Botling 3 (protocol v1 §13): socket client, durable outbox with origin epoch and counters,
// stream cursors, live buffer and connection states. Pure TypeScript with a storage interface; the desktop's
// `node:sqlite` storage is in ./sqlite-storage (imported directly, so the phone build never pulls it in); the page's
// IndexedDB storage (./idb-storage) is exported here.
export * from "./storage";
export * from "./connection-state";
export * from "./cursors";
export * from "./outbox";
export * from "./link";
export * from "./idb-storage";
export * from "./ws-dial";
