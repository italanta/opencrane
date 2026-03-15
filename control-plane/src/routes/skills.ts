import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { Hono } from "hono";

import type { SkillEntry } from "../types.js";

/** Default filesystem path where shared skills are stored. */
const SHARED_SKILLS_PATH =
  process.env.SHARED_SKILLS_PATH ?? "/data/shared-skills";

/**
 * Creates a Hono sub-router that lists and retrieves shared skill
 * definitions from the filesystem.
 */
export function skillsRouter(): Hono
{
  const router = new Hono();

  // List all shared skills
  router.get("/", async (c) => {
    const skills: SkillEntry[] = [];

    // Scan org skills
    await scanSkillDir(join(SHARED_SKILLS_PATH, "org"), "org", skills);

    // Scan team skills
    try {
      const teams = await readdir(join(SHARED_SKILLS_PATH, "teams"), {
        withFileTypes: true,
      });
      for (const team of teams) {
        if (team.isDirectory()) {
          await scanSkillDir(
            join(SHARED_SKILLS_PATH, "teams", team.name),
            "team",
            skills,
          );
        }
      }
    } catch {
      // No teams directory
    }

    return c.json(skills);
  });

  // Get a specific skill's content
  router.get("/:scope/:name", async (c) => {
    const scope = c.req.param("scope");
    const name = c.req.param("name");

    const skillPath =
      scope === "org"
        ? join(SHARED_SKILLS_PATH, "org", name, "SKILL.md")
        : join(SHARED_SKILLS_PATH, "teams", scope, name, "SKILL.md");

    try {
      const { readFile } = await import("node:fs/promises");
      const file = await readFile(skillPath, "utf-8");
      return c.json({ name, scope, content: file });
    } catch {
      return c.json({ error: "Skill not found" }, 404);
    }
  });

  return router;
}

/**
 * Scans a directory for skill subdirectories and appends entries
 * to the provided skills array.
 */
async function scanSkillDir(
  dir: string,
  scope: "org" | "team",
  skills: SkillEntry[],
): Promise<void>
{
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        skills.push({
          name: entry.name,
          scope,
          path: join(dir, entry.name),
        });
      }
    }
  } catch {
    // Directory doesn't exist, skip
  }
}
