import { canViewMeetings } from "../meetings/access";
import type { MemoryNetwork } from "./types";

export const ORG_MEMORY_BANK = "org";

export function userBankId(userId: string): string {
  return `user:${userId.trim().toLowerCase()}`;
}

export function readableBanks(userId: string): string[] {
  const banks = [userBankId(userId)];
  if (canViewMeetings(userId)) banks.push(ORG_MEMORY_BANK);
  return banks;
}

export function canWriteOrgBank(userId: string): boolean {
  return canViewMeetings(userId);
}

export function isOpinionAllowed(network: MemoryNetwork, bankId: string): boolean {
  return network !== "opinion" || bankId !== ORG_MEMORY_BANK;
}
