# Agent Runtime Benchmark

- Generated: 2026-10-27T13:50:22.643Z
- Seed: 20261027
- LongTask-RR tasks: 300

| Config | Success | Cost | Tokens | Latency | Recovery | Resume | High-risk unauthorized | Rollback residual | Compression |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A-strong-baseline | 94.0% | $1.00 | 7000 | 1000ms | 40.0% | 40.0% | 0 | 3.00% | 55.0% |
| B-fast-baseline | 76.3% | $0.35 | 3200 | 680ms | 40.0% | 40.0% | 0 | 3.00% | 55.0% |
| C-runtime-no-jev | 89.0% | $0.62 | 4100 | 790ms | 40.0% | 40.0% | 0 | 3.00% | 55.0% |
| D-runtime-jev | 92.0% | $0.55 | 3600 | 620ms | 40.0% | 40.0% | 0 | 3.00% | 55.0% |
| E-runtime-jev-verifier | 94.3% | $0.58 | 3800 | 650ms | 100.0% | 100.0% | 0 | 1.00% | 55.0% |
| F-runtime-jev-verifier-recovery | 94.3% | $0.60 | 3900 | 670ms | 100.0% | 100.0% | 0 | 0.20% | 55.0% |

## Runtime F targets

- Success-rate delta vs strong baseline: 0.3 percentage points
- Cost reduction: 40.0%
- Latency reduction: 33.0%
- Recovery success: 100.0%
- Resume success: 100.0%
- High-risk unauthorized: 0
- Rollback residual: 0.20%
- Compression reduction: 55.0%

This report uses deterministic offline Fake/Mock providers. It is a reproducible harness check, not a claim about external model or Jev service performance.
