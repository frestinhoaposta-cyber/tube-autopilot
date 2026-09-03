## Purpose

Migra com segurança os dados existentes do app (canais OAuth e inventário globais, sem dono) para o novo modelo por usuário, sem descartar conteúdo recuperável.

## ADDED Requirements

### Requirement: Backup antes de qualquer mutação de migração
Antes da primeira mutação dos dados existentes (no primeiro boot com o novo código), o sistema SHALL copiar os arquivos de dados afetados (`oauth-accounts.json`, `inventory.json` e arquivos relacionados) para `data/backups/<timestamp>/`, preservando o conteúdo original. O sistema SHALL registrar no console quando o backup for criado.

#### Scenario: Primeiro boot pós-upgrade
- **WHEN** o servidor inicia com o novo modelo e encontra dados legados
- **THEN** o sistema cria uma cópia timestamped dos arquivos em `data/backups/` antes de mutar qualquer coisa

#### Scenario: Boot posterior sem dados legados
- **WHEN** o servidor inicia e nenhum dado precisa de migração
- **THEN** o sistema não cria backup nem altera os arquivos

### Requirement: Remoção de canais órfãos
Canais OAuth existentes sem `userId` SHALL ser removidos do store durante a migração, junto com seus tokens, e NUNCA SHALL ser retornados a visitantes ou usuários. A migração SHALL ser idempotente: executada uma única vez, sem re-remover dados em boots seguintes.

#### Scenario: Canais legados removidos da listagem
- **WHEN** o store contém canais sem `userId` e o servidor migra
- **THEN** esses canais não existem mais no store e nenhuma rota os retorna

#### Scenario: Migração idempotente
- **WHEN** o servidor reinicia após a migração concluída
- **THEN** nenhum dado é removido nem mutado novamente

#### Scenario: Tokens de canais removidos descartados
- **WHEN** um canal órfão é removido
- **THEN** seus tokens (mesmo em texto puro legado) são descartados e nunca usados

### Requirement: Inventário órfão mantido como "Sem canal"
Itens do inventário que referenciam canais órfãos removidos SHALL ser mantidos, com `accountId` ajustado para `null` (sem canal) e sem descartar os arquivos de vídeo. Esses itens SHALL aparecer apenas na visão "Sem canal" para qualquer usuário autenticado, permitindo reassociação posterior. O sistema NUNCA SHALL apagar arquivos de vídeo durante a migração.

#### Scenario: Vídeo de canal removido vira "Sem canal"
- **WHEN** um item do inventário referencia um canal órfão removido pela migração
- **THEN** o item permanece no store com `accountId: null`, o arquivo de vídeo é preservado e o item aparece somente em "Sem canal"

#### Scenario: Itens sem dono nunca visíveis em listas de usuário
- **WHEN** um usuário autenticado lista o inventário
- **THEN** nenhum item com `accountId` de canal removido (ou sem `userId` conhecido) aparece nas listas do usuário, exceto na visão "Sem canal"

### Requirement: Migração de tokens legados para criptografia
Tokens em texto puro existentes no disco SHALL ser migrados para o formato criptografado na primeira escrita. Se a chave de criptografia estiver ausente, as contas legadas SHALL ser marcadas como `RECONNECT_REQUIRED` (não bloqueando o boot nem vazando o token em texto puro por mais tempo que o necessário para a migração).

#### Scenario: Token legado criptografado na migração
- **WHEN** o store contém um canal com `refreshToken` em texto puro e a chave está presente
- **THEN** a conta passa a armazenar o token criptografado e o texto puro não permanece no arquivo

#### Scenario: Chave ausente na migração
- **WHEN** o store contém tokens legados mas a chave não está no `.env`
- **THEN** o servidor inicia, as contas ficam `RECONNECT_REQUIRED` com aviso no console, e nenhum token é exposto