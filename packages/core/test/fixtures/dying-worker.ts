/** A verification worker that dies on its first message (VerifyPool fallback tests). */
import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => process.exit(1));
