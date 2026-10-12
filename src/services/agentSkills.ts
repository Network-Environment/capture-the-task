import { loadConfig } from "../config";

export interface AgentSkill {
  description: string;
  when: string[];
  tools: string[];
  instructions: string[];
}

interface SkillsConfig {
  skills: Record<string, AgentSkill>;
}

const skillsConfig = loadConfig<SkillsConfig>("skills");

export function agentSkillCatalog(): { name: string; skill: AgentSkill }[] {
  return Object.entries(skillsConfig.skills).map(([name, skill]) => ({ name, skill }));
}

const JUDGMENT_READ_TOOLS = ["recall_notes", "recall_memory", "search_execution_graph"] as const;

/** An explicit evaluation of a plan. "What do you think they mean?" is not one. */
export function explicitEvaluationRequest(text: string): boolean {
  return /\bwhat do you think of\b|\bis this sound\b|\bpressure[-\s]?test\b|\bpoke holes\b/i.test(text);
}

/** Record reads the thoughtful-judgment skill requires before an answer. */
export function judgmentReadToolNames(available: Iterable<string>): string[] {
  const have = new Set(available);
  return JUDGMENT_READ_TOOLS.filter((name) => have.has(name));
}

export function agentSkillsPromptBlock(names: string[] = []): string {
  if (!names.length) return "";
  const blocks = names.map((name) => {
    const skill = skillsConfig.skills[name];
    if (!skill) throw new Error(`Agent profile references unknown skill "${name}".`);
    return [
      `Skill: ${name}`,
      `Use when: ${skill.when.join("; ")}`,
      ...skill.instructions.map((instruction) => `- ${instruction}`),
    ].join("\n");
  });
  return `\n\nRepeatable agent skills:\n${blocks.join("\n\n")}`;
}
