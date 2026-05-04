/**
 * Skills Engine
 *
 * Loads and manages skill modules that provide reusable functionality
 * for code execution in the sandbox.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/index.js';

export interface SkillMetadata {
  name: string;
  category: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  inputs?: SkillInput[];
  outputs?: SkillOutput[];
}

export interface SkillInput {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface SkillOutput {
  name: string;
  type: string;
  description: string;
}

export interface Skill {
  metadata: SkillMetadata;
  implementation: string;
  path: string;
  loadedAt: Date;
}

export interface SkillSearchResult {
  name: string;
  category: string;
  description: string;
  relevance: number;
  tags?: string[];
}

export interface SkillListItem {
  name: string;
  category: string;
  description: string;
  version?: string;
  tags?: string[];
}

export interface SkillsEngineConfig {
  /** Directory containing skill modules */
  skillsDir: string;
  /** Enable watching for changes */
  watchEnabled?: boolean;
  /** Allowed categories (empty = all) */
  allowedCategories?: string[];
}

/**
 * Skills Engine for managing reusable code modules
 */
export class SkillsEngine extends EventEmitter {
  private config: SkillsEngineConfig;
  private skills: Map<string, Skill> = new Map();
  private categories: Map<string, Set<string>> = new Map();
  private loaded = false;

  constructor(config: SkillsEngineConfig) {
    super();
    this.config = {
      watchEnabled: false,
      allowedCategories: [],
      ...config,
    };
  }

  /**
   * Load all skills from the skills directory
   */
  async loadSkills(): Promise<void> {
    this.skills.clear();
    this.categories.clear();

    try {
      const dirStat = await stat(this.config.skillsDir).catch(() => null);
      if (!dirStat || !dirStat.isDirectory()) {
        logger.debug('Skills directory not found, skipping skill loading', {
          skillsDir: this.config.skillsDir,
        });
        this.loaded = true;
        return;
      }

      await this.scanDirectory(this.config.skillsDir);
      this.loaded = true;

      logger.info('Skills loaded', {
        count: this.skills.size,
        categories: Array.from(this.categories.keys()),
      });

      this.emit('loaded', {
        count: this.skills.size,
        categories: Array.from(this.categories.keys()),
      });
    } catch (error) {
      logger.error('Failed to load skills', { error: String(error) });
      throw error;
    }
  }

