# External Agent Benchmark

| Capability | Current OS | Best observed reference | Action |
|---|---|---|---|
| Model fallback | local provider only | OpenRouter `models`/fallback | implemented optionally |
| Provider routing | absent | OpenRouter provider preferences | router baseline implemented |
| Long runs | persisted harness | OpenHuman durable graphs | keep SQL harness; future DAG |
| Memory compaction | bounded context | OpenHuman TokenJuice/Memory Tree | benchmark before adding |
| Gateway/session security | SECOM + webhook | OpenClaw pairing/session boundaries | harden before public channels |
| Learning/skills | learning loop + SQLite skills | Hermes self-improving skills | adopt only reviewed promotion |
| Obsidian | sync/knowledge layer | claude-obsidian transactions | adopt lock/plan/apply model |
| Browser | not configured | Browser2API Playwright/CDP | adapter only, no bypass |
| Image | not configured | official image API + prompt library | provider adapter later |

## Reality status

- OpenRouter public model catalog: probed successfully; 417 models, 19 free at
  probe time.
- OpenRouter authenticated completion: `BLOCKED_EXTERNAL_CREDENTIAL` if key is
  absent; no fake completion used.
- External repositories: studied via official README/docs/license surfaces;
  no third-party code copied.
