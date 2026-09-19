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
