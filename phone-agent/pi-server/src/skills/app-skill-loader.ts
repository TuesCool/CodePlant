import fs from "node:fs";
import path from "node:path";

export interface AppSkill {
  id: string;
  name: string;
  packageName?: string;
  triggers: string[];
  body: string;
  filePath: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw.trim() };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw.trim() };
  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const meta: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { meta, body };
}

export class AppSkillLoader {
  constructor(private readonly skillsDir: string) {
    fs.mkdirSync(this.skillsDir, { recursive: true });
  }

  loadAll(): AppSkill[] {
    if (!fs.existsSync(this.skillsDir)) return [];
    const files = fs.readdirSync(this.skillsDir).filter((f) => f.endsWith(".md"));
    return files.map((file) => {
      const fullPath = path.join(this.skillsDir, file);
      const raw = fs.readFileSync(fullPath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      return {
        id: path.basename(file, ".md"),
        name: meta.name || path.basename(file, ".md"),
        packageName: meta.package || undefined,
        triggers: (meta.triggers || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        body,
        filePath: fullPath,
      };
    });
  }

  buildPromptSection(): string {
    const skills = this.loadAll();
    if (skills.length === 0) return "";
    return (
      "\n\n## 已接入的手机 App 技能库（skills/apps）\n" +
      skills
        .map(
          (s) =>
            `### ${s.name}${s.packageName ? ` (${s.packageName})` : ""}\n${s.body}`,
        )
        .join("\n\n")
    );
  }
}
