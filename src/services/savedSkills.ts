/**
 * Skills a person saved from a finished tool trace. Separate from the
 * repo skill catalog. Running one still goes through the normal tool policy.
 */
import { cosmosContainer, cosmosConfigured } from "./cosmos";

export interface SavedSkill {
  id: string;
  userId: string;
  scope: "user" | "org";
  name: string;
  description: string;
  when: string[];
  tools: string[];
  confirmationPoints: string[];
  instructions: string[];
  createdAt: string;
}

export interface ToolTrace {
  id: "latest";
  userId: string;
  tools: string[];
  updatedAt: string;
}

function skills() {
  return cosmosContainer("saved-skills");
}

function traces() {
  return cosmosContainer("skill-traces");
}

export async function recordToolTrace(userId: string, tools: string[]): Promise<void> {
  const names = tools.map((tool) => tool.trim()).filter((tool) => tool && tool !== "save_skill");
  if (!names.length || !cosmosConfigured()) return;
  const doc: ToolTrace = {
    id: "latest",
    userId,
    tools: names.slice(-20),
    updatedAt: new Date().toISOString(),
  };
  try {
    await traces().items.upsert(doc);
  } catch (err) {
    console.error("[skills] trace save failed:", err);
  }
}

export async function latestToolTrace(userId: string): Promise<string[]> {
  if (!cosmosConfigured()) return [];
  try {
    const { resource } = await traces().item("latest", userId).read<ToolTrace>();
    return Array.isArray(resource?.tools) ? resource.tools.map(String) : [];
  } catch {
    return [];
  }
}

export async function saveUserSkill(
  userId: string,
  skill: Omit<SavedSkill, "id" | "userId" | "createdAt">
): Promise<SavedSkill> {
  const doc: SavedSkill = {
    id: `skill-${Date.now()}`,
    userId: skill.scope === "org" ? "org" : userId,
    createdAt: new Date().toISOString(),
    ...skill,
    name: skill.name.trim(),
    description: skill.description.trim(),
    when: skill.when.map((item) => item.trim()).filter(Boolean),
    tools: [...new Set(skill.tools.map((item) => item.trim()).filter(Boolean))],
    confirmationPoints: [...new Set(skill.confirmationPoints)],
    instructions: skill.instructions.map((item) => item.trim()).filter(Boolean),
  };
  await skills().items.create(doc);
  return doc;
}

export async function listSavedSkills(userId: string): Promise<SavedSkill[]> {
  if (!cosmosConfigured()) return [];
  try {
    const { resources } = await skills()
      .items.query({
        query: "SELECT * FROM c WHERE c.userId = @u OR c.userId = @org",
        parameters: [
          { name: "@u", value: userId },
          { name: "@org", value: "org" },
        ],
      })
      .fetchAll();
    return resources as SavedSkill[];
  } catch {
    return [];
  }
}

export function formatSavedSkills(rows: SavedSkill[]): string {
  if (!rows.length) return "";
  const blocks = rows.map((skill) =>
    [
      `Saved skill: ${skill.name} (${skill.scope})`,
      skill.description,
      skill.when.length ? `Use when: ${skill.when.join("; ")}` : "",
      `Tools, in order: ${skill.tools.join(", ") || "none recorded"}`,
      skill.confirmationPoints.length
        ? `These still wait for approval: ${skill.confirmationPoints.join(", ")}`
        : "No extra confirmation points were recorded.",
      ...skill.instructions.map((line) => `- ${line}`),
      "- Running this skill does not skip the normal approval gate.",
    ]
      .filter(Boolean)
      .join("\n")
  );
  return `\n\nSaved skills:\n${blocks.join("\n\n")}`;
}

export async function savedSkillsPromptBlock(userId: string): Promise<string> {
  return formatSavedSkills(await listSavedSkills(userId));
}
