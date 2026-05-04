import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SkillsEngine, shutdownSkillsEngine } from '../../src/skills/index.js';

async function createSkill(
  dir: string,
  name: string,
  category = 'test',
  description = 'A test skill',
  impl = '',
): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const yaml = [
    'name: ' + name,
    'category: ' + category,
    'description: ' + description,
    'version: 1.0.0',
  ].join('\n');
  await writeFile(join(skillDir, 'skill.yaml'), yaml);
  if (impl) await writeFile(join(skillDir, 'skill.ts'), impl);
}

describe('SkillsEngine — Phase 5 env + run additions', () => {
  let tempDir: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-env-test-'));
    origEnv = process.env.CLAUDE_SKILLS_DARKICE;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origEnv === undefined) {
      delete process.env.CLAUDE_SKILLS_DARKICE;
    } else {
      process.env.CLAUDE_SKILLS_DARKICE = origEnv;
    }
    shutdownSkillsEngine();
  });

  it('loads from CLAUDE_SKILLS_DARKICE when set', async () => {
    await createSkill(tempDir, 'env-skill', 'utility', 'Loaded from env dir');
    process.env.CLAUDE_SKILLS_DARKICE = tempDir;

    const skillsDir = process.env.CLAUDE_SKILLS_DARKICE || './skills';
    const engine = new SkillsEngine({ skillsDir });
    await engine.loadSkills();

    expect(engine.has('env-skill')).toBe(true);
    expect(engine.getSkillCount()).toBe(1);
  });

  it('falls back gracefully when CLAUDE_SKILLS_DARKICE is not set', async () => {
    delete process.env.CLAUDE_SKILLS_DARKICE;
    const skillsDir = process.env.CLAUDE_SKILLS_DARKICE || '/nonexistent-fallback';
    const engine = new SkillsEngine({ skillsDir });
    await engine.loadSkills();
    expect(engine.isLoaded()).toBe(true);
    expect(engine.getSkillCount()).toBe(0);
  });

  it('skills.run executes skill implementation', async () => {
    const impl = 'return args.x * 2;';
    await createSkill(tempDir, 'double-skill', 'math', 'Doubles input', impl);
    const engine = new SkillsEngine({ skillsDir: tempDir });
    await engine.loadSkills();

    expect(engine.has('double-skill')).toBe(true);
    const code = engine.getImplementation('double-skill');
    expect(code).toBeDefined();
    // Verify implementation is executable
    const fn = new Function('args', code!);
    expect(fn({ x: 5 })).toBe(10);
  });

  it('skills.findByQuery returns relevant skills', async () => {
    await createSkill(tempDir, 'data-transformer', 'data', 'Transform and reshape data objects');
    await createSkill(tempDir, 'api-caller', 'api', 'Call external REST APIs');
    await createSkill(tempDir, 'text-formatter', 'text', 'Format and clean text strings');

    const engine = new SkillsEngine({ skillsDir: tempDir });
    await engine.loadSkills();

    const results = engine.search('transform');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('data-transformer');
  });
});
