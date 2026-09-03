## 1. Setup, env e dependências

- [x] 1.1 Adicionar `@supabase/supabase-js` ao package.json e rodar `npm install` (verificar: sem erros no install, dependência presente em `node_modules`)
- [x] 1.2 Adicionar ao `.env.example` as variáveis `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL` e `TOKEN_ENCRYPTION_KEY` (verificar: `.env` local atualizado com os valores reais fornecidos pelo usuário, sem sair do gitignore)
- [x] 1.3 Gerar e documentar `TOKEN_ENCRYPTION_KEY` (hex 64 = 32 bytes) no `.env` local (verificar: `openssl rand -hex 32` é executável e o valor está apenas no `.env`)

## 2. Criptografia de tokens

- [x] 2.1 Criar `server/token-crypto.js` com AES-256-GCM (`encryptToken`/`decryptToken`, formato `enc:gcm:iv:tag:cipher`) e tratamento de chave ausente (verificar: teste unitário rápido rodando enc→dec com a mensagem original e determinismo do prefixo)
- [x] 2.2 Integrar `token-crypto` ao `oauth-store.js` (criptografar no save, descriptografar só em `getAuthenticatedYouTubeClient` e paths que montam o client) (verificar: disco nunca contém token em texto puro após save)

## 3. Autenticação Supabase e sessão

- [x] 3.1 Criar `server/users.js` com `isSupabaseConfigured()`, `signUp`, `signIn` (via `@supabase/supabase-js`) e helpers de sessão (verificar: módulo exporta as funções e não falha ao carregar sem env)
- [x] 3.2 Adicionar middlewares `requireAuth` (401 sem `req.session.userId`) e `requireAccountOwner` (403/404 por posse) em `server/server.js` (verificar: rota de teste responde 401 sem sessão)
- [x] 3.3 Implementar `POST /api/auth/register`, `POST /api/auth/login` (com `req.session.regenerate` + `req.session.userId`), `POST /api/auth/logout` (destruir sessão) e `GET /api/auth/session` (verificar: validação de rotas coberta por testes com Supabase mockado; login real entra na 11.2)
- [x] 3.4 Proteger `GET /api/auth/status` e `GET /api/auth/accounts` com `requireAuth` e escopá-los ao usuário da sessão (verificar: sem cookie → 401; com cookie → só contas do usuário)

## 4. OAuth vinculado ao usuário

- [x] 4.1 `startGoogleOAuth` exige sessão e grava `userId` em `req.session.googleOauth` (verificar: rota sem sessão → 401; com sessão → `googleOauth` contém userId)
- [x] 4.2 Callback valida `state` + expiração (existente) e usa o `userId` da sessão para o `saveAccount`, nunca query string (verificar: teste com cookie + fluxo simulado salva conta com userId correto)
- [x] 4.3 `saveAccount` passa a receber `userId` e rejeita `channelId` de outro dono com `409 "este canal já está conectado a outra conta"` (verificar: teste cria conta A, tenta conectar mesmo channelId como B → 409 e conta de A intocada)

## 5. Store escopado por usuário

- [x] 5.1 Adicionar `userId` obrigatório em `saveAccount` e em todos os registros criados pelas rotas (verificar: registro em disco contém userId)
- [x] 5.2 Implementar `getAccountsByUserId`, `getAccountByUserAndId`, `getDefaultAccountForUser`, `assertAccountOwnership` e remover usos de `getDefaultAccount()` global das rotas/worker (verificar: testes chamando cada função com pares userId+accountId corretos/errados)
- [x] 5.3 `clientItem()` do inventário resolve nome de canal via `getAccountByUserAndId(item.userId, item.accountId)` (verificar: item de usuário X não expõe nome de canal do usuário Y)

## 6. Rotas de conta e upload protegidos

- [x] 6.1 `POST /api/auth/accounts/:accountId/default` e `DELETE /api/auth/accounts/:accountId` validam posse → 403 se não pertencer ao usuário, 404 se não existir (verificar: teste com accountId alheio → 403 em ambos)
- [x] 6.2 `POST /api/youtube/upload` exige sessão, resolve conta do usuário (`accountId` do corpo deve ser do usuário; sem accountId → `getDefaultAccountForUser`) e nunca usa padrão global (verificar: upload com accountId de outro usuário → 403)

## 7. Inventário isolado

