import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import type { SkillEntry } from "../types.js";

/** Default filesystem path where shared skills are stored. */
const SHARED_SKILLS_PATH = process.env.SHARED_SKILLS_PATH ?? "/data/shared-skills";

/**
 * Creates an Express router that lists and retrieves shared skill
 * definitions from the filesystem and persists metadata to the database.
 * @param prisma - Prisma ORM client for skill metadata persistence
 * @returns Configured Express Router
 */
export function skillsRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** List all shared skills (scans filesystem + syncs to DB). */
  router.get("/", async function _listSkills(req, res)
  {
    const skills: SkillEntry[] = [];

    await _scanSkillDir(join(SHARED_SKILLS_PATH, "org"), "org", skills);

    try
    {
      const teams = await readdir(join(SHARED_SKILLS_PATH, "teams"), { withFileTypes: true });
      for (const team of teams)
      {
        if (team.isDirectory())
        {
          await _scanSkillDir(join(SHARED_SKILLS_PATH, "teams", team.name), "team", skills);
        }
      }
    }
    catch
    {
      // No teams directory
    }

    // Sync discovered skills to the database
    for (const skill of skills)
    {
      await prisma.skill.upsert({
        where: { name_scope_team: { name: skill.name, scope: skill.scope, team: "" } },
        create: { name: skill.name, scope: skill.scope, team: "", path: skill.path },
        update: { path: skill.path },
      });
    }

    res.json(skills);
  });

  /** Get a specific skill's content by scope and name. */
  router.get("/:scope/:name", async function _getSkill(req, res)
  {
    const scope = req.params.scope;
    const name = req.params.name;

    const skillPath = scope === "org"
      ? join(SHARED_SKILLS_PATH, "org", name, "SKILL.md")
      : join(SHARED_SKILLS_PATH, "teams", scope, name, "SKILL.md");

    try
    {
      const file = await readFile(skillPath, "utf-8");
      res.json({ name, scope, content: file });
    }
    catch
    {
      res.status(404).json({ error: "Skill not found" });
    }
  });

  return router;
}

/**
 * Scans a directory for skill subdirectories and appends entries
 * to the provided skills array.
 * @param dir - Directory path to scan
 * @param scope - Visibility scope of discovered skills
 * @param skills - Accumulator array for found skill entries
 */
async function _scanSkillDir(dir: string, scope: "org" | "team", skills: SkillEntry[]): Promise<void>
{
  try
  {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries)
    {
      if (entry.isDirectory())
      {
        skills.push({
          name: entry.name,
          scope,
          path: join(dir, entry.name),
        });
      }
    }
  }
  catch
  {
    // Directory doesn't exist, skip
  }
}
