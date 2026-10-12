import { logEvent } from "./log";

type Stop = () => Promise<void> | void;
const stops: Stop[] = [];
let draining = false;
let fatalInstalled = false;

export function onStop(stop: Stop): void {
  stops.push(stop);
}

export function isDraining(): boolean {
  return draining;
}

export async function drain(timeoutMs = 10_000): Promise<void> {
  draining = true;
  await Promise.race([
    Promise.all(stops.map((stop) => Promise.resolve().then(stop))),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function installFatalHandlers(role: string): void {
  if (fatalInstalled) return;
  fatalInstalled = true;
  const fail = (kind: string, err: unknown) => {
    logEvent("error", kind, { role, message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  };
  process.on("uncaughtException", (err) => fail("uncaught_exception", err));
  process.on("unhandledRejection", (err) => fail("unhandled_rejection", err));
}

export async function bindShutdown(role: string): Promise<void> {
  installFatalHandlers(role);
  process.on("SIGTERM", () => {
    void drain().finally(() => process.exit(0));
  });
}
