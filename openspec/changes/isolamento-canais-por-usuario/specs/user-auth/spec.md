## Purpose

Autentica os visitantes do site com e-mail e senha via Supabase Auth, criando uma sessão server-side com `req.session.userId` que serve de base para todo o isolamento de dados por usuário.

## ADDED Requirements

### Requirement: Registro de usuário
O sistema SHALL permitir que um visitante se registre com e-mail e senha válidos via Supabase Auth. Como a confirmação de e-mail está desativada no projeto Supabase, o registro SHALL criar a sessão imediatamente. A resposta de registro NUNCA SHALL conter tokens, acesso à senha ou qualquer credencial do Supabase.

#### Scenario: Registro com dados válidos
- **WHEN** um visitante envia e-mail e senha válidos para registro
- **THEN** o sistema cria o usuário no Supabase, inicia uma sessão para ele e responde com sucesso contendo somente identificador e e-mail do usuário

#### Scenario: Registro com e-mail já cadastrado
- **WHEN** um visitante tenta registrar um e-mail que já existe
- **THEN** o sistema responde com erro 4xx e não cria sessão

#### Scenario: Registro com senha inválida
- **WHEN** a senha não atende às regras mínimas do Supabase
- **THEN** o sistema responde com erro 4xx e não cria sessão

### Requirement: Login com e-mail e senha
O sistema SHALL autenticar usuários via `POST /api/auth/login` (e-mail + senha), consultando o Supabase Auth. Em caso de sucesso, o sistema SHALL registrar `req.session.userId` com o UUID do usuário e SHALL regenerar a sessão para evitar fixation. Credenciais inválidas SHALL responder 401 com mensagem genérica, sem revelar se o e-mail existe.

#### Scenario: Login bem-sucedido
- **WHEN** um usuário cadastrado envia e-mail e senha corretos
- **THEN** o sistema cria sessão autenticada com `req.session.userId` e responde com o identificador e e-mail do usuário, sem tokens

#### Scenario: Senha incorreta
- **WHEN** o e-mail existe mas a senha está errada
- **THEN** o sistema responde 401 com mensagem genérica e não cria sessão

#### Scenario: E-mail inexistente
- **WHEN** o e-mail não está cadastrado
- **THEN** o sistema responde 401 com a mesma mensagem genérica do caso de senha incorreta

### Requirement: Logout
O sistema SHALL permitir logout por `POST /api/auth/logout`, destruindo a sessão e removendo dados sensíveis dela (como o fluxo OAuth em andamento). Após o logout, requisições autenticadas SHALL responder 401. O logout NÃO SHALL apagar canais, tokens ou inventário persistidos.

#### Scenario: Logout durante sessão ativa
- **WHEN** um usuário autenticado solicita logout
- **THEN** o sistema destrói a sessão e as rotas protegidas passam a responder 401

### Requirement: Sessão obrigatória para acesso a dados
Todas as rotas que listam, criam, alteram ou excluem dados de usuário (canais, inventário, agendamentos, uploads, configurações) SHALL exigir sessão autenticada. Sem sessão, o sistema SHALL responder 401 e o frontend SHALL exibir a tela de login.

#### Scenario: Acesso anônimo a rota de dados
- **WHEN** um visitante sem sessão chama `GET /api/auth/accounts` ou `GET /api/inventory`
- **THEN** o sistema responde 401 e não retorna dados de usuário

### Requirement: Identidade somente da sessão do servidor
O sistema SHALL obter o `userId` exclusivamente de `req.session.userId`. O sistema SHALL ignorar qualquer `userId`, e-mail de usuário ou identificador enviado pelo frontend em query string, corpo ou headers para decidir qual dado retornar ou alterar.

#### Scenario: Frontend tenta manipular identidade
- **WHEN** uma requisição autenticada inclui um campo `userId` diferente do da sessão no corpo ou na URL
- **THEN** o sistema ignora o campo e opera usando o usuário da sessão, sem erro adicional ou vazamento de dados

### Requirement: Sessão com prazo
A sessão SHALL expirar após o período configurado (cookie httpOnly, `sameSite: lax`, com prazo máximo de 7 dias). Sessões expiradas SHALL ser tratadas como anônimas (401) até novo login.

#### Scenario: Sessão expirada
- **WHEN** a sessão de um usuário expira
- **THEN** o sistema trata a requisição como anônima e responde 401