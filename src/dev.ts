import { bootstrap } from "./main";

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("[runtime] Failed to start Smart Queue backend", message);
  process.exit(1);
});
