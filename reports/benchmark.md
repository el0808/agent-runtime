# Agent Runtime Benchmark

- Generated: 2026-10-27T17:46:14.138Z
- Seed: 20261027
- Mode: runtime
- LongTask-RR tasks: 50
- Repetitions: 1

| Config | Success (95% CI) | Cost | Tokens | Latency | Recovery | Resume | High-risk unauthorized | Rollback residual | Compression |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A-strong-baseline | 40.0% (27.6–53.8%) | $0.00 | 4 | 1ms | 40.0% | 40.0% | 0 | 60.00% | 0.0% |
| B-fast-baseline | 40.0% (27.6–53.8%) | $0.00 | 4 | 1ms | 40.0% | 40.0% | 0 | 60.00% | 0.0% |
| C-runtime-no-jev | 40.0% (27.6–53.8%) | $0.00 | 4 | 1ms | 40.0% | 40.0% | 0 | 60.00% | 0.0% |
| D-runtime-jev | 40.0% (27.6–53.8%) | $0.00 | 4 | 1ms | 40.0% | 40.0% | 0 | 60.00% | 0.0% |
| E-runtime-jev-verifier | 40.0% (27.6–53.8%) | $0.00 | 4 | 1ms | 40.0% | 40.0% | 0 | 60.00% | 0.0% |
| F-runtime-jev-verifier-recovery | 100.0% (92.9–100.0%) | $0.00 | 10 | 3ms | 100.0% | 100.0% | 0 | 0.00% | 0.0% |

## Runtime F targets

- Success-rate delta vs strong baseline: 60.0 percentage points
- Cost reduction: 0.0%
- Latency reduction: -133.5%
- Recovery success: 100.0%
- Resume success: 100.0%
- High-risk unauthorized: 0
- Rollback residual: 60.00%
- Compression reduction: 0.0%

Measured by executing the real runtime with a scripted provider. Cost is $0.00 because no paid API was called; success, latency, recovery and compression are real observations.
