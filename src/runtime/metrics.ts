const gauges = new Map<string, number>();

export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function addCount(name: string, by = 1): void {
  gauges.set(name, (gauges.get(name) ?? 0) + by);
}

export function metricSnapshot(): Record<string, number> {
  return Object.fromEntries(gauges);
}
