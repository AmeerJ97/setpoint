import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR } from './paths.js';

const SKILL_FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const LARGE_CORPUS_TOKENS = 100_000;
const TOO_MANY_SKILLS = 100;
const MAX_SKILL_LINES = 500;
const CHARS_PER_TOKEN = 3.5;

export function inspectSkillSurface(skillRoot = join(CLAUDE_DIR, 'skills')) {
  if (!existsSync(skillRoot)) {
    return {
      root: skillRoot,
      totalSkills: 0,
      validSkills: 0,
      invalidSkills: 0,
      oversizedSkills: 0,
      corpusTokens: 0,
      corpusLarge: false,
      entries: [],
    };
  }

  const entries = [];
  let corpusChars = 0;
  for (const entry of readdirSync(skillRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillRoot, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) {
      entries.push({ name: entry.name, path: skillPath, valid: false, oversized: false, reason: 'missing SKILL.md', tokens: 0 });
      continue;
    }
    let raw = '';
    try { raw = readFileSync(skillPath, 'utf8'); } catch { raw = ''; }
    corpusChars += raw.length;
    const valid = hasExpectedFrontmatter(raw);
    const lineCount = raw.split('\n').length;
    const oversized = lineCount > MAX_SKILL_LINES;
    entries.push({
      name: entry.name,
      path: skillPath,
      valid,
      oversized,
      reason: !valid ? 'missing name/description frontmatter' : oversized ? `>${MAX_SKILL_LINES} lines` : null,
      tokens: Math.round(raw.length / CHARS_PER_TOKEN),
    });
  }

  const totalSkills = entries.length;
  const invalidSkills = entries.filter(entry => !entry.valid).length;
  const oversizedSkills = entries.filter(entry => entry.oversized).length;
  const corpusTokens = Math.round(corpusChars / CHARS_PER_TOKEN);
  return {
    root: skillRoot,
    totalSkills,
    validSkills: totalSkills - invalidSkills,
    invalidSkills,
    oversizedSkills,
    corpusTokens,
    corpusLarge: corpusTokens >= LARGE_CORPUS_TOKENS || totalSkills >= TOO_MANY_SKILLS,
    entries,
  };
}

function hasExpectedFrontmatter(raw) {
  const match = raw.match(SKILL_FRONTMATTER);
  if (!match) return false;
  return /\bname:\s*\S+/i.test(match[1]) && /\bdescription:\s*.+/i.test(match[1]);
}
