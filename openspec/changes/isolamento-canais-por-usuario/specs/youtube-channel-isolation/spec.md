## Purpose

Garante que cada usuário autenticado só veja, publique, agende e administre as próprias contas do YouTube, com tokens criptografados no backend e fluxo OAuth vinculado à sessão.

## ADDED Requirements

### Requirement: Contas do YouTube escopadas por usuário
Toda conta OAuth do YouTube SHALL ser persistida com, no mínimo: `accountId`, `userId`, `channelId`, `channelTitle`, `channelThumbnail`, `refreshToken` (criptografado), `isDefault`, `status`, `createdAt` e `updatedAt`. As rotas que listam contas (`GET /api/auth/accounts`, `GET /api/auth/status`) SHALL retornar somente contas em que `account.userId === req.session.userId`. Contas sem `userId` NUNCA SHALL ser retornadas a visitantes ou usuários.

#### Scenario: Lista filtrada por usuário
- **WHEN** o usuário A autenticado chama `GET /api/auth/accounts`
- **THEN** o sistema retorna somente `account.userId === userId(A)`, mesmo que outros usuários possuam contas

#### Scenario: Visitante não vê contas
- **WHEN** um visitante sem sessão chama `GET /api/auth/accounts`
- **THEN** o sistema responde 401

### Requirement: OAuth vinculado ao usuário da sessão
No início do fluxo OAuth, o sistema SHALL gravar na sessão o `userId` do usuário autenticado junto com `state`, `returnTo` e `reconnectAccountId`. O `state` SHALL ser aleatório, seguro, com expiração (10 minutos) e vinculado à sessão. No callback, o sistema SHALL validar o `state`, SHALL recuperar o `userId` EXCLUSIVAMENTE da sessão (nunca de query string) e SHALL obter o canal via `channels.list({ mine: true })`, salvando a conta com o `userId` correto.

#### Scenario: OAuth concluído com sucesso
- **WHEN** o usuário autenticado conecta um canal e o Google redireciona de volta com `state` válido e `code` válido
- **THEN** o sistema valida o `state`, usa o `userId` da sessão, cria a conta com esse `userId` e redireciona com `auth=success`

#### Scenario: OAuth com state inválido ou expirado
- **WHEN** o callback chega sem `state`, com `state` diferente do gravado ou após 10 minutos
- **THEN** o sistema responde 400 e não cria nem altera nenhuma conta

#### Scenario: Callback sem sessão ou com sessão trocada
- **WHEN** o callback não possui sessão autenticada ou o `userId` gravado não existe mais
- **THEN** o sistema não salva nenhuma conta e responde com erro

### Requirement: Conflito de canal já conectado a outra conta
Ao conectar ou reconectar, se o `channelId` já pertencer a uma conta existente de outro usuário, o sistema SHALL responder `409` com a mensagem "este canal já está conectado a outra conta" e NÃO SHALL substituir o canal ou o token do dono, mesmo que o OAuth tenha sido autorizado com sucesso.

#### Scenario: Usuário B tenta conectar canal do usuário A
- **WHEN** o usuário B autoriza no Google um canal cujo `channelId` já pertence ao usuário A
- **THEN** o sistema responde 409 com "este canal já está conectado a outra conta" e mantém intocada a conta do usuário A

#### Scenario: Usuário reconecta o próprio canal
- **WHEN** o usuário A reconecta um canal que já é dele (mesmo `channelId` e mesmo `userId`)
- **THEN** o sistema atualiza as credenciais da conta do usuário A normalmente

### Requirement: Posse exigida nas rotas de conta
As rotas que recebem `accountId` (definir canal padrão, desconectar, reconectar, upload, agendamento, cancelamento) SHALL verificar simultaneamente: sessão autenticada, conta existente e `account.userId === req.session.userId`. Quando a conta não existir, o sistema SHALL responder 404; quando existir mas não pertencer ao usuário, o sistema SHALL responder **403**.

