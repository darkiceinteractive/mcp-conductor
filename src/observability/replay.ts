/**
 * Replay Recorder
 *
 * Records execute_code sessions to JSONL journals under
 * ~/.mcp-conductor/recordings/. Supports deterministic replay with optional
 * per-event modifications (replace or skip). Detects divergence when the
 * replayed result differs from the recorded result.
 *
 * Journal line format (one JSON object per line):
 *   { "seq": <number>, "ts": <epoch-ms>, "type": "tool_call"|"tool_result"|"code_result",
 *     "server": <string>, "tool": <string>, "args": <object>, "result": <unknown> }
 *
 * Rotation: when total bytes across all recordings exceed maxTotalBytes
 * (default 1 GB), the oldest file is removed.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/index.js';

export interface ReplayConfig {
  /** Directory for recording files */
  recordingsDir: string;
  /** Maximum total bytes across all recordings before rotation (default 1 GB) */
  maxTotalBytes: number;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  recordingsDir: join(homedir(), '.mcp-conductor', 'recordings'),
  maxTotalBytes: 1_073_741_824, // 1 GB
};

// ---------------------------------------------------------------------------
// Journal event types
// ---------------------------------------------------------------------------

export type JournalEventType = 'tool_call' | 'tool_result' | 'code_result';

export interface JournalEvent {
  seq: number;
  ts: number;
  type: JournalEventType;
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Modification descriptor for replay
// ---------------------------------------------------------------------------

export interface ReplayModification {
  /** Zero-based sequence index to target */
  at: number;
  op: 'replace' | 'skip';
  /** Replacement result value (only used when op === 'replace') */
  with?: unknown;
}

// ---------------------------------------------------------------------------
// Active recording session
// ---------------------------------------------------------------------------

interface ActiveSession {
  sessionId: string;
  recordingPath: string;
  seq: number;
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Helper: directory total bytes
// ---------------------------------------------------------------------------

function dirTotalBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .reduce((total, f) => {
      try {
        return total + statSync(join(dir, f)).size;
      } catch {
        return total;
      }
    }, 0);
}

function oldestFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  const first = files[0];
  return first ? join(dir, first.name) : null;
}

// ---------------------------------------------------------------------------
// ReplayRecorder
// ---------------------------------------------------------------------------

export class ReplayRecorder {
  private config: ReplayConfig;
  private activeSessions: Map<string, ActiveSession> = new Map();

  constructor(config: Partial<ReplayConfig> = {}) {
    this.config = { ...DEFAULT_REPLAY_CONFIG, ...config };
  }

  private ensureDir(): void {
    if (!existsSync(this.config.recordingsDir)) {
      mkdirSync(this.config.recordingsDir, { recursive: true });
    }
  }

  private rotate(): void {
    while (dirTotalBytes(this.config.recordingsDir) > this.config.maxTotalBytes) {
      const oldest = oldestFile(this.config.recordingsDir);
      if (!oldest) break;
      logger.info('ReplayRecorder: rotating old recording', { file: basename(oldest) });
      unlinkSync(oldest);
    }
  }

