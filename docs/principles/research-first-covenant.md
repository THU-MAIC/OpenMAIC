# Research-First Covenant

We do not write non-trivial architecture, algorithm, dependency, or go-to-market code before we have researched it and recorded the decision in an ADR.

## The loop

```
Problem/Hypothesis → Research (BFS/DFS) → ADR + citations → Code + tests
```

## Research patterns

| Pattern | Use for | Output |
|---------|---------|--------|
| **BFS** | Landscape mapping (competitors, standards, data sources, stakeholders) | Comparison table + gap analysis |
| **DFS** | Deep technology or algorithm investigation | Recommended option + failure modes + MVP architecture |
| **Bidirectional** | Cross-domain impact (business ↔ technology, pedagogy ↔ engineering) | Trade-off matrix + GTM implications |

## Citation keys

- `[T#]` — theory / pedagogy / algorithms
- `[R#]` — reference implementations / SDKs / open source
- `[G#]` — go-to-market / pricing / stakeholders
- `[S#]` — standards / curriculum / regulation

## 10-persona filter

Before an ADR is accepted, ensure it has been considered from:

1. Principal / Teacher
2. Student
3. Parent
4. Tuition-center owner
5. Privacy officer
6. Site reliability engineer
7. ML engineer
8. Curriculum expert
9. Open-source maintainer
10. Business strategist

See `AGENTS.md` for the full process, ADR template, and research-agent usage instructions.
