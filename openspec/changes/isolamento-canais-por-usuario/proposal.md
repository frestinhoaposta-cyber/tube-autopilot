## Why

Hoje qualquer visitante anônimo do site enxerga e pode usar os canais do YouTube conectados por qualquer pessoa: `GET /api/auth/accounts` retorna todas as contas, o upload aceita qualquer `accountId` enviado pelo frontend (ou cai no `getDefaultAccount()` global) e o inventário é compartilhado. Não existe sistema de login. Isso é uma falha grave de isolamento entre usuários: o canal da pessoa A aparece para a pessoa B, que pode publicar, agendar, desconectar ou definir como padrão material de outra pessoa. Precisamos tornar o app multi-tenant de verdade, com autenticação própria e dados escopados por usuário.

## What Changes

- **BREAKING — Login obrigatório (Supabase Auth):** adicionar registro/login/logout com e-mail e senha via Supabase Auth (sem confirmação de e-mail). Identidade do usuário = UUID `user.id` do Supabase, gravado em `req.session.userId` (sessão server-side, cookie httpOnly). Sem sessão, nenhuma rota de dados é acessível (401).
- **BREAKING — Isolamento de contas:** toda conta do YouTube passa a ter `userId`. `GET /api/auth/accounts` e `/api/auth/status` retornam somente `account.userId === req.session.userId`. Rotas que recebem `accountId` (reconectar, definir padrão, desconectar, upload, agendamento) verificam posse e respondem **403** quando a conta não pertence ao usuário.
- **OAuth vinculado ao usuário:** no início do OAuth, `req.session.googleOauth` passa a gravar `userId` junto com `state`/`returnTo`/`reconnectAccountId`. O callback usa o `userId` da sessão (nunca query string) e nunca substitui canal/token de outro usuário. Conflito de `channelId` já existente → `409 "este canal já está conectado a outra conta"`.
- **BREAKING — Sem padrão global:** remover o comportamento de `getDefaultAccount()` global nas rotas e no worker. Substituir por `getAccountsByUserId(userId)`, `getAccountByUserAndId(userId, accountId)` e `getDefaultAccountForUser(userId)`.
- **Inventário por usuário:** cada item do inventário ganha `userId`; listas, agendamentos, capacity, upload e cancelamento operam somente sobre itens do usuário logado. Itens sem `userId` não aparecem para ninguém.
- **Worker de postagem:** continua rodando sem sessão, buscando a conta por `item.userId + item.accountId`; nunca usa conta padrão global nem token de outro usuário.
- **BREAKING — Criptografia dos tokens:** `refreshToken`/`accessToken` salvos criptografados (AES-256-GCM) com `TOKEN_ENCRYPTION_KEY` do `.env`. Respostas de API continuam nunca serializando tokens.
- **BREAKING — Migração dos dados existentes:** no primeiro boot com o código novo, criar backup em `data/backups/<timestamp>/`, **apagar canais sem `userId`** (canais órfãos) e manter os vídeos do inventário que apontavam para eles como **"Sem canal"** (`accountId: null`), sem descartar arquivos.
- **Frontend:** tela de login/registro exibida quando a sessão não existe (401); estados de canais carregados só depois da sessão confirmada; logout limpa o estado em memória e a fila local; canais nunca são persistidos no `localStorage`.
- **Testes de segurança:** nova suíte com usuário A e usuário B validando isolamento, 403 em `accountId` alheio, logout/login e worker.

## Capabilities

### New Capabilities

- `user-auth`: autenticação de usuários via Supabase Auth (registro, login, logout), sessão server-side com `req.session.userId`, middlewares `requireAuth`/owner-check e proteção das rotas e do frontend.
- `youtube-channel-isolation`: contas OAuth do YouTube escopadas por `userId` (persistência, OAuth vinculado à sessão, rotas de conta, upload, agendamento e worker isolados, criptografia de tokens).
- `data-migration`: migração segura dos dados existentes (backup, remoção de canais órfãos, vídeos mantidos como "Sem canal", idempotência no boot).

### Modified Capabilities

<!-- Sem specs existentes no projeto ainda (openspec/specs/ não existe). -->

## Impact

- **Novos arquivos:** `server/users.js` (orchestra Supabase Auth + sessão), `server/token-crypto.js` (AES-256-GCM), `test/isolation.test.js` (suíte A vs B).
- **Modificados:** `server/oauth-store.js`, `server/server.js`, `server/inventory.js`, `src/app.js`, `src/index.html`, `.env.example`, `test/multichannel.test.js`.
- **Fora do escopo:** TikTok (`server/tiktok.js` não muda — conexão e inventário continuam únicos/globais neste ciclo).
- **Dependências novas:** `@supabase/supabase-js`.
- **Env novas:** `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `TOKEN_ENCRYPTION_KEY`. Credenciais só em `.env` (gitignored), nunca no código nem em respostas de API.
- **Sessão:** o `express-session` atual continua como store (MemoryStore); reiniciar o servidor exige novo login (aceito neste estágio).