- [x] 7.1 Todas as rotas GET/POST/PATCH/DELETE de `server/inventory.js` filtram por `item.userId === req.session.userId` após `readItems()` e verificam posse antes de mutar (verificar: rota `/api/inventory` retorna só itens do usuário logado; operação em item alheio → 404)
- [x] 7.2 Criação de itens (POST /, from-library, reuse-as-shorts) e `assign-account` gravam `userId` e só aceitam `accountId` do usuário (verificar: item criado tem userId; assign com accountId alheio → 403)
- [x] 7.3 Scheduler e comment-worker resolvem conta via `getAccountByUserAndId(item.userId, item.accountId)`; item agendado sem userId → `ERROR` sem publicação (verificar: worker isola AUTH_REQUIRED conforme testes; item sem dono não publica)
- [x] 7.4 Capacidade/slots continuam por `accountId` (não-acentricamente) para não vazar vagas entre usuários (verificar: slots por accountId; canais são disjuntos por dono — inspeção + regressão do scheduler por usuário)

## 8. Migração dos dados existentes

- [x] 8.1 Backup automático de `oauth-accounts.json`/`inventory.json` para `data/backups/<timestamp>/` no primeiro boot com dados legados (verificar: teste com paths temporários gera backup com conteúdo original intacto)
- [x] 8.2 Remover contas sem `userId`; itens do inventário que apontavam para elas ficam com `accountId: null` e `channelId: null` (arquivos preservados) (verificar: teste simula canais legados → store sem órfãos, inventário com itens "Sem canal", arquivos presentes)
- [x] 8.3 Migração idempotente (executa uma vez; boots seguintes não mutam nada) (verificar: store re-carregado/rodos repetidamente sem repetir backup quando não há dados legados)
- [x] 8.4 Tokens legados em texto puro migrados para criptografado quando a chave existe; sem chave → contas `RECONNECT_REQUIRED` sem derrubar o servidor (verificar: teste com/sem `TOKEN_ENCRYPTION_KEY`)

## 9. Frontend

- [x] 9.1 Adicionar vista `#login` (registro/login, mensagens em PT-BR sem revelar existência de e-mail) e botão "Sair" em `src/index.html` (verificar: tela aparece sem sessão, some com sessão)
- [x] 9.2 `src/app.js`: `initAuth()` via `/api/auth/session` com gate de login no 401; `authState.user` preenchido; carregar canais apenas pós-sessão (verificar: app carrega vazio sem login, canais só aparecem após login)
- [x] 9.3 Logout limpa estado em memória + fila local (`tube-autopilot-jobs`) e volta ao gate (verificar: logout → UI limpa; relogin → só contas do usuário)
- [x] 9.4 Confirmar que nenhum canal/account dados ficam em `localStorage` (verificar: `localStorage` só contém chave jobs após uso completo)

## 10. Testes de segurança (usuário A vs B)

- [x] 10.1 Criar `test/isolation.test.js`: registrar A e B, conectar canal A (simulado) e canal B (simulado), cada um com seu cookie de sessão (verificar: suite roda com `node --test --test-concurrency=1 test/isolation.test.js`)
- [x] 10.2 A não vê/usar canal B e vice-versa; `GET /api/auth/accounts` escopado; tentativa de default/delete do accountId alheio → 403 (verificar: asserções passam; default alheio → 403, inexistente → 404)
- [x] 10.3 Upload/agendamento com accountId alheio → 403; item de inventário de A invisível para B (404) (verificar: asserções passam)
- [x] 10.4 Logout limpa interface; relogin restaura só os canais do usuário; agendamento continua funcionando com o worker (servidor spawn sem navegador) (verificar: asserções passam; worker usa userId+accountId do item e blinda item sem dono)
- [x] 10.5 Respigar no `multichannel.test.js` para o novo modelo (userId no saveAccount, tokens criptografados) sem perder os testes de "tokens nunca serializados" (verificar: `npm test` completo passa)

## 11. Validação final

- [x] 11.1 Rodar `npm test` (runner nativo, `--test-concurrency=1`) e garantir 100% de passagem (verificar: 10/10 passando, exit 0)
- [ ] 11.2 Smoke test manual: `npm run dev`, login real no Supabase, conectar canal, publicar/agendar no modo de teste (verificar: fluxo completo funciona em `http://localhost:3000`) — **pendente: depende de login real do usuário**
- [x] 11.3 Conferir `git status`/`git diff`: nenhum token, secret ou credencial fora do `.env` (verificar: varredura completa do repo achou segredos apenas no `.env`, que está no gitignore; diffs/testes/HTML limpos)