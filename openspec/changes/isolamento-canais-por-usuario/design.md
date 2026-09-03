## Context

Ver proposal.md (Why). Estado atual relevante para o design:

- App Express sem build, arquivos estáticos em `src/`; store de dados em JSON atômicos em `data/` (escritas via `writeJsonAtomic`/`writeQueue`).
- `express-session` com MemoryStore já existe, mas nenhuma rota exige autenticação. `req.session.googleOauth` guarda `state`/`returnTo`/`reconnectAccountId` com TTL de 10min.
- `server/oauth-store.js` é global: `listAccounts()` retorna tudo, `getDefaultAccount()` é o padrão global usado no upload e no worker. `saveAccount` deduplica por `channelId` sem conceito de dono.
- `server/inventory.js`: `readItems()` global em todas as rotas; scheduler e comment-worker resolvem a conta por `getAccount(item.accountId)`.
- Tokens OAuth estão em texto puro em `data/oauth-accounts.json`.
- Não há specs em `openspec/specs/` (tudo é capability nova).
- Sem suporte a autenticação própria no app; decidido usar Supabase Auth (admin do usuário, sem confirmação de e-mail).

## Goals / Non-Goals

**Goals:**
- Identidade única e confiável por usuário (UUID do Supabase), vivendo na sessão do servidor.
- Isolamento por `userId` em contas, inventário, agendamentos e worker.
- Tokens criptografados em repouso, nunca em respostas de API.
- Migração destrutiva mínima: só canais órfãos são removidos, com backup antes.

**Non-Goals:**
- Não usar o Postgres do Supabase para dados de negócio (contas/inventário continuam em JSON local).
- Não isolar TikTok (fora do escopo; único/global permanece).
- Não implementar admin especial nem tela de reassociação administrativa (órfãos são removidos).
- Não trocar o MemoryStore por store de sessão persistente (login se perde no restart — aceito).
- Não adicionar rate limiting nem 2FA.

## Decisions

### D1 — Supabase Auth server-side, sessão stateful no Express
`@supabase/supabase-js` roda apenas no backend. `login`/`register` chamam Supabase Auth REST; em sucesso, `req.session.userId = session.user.id` (sessão regenerada para evitar fixation). Frontend nunca lida com JWT do Supabase; o cookie httpOnly do Express é a identidade.

*Por que não JWT stateless / supabase-js no browser:* o fluxo OAuth do Google exige redirects do navegador; um `Authorization: Bearer` não sobrevive a eles. Sessão server-side sobrevive (o `state` OAuth e o `userId` ficam no mesmo `req.session.googleOauth`). *Alternativa considerada:* verificação de JWT por requisição via JWKS (`SUPABASE_JWKS_URL`) — mantida como `SUPABASE_JWKS_URL` de reserva no `.env`, não usada no fluxo principal.

### D2 — `server/users.js`: ponte Supabase + login/logout
Módulo novo com `isSupabaseConfigured()`, `signUp`, `signIn`, `logout`; middlewares `requireAuth` e helper `requireAccountOwner`. Rotas novas em `server/server.js`:
`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout` (existente ganha destruição real da sessão), `GET /api/auth/session` (retorna `{ user: { id, email } }` ou 401). `/api/auth/status` passa a exigir sessão e retornar dados já escopados.

### D3 — Modelo de dados com `userId`
- `oauth-accounts.json`: cada registro ganha `userId`. Unicidade de `channelId` permanece **global** (canal tem um dono físico). `saveAccount` recebe `userId` obrigatório nas rotas; conflito de `channelId` com outro dono → erro `409 "este canal já está conectado a outra conta"`.
- Funções novas no store: `getAccountsByUserId(userId)`, `getAccountByUserAndId(userId, accountId)`, `getDefaultAccountForUser(userId)`, `assertAccountOwnership(userId, accountId)` (lança 403/404). `getDefaultAccount()` global deixa de ser usado por rotas e pelo worker (fica apenas para retrocompatibilidade dos testes antigos ou é removido junto).
- `inventory.json`: cada item ganha `userId` no momento da criação (upload, from-library, reuse-as-shorts, assign-account). `readItems()` continua lendo tudo do disco, mas TODA rota filtra por `item.userId === req.session.userId` logo após a leitura; mutações verificam posse antes de escrever.
- Worker/scheduler/comment-worker: rodam sem sessão; resolvem conta via `getAccountByUserAndId(item.userId, item.accountId)`. Item com `status: SCHEDULED` sem `userId` → marcado `ERROR (OWNER_MIGRATION_REQUIRED)`, nunca publicado com conta alheia.

