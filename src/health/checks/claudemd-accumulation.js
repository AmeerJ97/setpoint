import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR, PROJECTS_DIR } from '../../data/paths.js';

const CHARS_PER_TOKEN = 4; // rough estimate

export function checkClaudeMdAccumulation() {
  const issues = [];
  let totalChars = 0;
  const files = [];

  // User-scope CLAUDE.md
  const userMd = join(CLAUDE_DIR, 'CLAUDE.md');
  if (existsSync(userMd)) {
    const size = readFileSync(userMd, 'utf8').length;
    totalChars += size;
    files.push({ path: '~/.claude/CLAUDE.md', chars: size });
  }

  // Count rules
  const rulesDir = join(CLAUDE_DIR, 'rules');
  if (existsSync(rulesDir)) {
    const ruleChars = countMdChars(rulesDir);
    totalChars += ruleChars;
    if (ruleChars > 0) files.push({ path: '~/.claude/rules/', chars: ruleChars });
  }

  const estimatedTokens = Math.round(totalChars / CHARS_PER_TOKEN);
  if (estimatedTokens > 10000) {
    issues.push({
      severity: 'warning',
      check: 'claudemd-accumulation',
      message: `CLAUDE.md chain ~${estimatedTokens} tokens across ${files.length} locations`,
      files,
    });
  } else {
    issues.push({
      severity: 'info',
      check: 'claudemd-accumulation',
      message: `CLAUDE.md chain ~${estimatedTokens} tokens`,
    });
  }

  return issues;
}

function countMdChars(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) total += countMdChars(p);
      else if (entry.name.endsWith('.md')) {
        try { total += readFileSync(p, 'utf8').length; } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return total;
}
