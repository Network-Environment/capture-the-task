import { CloudAdapter } from "botbuilder";

let adapter: CloudAdapter | null = null;
let botAppId = "";

export function initDeliveryContext(a: CloudAdapter, appId: string): void {
  adapter = a;
  botAppId = appId;
}

export function getDeliveryAdapter(): CloudAdapter | null {
  return adapter;
}

export function getDeliveryAppId(): string {
  return botAppId;
}
