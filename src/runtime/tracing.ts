import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { activeCorrelation } from "./correlation";

const tracer = trace.getTracer("taskbrain");

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const correlation = activeCorrelation();
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes({
      ...attributes,
      ...(correlation?.traceId ? { "taskbrain.trace_id": correlation.traceId } : {}),
      ...(correlation?.requestId ? { "taskbrain.request_id": correlation.requestId } : {}),
      ...(correlation?.runId ? { "taskbrain.run_id": correlation.runId } : {}),
    });
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
