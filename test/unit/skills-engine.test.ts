import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  SkillsEngine,
  getSkillsEngine,
  shutdownSkillsEngine,
  type SkillsEngineConfig,
} from '../../src/skills/index.js';

describe('SkillsEngine', () => {
  let tempDir: string;
  let engine: SkillsEngine;

  beforeEach(async () => {
    // Create temp directory for test skills
    tempDir = await mkdtemp(join(tmpdir(), 'skills-test-'));
    engine = new SkillsEngine({ skillsDir: tempDir });
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
    shutdownSkillsEngine();
  });

  describe('constructor', () => {
    it('should create engine with config', () => {
      const config: SkillsEngineConfig = {
        skillsDir: '/test/skills',
        watchEnabled: true,
        allowedCategories: ['data', 'api'],
      };
      const eng = new SkillsEngine(config);
      expect(eng).toBeInstanceOf(SkillsEngine);
      expect(eng.isLoaded()).toBe(false);
    });

    it('should use default config values', () => {
      const eng = new SkillsEngine({ skillsDir: '/test/skills' });
      expect(eng).toBeInstanceOf(SkillsEngine);
    });
  });

  describe('loadSkills', () => {
    it('should handle non-existent skills directory gracefully', async () => {
      const eng = new SkillsEngine({ skillsDir: '/non/existent/path' });
      await eng.loadSkills();
      expect(eng.isLoaded()).toBe(true);
      expect(eng.getSkillCount()).toBe(0);
    });

    it('should load skills from directory', async () => {
      // Create a test skill
      const skillDir = join(tempDir, 'test-skill');
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        `name: test-skill
category: testing
description: A test skill for unit tests
version: 1.0.0
tags:
  - test
  - demo`
      );
      await writeFile(
        join(skillDir, 'skill.ts'),
        `export function hello() { return 'world'; }`
      );

      await engine.loadSkills();
      expect(engine.isLoaded()).toBe(true);
      expect(engine.getSkillCount()).toBe(1);
      expect(engine.has('test-skill')).toBe(true);
    });

    it('should emit loaded event', async () => {
      const handler = vi.fn();
      engine.on('loaded', handler);

      await engine.loadSkills();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          count: 0,
          categories: [],
        })
      );
    });

    it('should skip skills with missing required fields', async () => {
      const skillDir = join(tempDir, 'incomplete-skill');
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        `name: incomplete
description: Missing category`
      );

      await engine.loadSkills();
      expect(engine.getSkillCount()).toBe(0);
    });

    it('should filter by allowed categories', async () => {
      const eng = new SkillsEngine({
        skillsDir: tempDir,
        allowedCategories: ['data'],
      });

      // Create two skills in different categories
      const dataSkillDir = join(tempDir, 'data-skill');
      await mkdir(dataSkillDir);
      await writeFile(
        join(dataSkillDir, 'skill.yaml'),
        `name: data-skill
category: data
description: A data skill`
      );

      const apiSkillDir = join(tempDir, 'api-skill');
      await mkdir(apiSkillDir);
      await writeFile(
        join(apiSkillDir, 'skill.yaml'),
        `name: api-skill
category: api
description: An API skill`
      );

      await eng.loadSkills();
      expect(eng.getSkillCount()).toBe(1);
      expect(eng.has('data-skill')).toBe(true);
      expect(eng.has('api-skill')).toBe(false);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // Create test skills
      const skill1Dir = join(tempDir, 'skill-one');
      await mkdir(skill1Dir);
      await writeFile(
        join(skill1Dir, 'skill.yaml'),
        `name: skill-one
category: utils
description: First skill
version: 1.0.0`
      );

      const skill2Dir = join(tempDir, 'skill-two');
      await mkdir(skill2Dir);
      await writeFile(
        join(skill2Dir, 'skill.yaml'),
        `name: skill-two
category: data
description: Second skill
version: 2.0.0`
      );

      await engine.loadSkills();
    });

    it('should list all skills', () => {
      const list = engine.list();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.name)).toContain('skill-one');
      expect(list.map((s) => s.name)).toContain('skill-two');
    });

    it('should include metadata in list', () => {
      const list = engine.list();
      const skill = list.find((s) => s.name === 'skill-one');
      expect(skill).toBeDefined();
      expect(skill?.category).toBe('utils');
      expect(skill?.description).toBe('First skill');
      expect(skill?.version).toBe('1.0.0');
    });
  });

  describe('listByCategory', () => {
    beforeEach(async () => {
      // Create test skills in different categories
      for (const cat of ['utils', 'utils', 'data']) {
        const skillDir = join(tempDir, `${cat}-skill-${Math.random()}`);
        await mkdir(skillDir);
        await writeFile(
          join(skillDir, 'skill.yaml'),
          `name: ${cat}-skill-${Math.random().toString(36).slice(2)}
category: ${cat}
description: A ${cat} skill`
        );
      }

      await engine.loadSkills();
    });

    it('should list skills by category', () => {
      const utilsSkills = engine.listByCategory('utils');
      expect(utilsSkills).toHaveLength(2);
      expect(utilsSkills.every((s) => s.category === 'utils')).toBe(true);
    });

    it('should return empty array for non-existent category', () => {
      const skills = engine.listByCategory('nonexistent');
      expect(skills).toEqual([]);
    });
  });

  describe('getCategories', () => {
    it('should return all categories', async () => {
      const skill1Dir = join(tempDir, 'cat1-skill');
      await mkdir(skill1Dir);
      await writeFile(
        join(skill1Dir, 'skill.yaml'),
        `name: cat1-skill
category: category-one
description: First category skill`
      );

      const skill2Dir = join(tempDir, 'cat2-skill');
      await mkdir(skill2Dir);
      await writeFile(
        join(skill2Dir, 'skill.yaml'),
        `name: cat2-skill
category: category-two
description: Second category skill`
      );

      await engine.loadSkills();

      const categories = engine.getCategories();
      expect(categories).toContain('category-one');
      expect(categories).toContain('category-two');
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      // Create searchable skills
      const skills = [
        { name: 'data-processor', category: 'data', description: 'Processes data files', tags: ['csv', 'json'] },
        { name: 'api-client', category: 'api', description: 'HTTP API client', tags: ['http', 'rest'] },
        { name: 'file-utils', category: 'utils', description: 'File utility functions', tags: ['files', 'io'] },
      ];

      for (const skill of skills) {
        const skillDir = join(tempDir, skill.name);
        await mkdir(skillDir);
        await writeFile(
          join(skillDir, 'skill.yaml'),
          `name: ${skill.name}
category: ${skill.category}
description: ${skill.description}
tags:
  - ${skill.tags[0]}
  - ${skill.tags[1]}`
        );
      }

      await engine.loadSkills();
    });

    it('should search by name', () => {
      const results = engine.search('data-processor');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('data-processor');
      expect(results[0].relevance).toBe(100);
    });

    it('should search by partial name', () => {
      const results = engine.search('api');
      expect(results.some((r) => r.name === 'api-client')).toBe(true);
    });

    it('should search by category', () => {
      const results = engine.search('utils');
      expect(results.some((r) => r.name === 'file-utils')).toBe(true);
    });

    it('should search by description', () => {
      const results = engine.search('HTTP');
      expect(results.some((r) => r.name === 'api-client')).toBe(true);
    });

    it('should search by tags', () => {
      const results = engine.search('json');
      expect(results.some((r) => r.name === 'data-processor')).toBe(true);
    });

    it('should return empty array for no matches', () => {
      const results = engine.search('nonexistent');
      expect(results).toEqual([]);
    });

    it('should return empty array for empty query', () => {
      const results = engine.search('');
      expect(results).toEqual([]);
    });

    it('should sort results by relevance', () => {
      const results = engine.search('data');
      expect(results.length).toBeGreaterThan(0);
      // Results should be sorted by relevance descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].relevance).toBeGreaterThanOrEqual(results[i].relevance);
      }
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      const skillDir = join(tempDir, 'get-test-skill');
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        `name: get-test-skill
category: test
description: A skill for get tests`
      );
      await writeFile(join(skillDir, 'skill.ts'), `export const value = 42;`);

      await engine.loadSkills();
    });

    it('should get skill by name', () => {
      const skill = engine.get('get-test-skill');
      expect(skill).toBeDefined();
      expect(skill?.metadata.name).toBe('get-test-skill');
    });

    it('should return undefined for non-existent skill', () => {
      const skill = engine.get('nonexistent');
      expect(skill).toBeUndefined();
    });
  });

  describe('getImplementation', () => {
    beforeEach(async () => {
      const skillDir = join(tempDir, 'impl-test-skill');
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        `name: impl-test-skill
category: test
description: A skill with implementation`
      );
      await writeFile(join(skillDir, 'skill.ts'), `export function run() { return 'implemented'; }`);

      await engine.loadSkills();
    });

    it('should get skill implementation', () => {
      const impl = engine.getImplementation('impl-test-skill');
      expect(impl).toContain('export function run()');
    });

    it('should return undefined for non-existent skill', () => {
      const impl = engine.getImplementation('nonexistent');
      expect(impl).toBeUndefined();
    });
  });

  describe('getMetadata', () => {
    beforeEach(async () => {
      const skillDir = join(tempDir, 'meta-test-skill');
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        `name: meta-test-skill
category: metadata
description: A skill for metadata tests
version: 3.0.0`
      );

      await engine.loadSkills();
    });

    it('should get skill metadata', () => {
      const meta = engine.getMetadata('meta-test-skill');
      expect(meta).toBeDefined();
      expect(meta?.name).toBe('meta-test-skill');
      expect(meta?.category).toBe('metadata');
      expect(meta?.version).toBe('3.0.0');
    });

    it('should return undefined for non-existent skill', () => {
      const meta = engine.getMetadata('nonexistent');
      expect(meta).toBeUndefined();
    });
  });

  describe('has', () => {
    beforeEach(async () => {
      const skillDir = join(tempDir, 'has-test-skill');
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        `name: has-test-skill
category: test
description: A skill for has tests`
      );

      await engine.loadSkills();
    });

    it('should return true for existing skill', () => {
      expect(engine.has('has-test-skill')).toBe(true);
    });

    it('should return false for non-existent skill', () => {
      expect(engine.has('nonexistent')).toBe(false);
    });
  });

  describe('reload', () => {
    it('should reload skills', async () => {
      await engine.loadSkills();
      expect(engine.getSkillCount()).toBe(0);

      // Add a new skill
      const skillDir = join(tempDir, 'new-skill');
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        `name: new-skill
category: test
description: A newly added skill`
      );

      await engine.reload();
      expect(engine.getSkillCount()).toBe(1);
    });

    it('should emit reloaded event', async () => {
      const handler = vi.fn();
      engine.on('reloaded', handler);

      await engine.reload();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          count: 0,
        })
      );
    });
  });

  describe('generateSkillLoader', () => {
    beforeEach(async () => {
      const skillDir = join(tempDir, 'loader-test-skill');
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, 'skill.yaml'),
        `name: loader-test-skill
category: test
description: A skill for loader tests`
      );
      await writeFile(
        join(skillDir, 'skill.ts'),
        `export function greet(name: string) { return \`Hello, \${name}!\`; }`
      );

      await engine.loadSkills();
    });

    it('should generate skill loader code', () => {
      const loaderCode = engine.generateSkillLoader('loader-test-skill');
      expect(loaderCode).toContain('// Skill: loader-test-skill');
      expect(loaderCode).toContain('// Category: test');
      expect(loaderCode).toContain('export function greet');
    });

    it('should return null for non-existent skill', () => {
      const loaderCode = engine.generateSkillLoader('nonexistent');
      expect(loaderCode).toBeNull();
    });

    it('should return null for skill without implementation', async () => {
      const noImplDir = join(tempDir, 'no-impl-skill');
      await mkdir(noImplDir);
      await writeFile(
        join(noImplDir, 'skill.yaml'),
        `name: no-impl-skill
category: test
description: A skill without implementation`
      );

      await engine.reload();

      const loaderCode = engine.generateSkillLoader('no-impl-skill');
      expect(loaderCode).toBeNull();
    });
  });
});

describe('Global skills engine', () => {
  let tempDir: string;

  beforeEach(async () => {
    shutdownSkillsEngine();
    tempDir = await mkdtemp(join(tmpdir(), 'global-skills-test-'));
  });

  afterEach(async () => {
    shutdownSkillsEngine();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should require config on first call', () => {
    expect(() => getSkillsEngine()).toThrow('Skills engine not initialised');
  });

  it('should return singleton instance', () => {
    const engine1 = getSkillsEngine({ skillsDir: tempDir });
    const engine2 = getSkillsEngine();
    expect(engine1).toBe(engine2);
  });

  it('should create new instance after shutdown', () => {
    const engine1 = getSkillsEngine({ skillsDir: tempDir });
    shutdownSkillsEngine();
    const engine2 = getSkillsEngine({ skillsDir: tempDir });
    expect(engine1).not.toBe(engine2);
  });
});
