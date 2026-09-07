import { app, type InvocationContext, type Timer } from "@azure/functions";
import { runMeetingIngest } from "./ingest";

app.timer("meetingIngest", {
  schedule: "0 */5 * * * *",
  handler: async (_timer: Timer, context: InvocationContext): Promise<void> => {
    try {
      await runMeetingIngest({ info: (...a: unknown[]) => context.log(...a) });
    } catch (err) {
      context.error("[meeting-ingest] run failed", err);
      throw err;
    }
  },
});
