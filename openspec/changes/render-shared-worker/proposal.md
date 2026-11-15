## Why

Processos web e worker no Render não compartilham arquivos locais. O estado atual pode perder atualizações, executar agendadores duplicados e deixar comentários presos após reinício.

## What Changes

- Separar agendamentos, comentários e edição automática do servidor HTTP.
- Persistir documentos criptografados no PostgreSQL com controle de versão e sessões compartilhadas.
- Armazenar vídeos em bucket privado S3, usando disco local apenas como cache.
- Migrar com backup verificável, preservando dados e vínculos por canal.
- Recuperar comentários de resultado incerto sem reenvio automático.
- Preparar Blueprint somente com web gratuito na branch main, sem provisionar infraestrutura; manter worker separado para execução externa opcional e documentar as limitações 24h.

## Capabilities

### New Capabilities
- `render-runtime`: execução separada, persistência compartilhada e migração recuperável.

### Modified Capabilities

Nenhuma especificação principal existente.

## Impact

Servidor, inventário, OAuth, comentários, TikTok e editor; dependências PostgreSQL e S3; configuração de produção e testes offline.
