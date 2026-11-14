// Botling 3 wire protocol v1 (protocol-v1.md): identifiers, slots, entries, messages, the role table and frames.
// Shared by the server (src/server), the front-end link (src/fe-link) and later the phone page; it imports only
// zod and the 2.x contract (the command and event vocabulary), never Electron, the core or main.
export * from "./ids";
export * from "./entries";
export * from "./messages";
export * from "./roles";
export * from "./frame";
export * from "./snap-view";
export * from "./encoding";
export * from "./scopes";
export * from "./roster";
export * from "./content-url";
export * from "./pairing";
export * from "./interrupted";
