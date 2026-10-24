// A stand-in core for the durable-store spike: recovers, then claims and delivers jobs. The test
// SIGKILLs it at chosen points. Delivery appends "<job id> <pid>" to a log (fsynced), standing in
// for "handed to a chat or worker".
import { appendFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { JobStore, drain } from "../../src/core/durable/jobs";

const [store, log, mode] = process.argv.slice(2) as [string, string, string];
const jobs = new JobStore(store);
const deliver = (id: string) => {
  appendFileSync(log, `${id} ${process.pid}\n`);
  const fd = openSync(log, "r");
  fsyncSync(fd);
  closeSync(fd);
};
const hang = () => setInterval(() => {}, 1_000);

const recovered = jobs.recover();
process.stdout.write(`RECOVERED ${recovered.map((job) => job.id).join(",")}\n`);

if (mode === "hang-after-claim") {
  const job = jobs.claimNext();
  process.stdout.write(`CLAIMED ${job?.id}\n`);
  hang();
} else if (mode === "hang-after-deliver") {
  const job = jobs.claimNext()!;
  deliver(job.id);
  process.stdout.write(`DELIVERED ${job.id}\n`);
  hang();
} else if (mode === "create-forever") {
  for (let i = 0; ; i++) jobs.create(`req-${process.pid}-${i}`, `task ${i}`);
} else {
  // drain (optionally slowly, to race other workers)
  const slow = mode === "race";
  void drain(jobs, async (job) => {
    if (slow) await new Promise((r) => setTimeout(r, Math.random() * 5));
    deliver(job.id);
  }).then((count) => {
    process.stdout.write(`DRAINED ${count}\n`);
    process.exit(0);
  });
}
