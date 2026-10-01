/**
 * The requester's own mailbox, using their delegated Graph token.
 * Drafts and sends are prepared by the caller only after approval.
 * This never uses the shared follow-through mailbox.
 */
const GRAPH = "https://graph.microsoft.com/v1.0";

export interface MailDraft {
  to: string;
  subject: string;
  body: string;
}

function bounded(limit: number | undefined): number {
  return Math.max(1, Math.min(10, Math.floor(Number(limit) || 8)));
}

export function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

async function graphJson(
  token: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Graph mail ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  if (response.status === 202 || response.status === 204) return {};
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export async function searchMyMail(
  token: string,
  query: string,
  limit?: number,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const q = query.trim();
  if (!q) return "Mail search query was empty.";
  const url =
    `${GRAPH}/me/messages?$search=${encodeURIComponent(`"${q}"`)}` +
    `&$top=${bounded(limit)}&$select=id,subject,from,receivedDateTime,bodyPreview`;
  const page = (await graphJson(
    token,
    url,
    { headers: { ConsistencyLevel: "eventual" } },
    fetchImpl
  )) as {
    value?: Array<{
      id?: string;
      subject?: string;
      receivedDateTime?: string;
      bodyPreview?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
    }>;
  };
  const rows = page.value ?? [];
  if (!rows.length) return "No matching messages in the requester's mailbox.";
  return rows
    .map((message) => {
      const from = message.from?.emailAddress;
      return [
        `Message: ${message.subject || "(no subject)"}`,
        `Id: ${message.id ?? "unknown"}`,
        `From: ${from?.name || from?.address || "unknown"}`,
        `Received: ${message.receivedDateTime ?? "unknown"}`,
        `Preview: ${(message.bodyPreview ?? "").replace(/\s+/g, " ").slice(0, 280)}`,
      ].join("\n");
    })
    .join("\n---\n");
}

export async function createMailDraft(
  token: string,
  draft: MailDraft,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const to = draft.to.trim();
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  if (!validEmail(to)) return "A draft needs one recipient email address.";
  if (!subject || !body) return "A draft needs a subject and a body.";
  const created = (await graphJson(
    token,
    `${GRAPH}/me/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      }),
    },
    fetchImpl
  )) as { id?: string };
  return `Draft saved in the requester's mailbox. Id: ${created.id ?? "unknown"}. It has not been sent.`;
}

export async function sendMail(
  token: string,
  args: { draftId?: string; to?: string; subject?: string; body?: string },
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const draftId = args.draftId?.trim();
  if (draftId) {
    await graphJson(token, `${GRAPH}/me/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" }, fetchImpl);
    return `Sent draft ${draftId} from the requester's mailbox.`;
  }
  const to = args.to?.trim() ?? "";
  const subject = args.subject?.trim() ?? "";
  const body = args.body?.trim() ?? "";
  if (!validEmail(to) || !subject || !body) {
    return "Sending needs a draft id, or a recipient, subject, and body.";
  }
  await graphJson(
    token,
    `${GRAPH}/me/sendMail`,
    {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "Text", content: body },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    },
    fetchImpl
  );
  return `Sent "${subject}" to ${to} from the requester's mailbox.`;
}
