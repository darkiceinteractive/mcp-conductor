/**
 * Skills engine — loads YAML-defined reusable code templates from a
 * directory, supports search/list/execute, and hot-reloads on change.
 * @module skills
 */

export {
  SkillsEngine,
  getSkillsEngine,
  shutdownSkillsEngine,
  type SkillMetadata,
  type SkillInput,
  type SkillOutput,
  type Skill,
  type SkillSearchResult,
  type SkillListItem,
  type SkillsEngineConfig,
} from './skills-engine.js';
