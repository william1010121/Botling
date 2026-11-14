// Replication of `srv:` tables (protocol v1 §8.2, §10.1; M3): the server's own summary rows (step 6) and the copies of
// peers' tables with their feeds to peers and front ends (step 7). Pass-through comes with step 8.
export * from "./tables";
export * from "./summary";
export * from "./peer-tables";