  /**
   * Scan a directory for skill modules
   */
  private async scanDirectory(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Check for skill.yaml or skill.yml in directory
        const yamlPath = await this.findSkillYaml(fullPath);
        if (yamlPath) {
          await this.loadSkill(fullPath, yamlPath);
        } else {
          // Recurse into subdirectory
          await this.scanDirectory(fullPath);
        }
      } else if (entry.name === 'skill.yaml' || entry.name === 'skill.yml') {
        // Single-file skill in parent directory
        await this.loadSkill(dir, fullPath);
      }
    }
  }

  /**
   * Find skill.yaml or skill.yml in a directory
   */
  private async findSkillYaml(dir: string): Promise<string | null> {
    for (const name of ['skill.yaml', 'skill.yml']) {
      const path = join(dir, name);
      const exists = await stat(path)
        .then((s) => s.isFile())
        .catch(() => false);
      if (exists) {
        return path;
      }
    }
    return null;
  }

  /**
   * Load a single skill from its directory
   */
  private async loadSkill(skillDir: string, yamlPath: string): Promise<void> {
    try {
      // Read and parse YAML metadata
      const yamlContent = await readFile(yamlPath, 'utf-8');
      const metadata = this.parseYaml(yamlContent);

      if (!metadata.name || !metadata.category || !metadata.description) {
        logger.warn('Skill missing required fields', { path: yamlPath });
        return;
      }

      // Check category filter
      if (
        this.config.allowedCategories &&
        this.config.allowedCategories.length > 0 &&
        !this.config.allowedCategories.includes(metadata.category)
      ) {
        logger.debug('Skill category not allowed', {
          skill: metadata.name,
          category: metadata.category,
        });
        return;
      }

      // Find implementation file
      const implPath = await this.findImplementation(skillDir);
      let implementation = '';

      if (implPath) {
        implementation = await readFile(implPath, 'utf-8');
      }

      const skill: Skill = {
        metadata,
        implementation,
        path: skillDir,
        loadedAt: new Date(),
      };

      this.skills.set(metadata.name, skill);

      // Track category
      if (!this.categories.has(metadata.category)) {
        this.categories.set(metadata.category, new Set());
      }
      this.categories.get(metadata.category)!.add(metadata.name);

      logger.debug('Loaded skill', {
        name: metadata.name,
        category: metadata.category,
      });
    } catch (error) {
      logger.warn('Failed to load skill', { path: yamlPath, error: String(error) });
    }
  }

  /**
   * Find implementation file (skill.ts or index.ts)
   */
  private async findImplementation(dir: string): Promise<string | null> {
    for (const name of ['skill.ts', 'index.ts', 'skill.js', 'index.js']) {
      const path = join(dir, name);
      const exists = await stat(path)
        .then((s) => s.isFile())
        .catch(() => false);
      if (exists) {
        return path;
      }
    }
    return null;
  }

  /**
   * Simple YAML parser for skill metadata
   * Supports basic key: value pairs and arrays
   */
  private parseYaml(content: string): SkillMetadata {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');
    let currentKey = '';
    let inArray = false;
    let arrayValues: unknown[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Check for array item
      if (trimmed.startsWith('- ') && inArray) {
        const value = trimmed.slice(2).trim();
        arrayValues.push(this.parseYamlValue(value));
        continue;
      }

      // End previous array if we're starting a new key
      if (inArray && !trimmed.startsWith('- ')) {
        result[currentKey] = arrayValues;
        inArray = false;
        arrayValues = [];
      }

      // Parse key: value
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > 0) {
        const key = trimmed.slice(0, colonIndex).trim();
        const value = trimmed.slice(colonIndex + 1).trim();

        if (!value) {
          // Start of array or nested object
          currentKey = key;
          inArray = true;
          arrayValues = [];
        } else {
          result[key] = this.parseYamlValue(value);
        }
      }
    }

    // Handle trailing array
    if (inArray && currentKey) {
      result[currentKey] = arrayValues;
    }

    return result as unknown as SkillMetadata;
  }

  /**
   * Parse a YAML value
   */
  private parseYamlValue(value: string): unknown {
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }

    // Boolean
    if (value === 'true') return true;
    if (value === 'false') return false;

    // Null
    if (value === 'null' || value === '~') return null;

    // Number
    const num = Number(value);
    if (!isNaN(num) && value !== '') return num;

    return value;
  }

  /**
   * List all available skills
   */
  list(): SkillListItem[] {
    return Array.from(this.skills.values()).map((skill) => ({
      name: skill.metadata.name,
      category: skill.metadata.category,
      description: skill.metadata.description,
      version: skill.metadata.version,
      tags: skill.metadata.tags,
    }));
  }

  /**
   * List skills by category
   */
  listByCategory(category: string): SkillListItem[] {
    const skillNames = this.categories.get(category);
    if (!skillNames) return [];

    return Array.from(skillNames)
      .map((name) => this.skills.get(name))
      .filter((s): s is Skill => s !== undefined)
      .map((skill) => ({
        name: skill.metadata.name,
        category: skill.metadata.category,
        description: skill.metadata.description,
        version: skill.metadata.version,
        tags: skill.metadata.tags,
      }));
  }

  /**
   * Get all categories
   */
  getCategories(): string[] {
    return Array.from(this.categories.keys());
  }

  /**
   * Search skills by query
   */
  search(query: string): SkillSearchResult[] {
    if (!query) return [];

    const queryLower = query.toLowerCase();
    const results: SkillSearchResult[] = [];

    for (const skill of this.skills.values()) {
      let relevance = 0;
      const { metadata } = skill;

      // Exact name match
      if (metadata.name.toLowerCase() === queryLower) {
        relevance = 100;
      }
      // Name contains query
      else if (metadata.name.toLowerCase().includes(queryLower)) {
        relevance = 80;
      }
      // Category match
      else if (metadata.category.toLowerCase().includes(queryLower)) {
        relevance = 60;
      }
      // Description contains query
      else if (metadata.description.toLowerCase().includes(queryLower)) {
        relevance = 40;
      }
      // Tags contain query
      else if (metadata.tags?.some((t) => t.toLowerCase().includes(queryLower))) {
        relevance = 50;
      }

      if (relevance > 0) {
        results.push({
          name: metadata.name,
          category: metadata.category,
          description: metadata.description,
          relevance,
          tags: metadata.tags,
        });
      }
    }

    // Sort by relevance descending
    return results.sort((a, b) => b.relevance - a.relevance);
  }

  /**
   * Get a skill by name
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Get skill implementation code for sandbox
   */
  getImplementation(name: string): string | undefined {
    return this.skills.get(name)?.implementation;
  }

  /**
   * Get skill metadata
   */
  getMetadata(name: string): SkillMetadata | undefined {
    return this.skills.get(name)?.metadata;
  }

  /**
   * Check if a skill exists
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * Get skill count
   */
  getSkillCount(): number {
    return this.skills.size;
  }

  /**
   * Check if skills are loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Reload all skills
   */
  async reload(): Promise<void> {
    await this.loadSkills();
    this.emit('reloaded', { count: this.skills.size });
  }

  /**
   * Generate sandbox code for loading a skill
   */
  generateSkillLoader(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill || !skill.implementation) {
      return null;
    }

    // Wrap skill implementation for sandbox
    return `
// Skill: ${skill.metadata.name}
// Category: ${skill.metadata.category}
// Description: ${skill.metadata.description}

const __skill_${this.sanitiseName(name)} = (() => {
  ${skill.implementation}
})();
`;
  }

  /**
   * Sanitise a skill name for use as a variable
   */
  private sanitiseName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }
}

// Global skills engine instance
let globalSkillsEngine: SkillsEngine | null = null;

/**
 * Get or create the global skills engine.
 *
 * Skills directory resolution order (PRD §5 Phase 5):
 *   1. config.skillsDir — explicit caller override
 *   2. process.env.CLAUDE_SKILLS_DARKICE — environment variable
 *   3. './skills' — default relative path when config is supplied
 *
 * Throws when called with no config AND no CLAUDE_SKILLS_DARKICE env var
 * (preserves original contract for callers that always pass config).
 */
export function getSkillsEngine(config?: SkillsEngineConfig): SkillsEngine {
  if (!globalSkillsEngine) {
    // Resolve skills directory with env-var fallback
    const envDir = process.env.CLAUDE_SKILLS_DARKICE;
    const skillsDir = config?.skillsDir ?? envDir;

    if (!skillsDir && !config) {
      throw new Error('Skills engine not initialised. Provide config on first call.');
    }

    const resolvedConfig: SkillsEngineConfig = {
      skillsDir: skillsDir ?? './skills',
      watchEnabled: false,
      allowedCategories: [],
      ...config,
    };

    globalSkillsEngine = new SkillsEngine(resolvedConfig);
  }
  return globalSkillsEngine;
}

/**
 * Shutdown the global skills engine
 */
export function shutdownSkillsEngine(): void {
  if (globalSkillsEngine) {
    globalSkillsEngine.removeAllListeners();
    globalSkillsEngine = null;
  }
}
