# R5 Mixed-Fault Soak — 2026-05-04

**Duration**: 30s
**Total calls**: 271
**Successes**: 189 (69.7%)
**Zero hangs**: true
**Max call duration**: 179ms (ceiling: 600ms)

## Fault Rates
| Fault | Rate |
|-------|------|
| timeout | 20% |
| serverError | 10% |
| truncated | 5% |
| slowSuccess | 5% |
| disconnect | 5% |
| total | 45% |

## Backend Fault Breakdown
| Fault | Count |
|-------|-------|
| none | 174 |
| timeout | 68 |
| server_error | 35 |
| truncated | 15 |
| slow_success | 17 |
| disconnect | 16 |

## Gateway Error Types
| Error | Count |
|-------|-------|
| TimeoutError | 0 |
| RetryExhaustedError | 47 |
| CircuitOpenError | 0 |
| OtherError | 35 |