### D4 — Criptografia de tokens (`server/token-crypto.js`)
AES-256-GCM com chave `TOKEN_ENCRYPTION_KEY` (hex de 64 chars = 32 bytes) do `.env`. Formato persistido: `enc:gcm:base64(iv):base64(tag):base64(cipher)`. O store expõe `encryptTokens(account)/decryptTokens(account)` internos; `getAuthenticatedYouTubeClient` descriptografa antes de montar o client e espelha refresh em criptografado. Chave ausente: aviso no console + contas `RECONNECT_REQUIRED`; servidor não derruba. Se a chave estiver ausente no primeiro boot e houver tokens legados em texto puro, a migração NÃO roda (preserva texto puro somente em disco — nunca em resposta) até a chave existir; com a chave, rotaciona para criptografado.

### D5 — Migração destrutiva mínima, idempotente
Nova etapa em `oauth-store.js` (após `migrateLegacyData` atual, adaptada): se existir qualquer conta sem `userId` (após tentativa de migração com chave), o sistema: (1) faz backup de `oauth-accounts.json`/`inventory.json` para `data/backups/<timestamp>/`; (2) remove as contas órfãs do store; (3) para itens do inventário com `accountId` apontando para órfãos, seta `accountId = null` e `channelId = null` (preserva arquivo). Marcador de migração (`data/.migration-<hash>.flag` ou convenção de "já não há órfãos") torna o processo idempotente: uma vez removidos, nenhum boot seguinte muta nada.

### D6 — Frontend com gate de sessão
`src/index.html` ganha vista `#login` (formulários registro/login + mensagens de erro) sobreposta quando `/api/auth/session` responde 401. `src/app.js`:
- `initAuth()`: chama `/api/auth/session`; se 401 → mostra gate de login, limpa `authState` em memória; se ok → `authState.user = {id, email}` e carrega o resto.
- Todos os fetches de canais já passam por `/api/auth/accounts` (agora escopado). Nada de canais em `localStorage` (hoje só a fila local de jobs; no logout a fila é limpa, mantendo a regra "não persistir canais").
- Botão "Sair" → `POST /api/auth/logout` → recarrega limpando estado.
- Mensagens de registro/login em PT-BR (sem expor se e-mail existe).

### D7 — Env e dependências
`.env.example` ganha: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `TOKEN_ENCRYPTION_KEY` (gerada via `openssl rand -hex 32`). Nenhum segredo vai para código, resposta de API ou commit (`.env` está no .gitignore). Nova dependência `@supabase/supabase-js`.

## Risks / Trade-offs

- **MemoryStore perde sessões no restart** → usuário reloga; aceito neste ciclo, documentado na UX? (sem tela de "sessão expirada", apenas volta ao gate de login).
- **Deleção de canais órfãos é destrutiva** → backup automático timestamped antes; rollback = restaurar `data/backups/<timestamp>`.
- **Supabase como ponto de falha** → se o Supabase estiver fora, login falha mas o app segue funcionando com sessões já abertas; mensagens de erro genéricas.
- **Token criptografado + chave trocada** → tokens ilegíveis: todas as contas viram `RECONNECT_REQUIRED`; mitigado exigindo `TOKEN_ENCRYPTION_KEY` fixa e documentando o impacto de trocá-la.
- **`channelId` único global** → um usuário malicioso poderia "tentar conectar" os canais dos outros e receber 409, aprendendo o nome dos canais; aceito (o 409 não revela o dono).
- **Comentário worker (`comments.js`)** também passa a resolver conta via `item.userId + accountId` para evitar usar token alheio ao comentar.
- **Upload legado `POST /api/youtube/upload`** (`server.js`) muda de "qualquer accountId ou default global" para "conta do usuário da sessão"; a fila local do frontend (`tube-autopilot-jobs`) continua cosmética, sem canais.

## Migration Plan

1. Deploy: adicionar envs Supabase + `TOKEN_ENCRYPTION_KEY`; `npm install` (supabase-js).
2. Primeiro boot: backup → migração (remover órfãos, `accountId:null` nos itens, criptografar tokens com chave presente).
3. Usuário real faz login e reconecta seus canais; reassocia itens "Sem canal" via UI existente (`assign-account`).
4. Rollback: restaurar backup em `data/backups/<timestamp>/` e reverter o código (sem novo deploy de env exigido).
5. Sem etapa de dados no Postgres: nada a sincronizar no Supabase.

## Open Questions

- Nenhuma pendência que mude specs, abordagem ou tasks. (Decidido com o usuário: sem confirmação de e-mail no Supabase; vídeos órfãos mantidos como "Sem canal"; TikTok fora do escopo; secret do banco do Supabase não é usado pelo app.)