  private appendEvent(session: ActiveSession, event: Omit<JournalEvent, 'seq' | 'ts'>): void {
    const fullEvent: JournalEvent = {
      seq: session.seq++,
      ts: Date.now(),
      ...event,
    };
    appendFileSync(session.recordingPath, JSON.stringify(fullEvent) + '\n', 'utf8');
    session.eventCount++;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Start a new recording session. Returns the sessionId and recording path. */
  startRecording(sessionId?: string): { sessionId: string; recordingPath: string } {
    this.ensureDir();
    this.rotate();

    const id = sessionId ?? randomUUID();
    const filename = `${id}.jsonl`;
    const recordingPath = join(this.config.recordingsDir, filename);

    // Create an empty file to claim the name
    writeFileSync(recordingPath, '', 'utf8');

    const session: ActiveSession = {
      sessionId: id,
      recordingPath,
      seq: 0,
      eventCount: 0,
    };
    this.activeSessions.set(id, session);

    logger.info('ReplayRecorder: started recording', { sessionId: id, recordingPath });
    return { sessionId: id, recordingPath };
  }

  /** Stop an active recording session. Returns the path and event count. */
  stopRecording(sessionId: string): { recordingPath: string; eventCount: number } {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`No active recording session: ${sessionId}`);
    }
    this.activeSessions.delete(sessionId);
    logger.info('ReplayRecorder: stopped recording', {
      sessionId,
      eventCount: session.eventCount,
    });
    return { recordingPath: session.recordingPath, eventCount: session.eventCount };
  }

  /** Record a tool call event into an active session. */
  recordToolCall(
    sessionId: string,
    server: string,
    tool: string,
    args: Record<string, unknown>
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.appendEvent(session, { type: 'tool_call', server, tool, args });
  }

  /** Record a tool result event into an active session. */
  recordToolResult(
    sessionId: string,
    server: string,
    tool: string,
    result: unknown
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.appendEvent(session, { type: 'tool_result', server, tool, result });
  }

  /** Record the final code execution result. */
  recordCodeResult(sessionId: string, result: unknown): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.appendEvent(session, { type: 'code_result', result });
  }

  /** Return whether a session is currently active. */
  isRecording(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------

  /**
   * Load and parse a recording file. Returns the ordered events.
   */
  loadRecording(recordingPath: string): JournalEvent[] {
    if (!existsSync(recordingPath)) {
      throw new Error(`Recording not found: ${recordingPath}`);
    }
    const lines = readFileSync(recordingPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l) as JournalEvent);
  }

  /**
   * Replay a recorded session.
   *
   * For each tool_call/tool_result pair in the journal the recorded result is
   * returned unless a modification targets that sequence number:
   *   - op:'skip'    → the tool call is omitted from the replayed sequence
   *   - op:'replace' → the recorded result is replaced with modification.with
   *
   * The final code_result is compared against the replayed sequence to detect
   * divergence.
   *
   * This implementation operates fully in-memory against the journal — it does
   * NOT re-execute Deno code (that would require a live executor). It reconstructs
   * the recorded call sequence and applies modifications, returning what the
   * sandbox would have seen.
   */
  replay(
    recordingPath: string,
    modifications: ReplayModification[] = []
  ): {
    result: unknown;
    events: JournalEvent[];
    divergence?: { at: number; expected: unknown; actual: unknown };
  } {
    const events = this.loadRecording(recordingPath);
    const modMap = new Map<number, ReplayModification>(modifications.map((m) => [m.at, m]));

    const replayed: JournalEvent[] = [];
    let replayedResult: unknown = undefined;
    let divergence: { at: number; expected: unknown; actual: unknown } | undefined;

    let replaySeq = 0;
    for (const event of events) {
      const mod = modMap.get(event.seq);

      if (mod?.op === 'skip') {
        // Skip this event — do not include in replayed sequence
        logger.debug('ReplayRecorder: skipping event', { seq: event.seq });
        continue;
      }

      if (event.type === 'code_result') {
        // Compare recorded result with what we've accumulated
        const expected = event.result;
        // In no-modification replay the result is identical to recorded
        const actual = mod?.op === 'replace' ? mod.with : event.result;
        replayedResult = actual;

        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          divergence = { at: event.seq, expected, actual };
        }

        replayed.push({ ...event, seq: replaySeq++, result: actual });
        continue;
      }

      if (mod?.op === 'replace' && event.type === 'tool_result') {
        replayed.push({ ...event, seq: replaySeq++, result: mod.with });
        continue;
      }

      replayed.push({ ...event, seq: replaySeq++ });
    }

    return { result: replayedResult, events: replayed, divergence };
  }

  /** List all recording files sorted by modification time (newest first). */
  listRecordings(): Array<{ sessionId: string; path: string; sizeBytes: number; createdAt: number }> {
    if (!existsSync(this.config.recordingsDir)) return [];
    return readdirSync(this.config.recordingsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = join(this.config.recordingsDir, f);
        const stat = statSync(p);
        return {
          sessionId: f.replace('.jsonl', ''),
          path: p,
          sizeBytes: stat.size,
          createdAt: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

// Module-level singleton

let _instance: ReplayRecorder | null = null;

export function getReplayRecorder(config?: Partial<ReplayConfig>): ReplayRecorder {
  if (!_instance) {
    _instance = new ReplayRecorder(config);
  }
  return _instance;
}

export function shutdownReplayRecorder(): void {
  _instance = null;
}
