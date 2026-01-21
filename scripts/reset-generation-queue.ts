// npx ts-node scripts/reset-generation-queue.ts
import { Queue } from "bullmq";

async function main() {
  const q = new Queue("generation", {
    connection: { host: "127.0.0.1", port: 6379 },
  });

  await q.pause();
  await q.obliterate({ force: true }); // hapus semua job di queue ini
  await q.close();

  console.log("✅ generation queue obliterated");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});