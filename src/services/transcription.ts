/**
 * Azure AI Speech — fast transcription API.
 * Split into download + transcribe so channels that already hold bytes
 * (iMessage via Photon) skip the download step.
 */
const REGION = process.env.SPEECH_REGION!;
const KEY = process.env.SPEECH_KEY!;

export async function downloadAudio(audioUrl: string, bearerToken?: string): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (bearerToken && audioUrl.includes("smba.trafficmanager.net")) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }
  const res = await fetch(audioUrl, { headers });
  if (!res.ok) throw new Error(`audio download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function transcribeBuffer(audioBytes: Buffer): Promise<string> {
  const form = new FormData();
  form.append("definition", JSON.stringify({ locales: ["en-US"], profanityFilterMode: "None" }));
  form.append("audio", new Blob([audioBytes]), "memo.m4a");

  const res = await fetch(
    `https://${REGION}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`,
    { method: "POST", headers: { "Ocp-Apim-Subscription-Key": KEY }, body: form }
  );
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { combinedPhrases?: { text: string }[] };
  return (data.combinedPhrases ?? []).map((p) => p.text).join(" ").trim();
}

export async function transcribeFromUrl(audioUrl: string, bearerToken?: string): Promise<string> {
  return transcribeBuffer(await downloadAudio(audioUrl, bearerToken));
}
