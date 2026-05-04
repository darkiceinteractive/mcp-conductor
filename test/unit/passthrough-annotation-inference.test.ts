/**
 * Unit tests for `inferAnnotationsFromName` (HIGH-4 fix).
 *
 * Covers the name-pattern heuristic that derives MCP `ToolAnnotations` from
 * a passthrough tool's name when the upstream registry doesn't yet carry
 * explicit annotations.
 */

import { describe, expect, it } from 'vitest';
import { inferAnnotationsFromName } from '../../src/server/passthrough-registrar.js';

describe('inferAnnotationsFromName', () => {
  describe('destructive verbs', () => {
    const destructiveNames = [
      'delete_repository',
      'remove_label',
      'create_issue',
      'update_pull_request',
      'send_email',
      'post_comment',
      'put_object',
      'patch_resource',
      'drop_table',
      'kill_process',
      'terminate_session',
      'revoke_token',
      'destroy_entity',
      'set_value',
      'activate_kill_switch',
      'deactivate_alarm',
      'enable_feature',
      'disable_account',
      'cancel_subscription',
      // suffix safety net
      'repository_delete',
      'session_remove',
      'entity_destroy',
    ];

    for (const name of destructiveNames) {
      it(`flags '${name}' as destructive`, () => {
        const a = inferAnnotationsFromName(name);
        expect(a.destructiveHint).toBe(true);
        expect(a.readOnlyHint).toBe(false);
        expect(a.idempotentHint).toBe(false);
        expect(a.openWorldHint).toBe(false);
      });
    }
  });

  describe('mutating but recoverable verbs', () => {
    const mutatingNames = ['save_draft', 'write_file', 'upload_artifact'];

    for (const name of mutatingNames) {
      it(`flags '${name}' as non-readonly, non-destructive`, () => {
        const a = inferAnnotationsFromName(name);
        expect(a.readOnlyHint).toBe(false);
        expect(a.destructiveHint).toBe(false);
        expect(a.idempotentHint).toBe(false);
      });
    }
  });

  describe('read-safe defaults', () => {
    const safeNames = [
      'get_user',
      'list_repositories',
      'search_files',
      'query_database',
      'read_file',
      'fetch_data',
      'check_status',
      'count_items',
      'find_paths',
    ];

    for (const name of safeNames) {
      it(`treats '${name}' as read-safe`, () => {
        const a = inferAnnotationsFromName(name);
        expect(a.readOnlyHint).toBe(true);
        expect(a.destructiveHint).toBe(false);
        expect(a.idempotentHint).toBe(true);
        expect(a.openWorldHint).toBe(false);
      });
    }
  });

  describe('case-insensitive matching', () => {
    it('matches DELETE_REPOSITORY (uppercase) as destructive', () => {
      const a = inferAnnotationsFromName('DELETE_REPOSITORY');
      expect(a.destructiveHint).toBe(true);
    });

    it('matches Set_Value (mixed case) as destructive', () => {
      const a = inferAnnotationsFromName('Set_Value');
      expect(a.destructiveHint).toBe(true);
    });
  });

  describe('regression: previously-hardcoded behaviour', () => {
    it('still treats opaque tool names (no verb match) as read-safe', () => {
      const a = inferAnnotationsFromName('foobar');
      expect(a.readOnlyHint).toBe(true);
      expect(a.destructiveHint).toBe(false);
      expect(a.idempotentHint).toBe(true);
    });
  });
});
