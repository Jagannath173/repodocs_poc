import * as path from "node:path";
import * as fs from "node:fs/promises";

export async function renderPromptTemplate(
  extensionPath: string,
  templateRelPath: string,
  inputVars: Record<string, string>
): Promise<string> {
  const promptRoot = path.join(extensionPath, "python", "prompts");
  let template = await loadTemplateRecursive(promptRoot, templateRelPath, new Set<string>());
  const vars: Record<string, string> = { ...inputVars };

  template = template.replace(/{%\s*set\s+(\w+)\s*=\s*"([\s\S]*?)"\s*%}/g, (_, name: string, val: string) => {
    vars[name] = val.replace(/\\"/g, "\"");
    return "";
  });

  let prev = "";
  while (prev !== template) {
    prev = template;
    template = template.replace(
      /{%\s*if\s+(\w+)\s*%}([\s\S]*?)(?:{%\s*else\s*%}([\s\S]*?))?{%\s*endif\s*%}/g,
      (_, name: string, ifPart: string, elsePart?: string) => (vars[name] ? ifPart : elsePart ?? "")
    );
  }

  template = template.replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => vars[name] ?? "");
  template = template.replace(/{%[\s\S]*?%}/g, "");
  template = template.replace(/{{[\s\S]*?}}/g, "");
  return template;
}

async function loadTemplateRecursive(root: string, relPath: string, seen: Set<string>): Promise<string> {
  const normalized = relPath.replace(/\\/g, "/");
  if (seen.has(normalized)) {
    return "";
  }
  seen.add(normalized);
  const fullPath = path.join(root, normalized);
  let content = await fs.readFile(fullPath, "utf8");

  const includeRegex = /{%\s*include\s+'([^']+)'\s*%}/g;
  let match: RegExpExecArray | null;
  while ((match = includeRegex.exec(content)) !== null) {
    const includePath = match[1];
    const includeContent = await loadTemplateRecursive(root, includePath, seen);
    content = content.replace(match[0], includeContent);
    includeRegex.lastIndex = 0;
  }
  return content;
}
