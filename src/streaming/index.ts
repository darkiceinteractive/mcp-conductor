/**
 * Streaming — SSE-based event stream for real-time progress updates,
 * console log forwarding, tool call tracing, and execution completion.
 * @module streaming
 */

export {
  ExecutionStream,
  StreamManager,
  getStreamManager,
  shutdownStreamManager,
  type StreamEvent,
  type LogEvent,
  type ProgressEvent,
  type ToolCallEvent,
  type CompleteEvent,
  type ExecutionState,
} from './execution-stream.js';
