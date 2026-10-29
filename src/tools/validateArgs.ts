/**
 * Checks model-supplied tool arguments against the tool's declared JSON schema
 * before a handler runs. Deliberately lenient where handlers already coerce
 * (numeric strings for numbers, numbers for strings, enum case), strict where
 * a handler would otherwise act on a missing or unknown value.
 */
type Schema = {
  type?: string;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: unknown[];
};

function numeric(value: unknown): boolean {
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

function typeProblem(key: string, schema: Schema, value: unknown): string | undefined {
  switch (schema.type) {
    case "string":
      return typeof value === "string" || typeof value === "number" ? undefined : `${key} must be a string`;
    case "number":
      return numeric(value) ? undefined : `${key} must be a number`;
    case "integer":
      return numeric(value) && Number.isInteger(Number(value)) ? undefined : `${key} must be an integer`;
    case "boolean":
      return typeof value === "boolean" || value === "true" || value === "false" ? undefined : `${key} must be true or false`;
    case "array":
      return Array.isArray(value) ? undefined : `${key} must be an array`;
    case "object":
      return value && typeof value === "object" && !Array.isArray(value) ? undefined : `${key} must be an object`;
    default:
      return undefined;
  }
}

function inEnum(options: unknown[], value: unknown): boolean {
  return options.some((option) =>
    typeof option === "string" && typeof value === "string"
      ? option.toLowerCase() === value.toLowerCase()
      : typeof option === "number"
        ? numeric(value) && Number(value) === option
        : option === value
  );
}

function valueProblem(key: string, schema: Schema, value: unknown): string | undefined {
  const typeIssue = typeProblem(key, schema, value);
  if (typeIssue) return typeIssue;
  if (schema.enum?.length && !inEnum(schema.enum, value)) {
    return `${key} must be one of ${schema.enum.map(String).join(", ")}`;
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = valueProblem(`${key}[${index}]`, schema.items, item);
      if (issue) return issue;
    }
  }
  return undefined;
}

export function validateToolArgs(schema: unknown, args: Record<string, unknown>): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const root = schema as Schema;
  const required = Array.isArray(root.required) ? root.required.map(String) : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") return `missing required argument ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const property = root.properties?.[key];
    if (!property || value === undefined || value === null) continue;
    const issue = valueProblem(key, property, value);
    if (issue) return issue;
  }
  return undefined;
}