#### Scenario: Usuário A define o canal do usuário B como padrão
- **WHEN** o usuário A chama `POST /api/auth/accounts/<accountId-de-B>/default`
- **THEN** o sistema responde 403 e não altera a conta de B

#### Scenario: Usuário A desconecta o canal do usuário B
- **WHEN** o usuário A chama `DELETE /api/auth/accounts/<accountId-de-B>`
- **THEN** o sistema responde 403 e não revoga nem remove a conta de B

#### Scenario: Operação em accountId inexistente
- **WHEN** um usuário autenticado referencia um `accountId` que não existe
- **THEN** o sistema responde 404

### Requirement: Upload e agendamento isolados
O endpoint de upload (`POST /api/youtube/upload`) e as rotas de agendamento SHALL resolver a conta de envio a partir do usuário da sessão: se `accountId` for informado, o sistema SHALL usá-lo somente se `account.userId === req.session.userId` (senão 403); se não for informado, SHALL usar a conta padrão DO usuário logado (`getDefaultAccountForUser`). O sistema NUNCA SHALL usar conta padrão global, primeira conta encontrada ou token de outro usuário.

#### Scenario: Upload sem accountId
- **WHEN** um usuário autenticado envia vídeo sem informar `accountId`
- **THEN** o sistema usa o canal padrão daquele usuário

#### Scenario: Upload com accountId de outro usuário
- **WHEN** um usuário envia vídeo informando `accountId` de outro usuário
- **THEN** o sistema responde 403 e não inicia nenhum upload

#### Scenario: Agendamento de item de outro usuário
- **WHEN** um usuário tenta agendar ou cancelar um item do inventário cujo `userId` não é o dele
- **THEN** o sistema responde 404 (item invisível) e não altera o item

### Requirement: Tokens criptografados e nunca serializados
O sistema SHALL armazenar `refreshToken` e `accessToken` criptografados (AES-256-GCM) no disco, usando chave do `.env`. A criptografia SHALL ser transparente para o código que usa as credenciais (upload, refresh, worker). Nenhuma resposta de API SHALL conter `refreshToken`, `accessToken`, `client secret` ou qualquer credencial, criptografada ou não. Contas que precisem de token mas o servidor não possua a chave SHALL ficar com `status: RECONNECT_REQUIRED`, sem derrubar o servidor.

#### Scenario: Resposta de API sem tokens
- **WHEN** qualquer rota retorna contas, status ou dados de canal
- **THEN** o payload não contém `refreshToken`, `accessToken` nem client secret

#### Scenario: Token usado corretamente pelo backend
- **WHEN** um upload, refresh de token ou o worker precisa das credenciais de uma conta
- **THEN** o sistema descriptografa internamente e usa o token sem expô-lo em resposta

#### Scenario: Chave de criptografia ausente
- **WHEN** o servidor inicia sem `TOKEN_ENCRYPTION_KEY` e tenta restaurar credenciais
- **THEN** o sistema marca a conta como `RECONNECT_REQUIRED`, registra aviso no console e permanece operando

### Requirement: Worker de postagem isolado por item
O worker de postagem (scheduler) SHALL executar sem sessão de usuário, mas SHALL buscar a conta usando conjuntamente `scheduledItem.userId` e `scheduledItem.accountId`, via `getAccountByUserAndId`. O worker NUNCA SHALL usar `getDefaultAccount()` global, primeira conta encontrada ou token de outro usuário. Itens agendados sem `userId` SHALL ser tratados como não publicáveis.

#### Scenario: Agendamento publicado com conta do dono
- **WHEN** o worker encontra um item `SCHEDULED` com `userId` e `accountId` de um usuário válido
- **THEN** o worker publica usando exatamente a conta correspondente ao par `userId + accountId`

#### Scenario: Item sem dono no worker
- **WHEN** o worker encontra um item agendado sem `userId`
- **THEN** o sistema não publica o item e o marca com erro, sem usar conta de outro usuário