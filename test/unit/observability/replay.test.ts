import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReplayRecorder,
  getReplayRecorder,
  shutdownReplayRecorder,
} from '../../../src/observability/replay.js';

describe('ReplayRecorder', () => {
  let tmpDir: string;
  let recorder: ReplayRecorder;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'replay-test-'));
    recorder = new ReplayRecorder({ recordingsDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  it('startRecording creates a .jsonl file', () => {
    const { sessionId, recordingPath } = recorder.startRecording();
    expect(existsSync(recordingPath)).toBe(true);
    expect(recordingPath).toMatch(/\.jsonl$/);
    expect(recorder.isRecording(sessionId)).toBe(true);
    recorder.stopRecording(sessionId);
  });

  it('accepts an explicit sessionId', () => {
    const { sessionId } = recorder.startRecording('my-session');
    expect(sessionId).toBe('my-session');
    recorder.stopRecording(sessionId);
  });

  it('record produces well-formed jsonl', () => {
    const { sessionId, recordingPath } = recorder.startRecording();
    recorder.recordToolCall(sessionId, 'fs', 'read_file', { path: '/x' });
    recorder.recordToolResult(sessionId, 'fs', 'read_file', { content: 'hello' });
    recorder.recordCodeResult(sessionId, { answer: 42 });
    const { eventCount } = recorder.stopRecording(sessionId);

    expect(eventCount).toBe(3);

    const lines = readFileSync(recordingPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);

    const events = lines.map((l) => JSON.parse(l));
    expect(events[0].type).toBe('tool_call');
    expect(events[0].server).toBe('fs');
    expect(events[0].seq).toBe(0);
    expect(typeof events[0].ts).toBe('number');
    expect(events[1].type).toBe('tool_result');
    expect(events[2].type).toBe('code_result');
    expect(events[2].result).toEqual({ answer: 42 });
  });

  it('stopRecording throws for unknown sessionId', () => {
    expect(() => recorder.stopRecording('no-such-id')).toThrow();
  });

  it('isRecording returns false after stop', () => {
    const { sessionId } = recorder.startRecording();
    recorder.stopRecording(sessionId);
    expect(recorder.isRecording(sessionId)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Replay — no modifications
  // ---------------------------------------------------------------------------

  it('replay no-mod reproduces result bit-identical', () => {
    const { sessionId, recordingPath } = recorder.startRecording();
    recorder.recordToolCall(sessionId, 'fs', 'read_file', { path: '/x' });
    recorder.recordToolResult(sessionId, 'fs', 'read_file', { content: 'hello' });
    recorder.recordCodeResult(sessionId, { answer: 42 });
    recorder.stopRecording(sessionId);

    const { result, divergence } = recorder.replay(recordingPath);
    expect(result).toEqual({ answer: 42 });
    expect(divergence).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Replay — with skip modification
  // ---------------------------------------------------------------------------

  it('replay with skip bypasses targeted event', () => {
    const { sessionId, recordingPath } = recorder.startRecording();
    recorder.recordToolCall(sessionId, 's', 't', {});        // seq 0
    recorder.recordToolResult(sessionId, 's', 't', { v: 1 });// seq 1
    recorder.recordCodeResult(sessionId, { ok: true });      // seq 2
    recorder.stopRecording(sessionId);

    const { result, events } = recorder.replay(recordingPath, [{ at: 0, op: 'skip' }]);
    // seq 0 (tool_call) is skipped; remaining events are renumbered
    const seqs = events.map((e) => e.type);
    expect(seqs).not.toContain('tool_call');
    expect(result).toEqual({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Replay — with replace modification
  // ---------------------------------------------------------------------------

  it('replay with replace swaps result value', () => {
    const { sessionId, recordingPath } = recorder.startRecording();
    recorder.recordToolCall(sessionId, 's', 't', {});
    recorder.recordToolResult(sessionId, 's', 't', { v: 1 });
    recorder.recordCodeResult(sessionId, { v: 1 });
    recorder.stopRecording(sessionId);

    // Replace the tool_result (seq 1) with { v: 99 }
    const { events } = recorder.replay(recordingPath, [
      { at: 1, op: 'replace', with: { v: 99 } },
    ]);
    const toolResultEvent = events.find((e) => e.type === 'tool_result');
    expect(toolResultEvent?.result).toEqual({ v: 99 });
  });

  // ---------------------------------------------------------------------------
  // Replay — divergence detection
  // ---------------------------------------------------------------------------

  it('replay detects divergence when code_result is replaced', () => {
    const { sessionId, recordingPath } = recorder.startRecording();
    recorder.recordCodeResult(sessionId, { value: 'original' }); // seq 0
    recorder.stopRecording(sessionId);

    const { divergence } = recorder.replay(recordingPath, [
      { at: 0, op: 'replace', with: { value: 'modified' } },
    ]);
    expect(divergence).toBeDefined();
    expect(divergence!.at).toBe(0);
    expect(divergence!.expected).toEqual({ value: 'original' });
    expect(divergence!.actual).toEqual({ value: 'modified' });
  });

  // ---------------------------------------------------------------------------
  // Rotation
  // ---------------------------------------------------------------------------

  it('rotation at maxBytes removes oldest file', async () => {
    // maxTotalBytes = 100 bytes — tiny threshold so one recording triggers rotation
    const tinyRecorder = new ReplayRecorder({ recordingsDir: tmpDir, maxTotalBytes: 100 });

    // Create first recording with enough data to exceed limit
    const { sessionId: sid1, recordingPath: rp1 } = tinyRecorder.startRecording('first');
    tinyRecorder.recordCodeResult(sid1, 'x'.repeat(200));
    tinyRecorder.stopRecording(sid1);

    // Verify first file exists
    expect(existsSync(rp1)).toBe(true);

    // Second recording — should trigger rotation of first
    const { sessionId: sid2, recordingPath: rp2 } = tinyRecorder.startRecording('second');
    tinyRecorder.recordCodeResult(sid2, 'y');
    tinyRecorder.stopRecording(sid2);

    // First file should have been rotated away
    expect(existsSync(rp1)).toBe(false);
    expect(existsSync(rp2)).toBe(true);
  });

  it('listRecordings returns files sorted newest-first', async () => {
    const { sessionId: s1 } = recorder.startRecording('aaa');
    recorder.stopRecording(s1);

    // Small delay to ensure different mtimes
    await new Promise((r) => setTimeout(r, 10));

    const { sessionId: s2 } = recorder.startRecording('bbb');
    recorder.stopRecording(s2);

    const list = recorder.listRecordings();
    expect(list[0].sessionId).toBe('bbb');
    expect(list[1].sessionId).toBe('aaa');
  });

  it('loadRecording throws for missing file', () => {
    expect(() => recorder.loadRecording('/no/such/file.jsonl')).toThrow();
  });

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  describe('singleton', () => {
    afterEach(() => { shutdownReplayRecorder(); });
    it('getReplayRecorder returns same instance', () => {
      const a = getReplayRecorder();
      const b = getReplayRecorder();
      expect(a).toBe(b);
    });
    it('shutdownReplayRecorder clears singleton', () => {
      const a = getReplayRecorder();
      shutdownReplayRecorder();
      const b = getReplayRecorder();
      expect(a).not.toBe(b);
    });
  });
});
