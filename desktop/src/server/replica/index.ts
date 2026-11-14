// Replication of `srv:` tables (protocol v1 §8.2, §10.1; M3): the server's own summary rows (step 6). Peers' tables
// and pass-through come with steps 7 and 8.
export * from "./tables";
export * from "./summary";
