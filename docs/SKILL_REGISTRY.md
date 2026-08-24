# Skill Registry

O `skills`/`skill_sources` existente continua sendo o catálogo operacional.
Discovery externo não implica instalação.

## Pipeline obrigatório

```
discover → fetch metadata → license check → static security scan
→ compatibility/sandbox test → human approval → register → enable
```

Cada entrada futura deve registrar id, nome, versão, origem, licença,
capabilities, ferramentas, agentes, permissões, risco, custo, dependências,
testes e provenance. O catálogo VoltAgent é discovery de 1.497+ skills, não é
prova de segurança de cada skill; cada origem deve ser avaliada separadamente.

Skills com shell, filesystem, browser, network ou MCP recebem risco elevado até
que o scan e o teste em sandbox provem o contrário.
