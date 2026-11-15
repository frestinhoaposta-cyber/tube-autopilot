# Validação local final

Nenhum deploy, contratação, criação de recurso externo, comentário real ou migração dos dados reais foi executado. Os processos de teste foram encerrados. Os arquivos de origem e as alterações preexistentes foram preservados.

## Resultados

| Verificação | Resultado |
| --- | --- |
| `npm test` | **73 testes; 73 passaram; 0 falhas; 0 ignorados** |
| `node server/server.js` em processo real isolado | Site e `/api/health`: HTTP 200; contas sem sessão: HTTP 401 |
| Web sem workers | Inicialização sem agendador, postagem de comentários ou edição automática |
| Produção com persistência local | Inicialização recusada antes de criar dados |
| Comentário automático novo | Gravado como `POSTED`, ID e data persistidos; ciclo seguinte não repete inserção |
| Recuperação após reinício / falha de transporte | Reconciliação sem reenvio; resultado incerto segue para revisão |
| Worker duplicado | Segundo worker não adquire liderança; em espera não lê filas nem executa comentários |
| Persistência | Criptografia, leitura em novo contexto, sessões OAuth compartilhadas e rejeição de revisão obsoleta |
| Migração e backup | Originais preservados, vínculo por canal mantido, rollback após falha de upload e restauração com checksum |
| Vídeos | Armazenamento antes da referência, recuperação sem cache e rejeição de download corrompido |
| `npm run validate:render` | Schema público atual e política gratuita válidos |
| `openspec validate render-shared-worker --strict` | Válido |
| `git -c core.safecrlf=false diff --check` | Sem erros |

Os testes usam HTTP local e PostgreSQL embarcado (PGlite). YouTube, TikTok e S3 são simulados: esses resultados confirmam o fluxo do código e as proteções, mas não certificam credenciais, permissões, quotas ou disponibilidade dos provedores reais. A inicialização HTTP usa dados temporários exclusivos do teste, sem ler o `.env` real. Em produção, o código exige PostgreSQL externo e não permite fallback para JSON local.

## O que falta configurar antes de ativar no Render

1. Disponibilizar um PostgreSQL externo com conexão direta e sessão estável, configurar `DATABASE_URL` e usar TLS verificado quando a conexão for externa. Não provisionar banco pelo Blueprint.
2. Disponibilizar bucket privado compatível com S3 e configurar `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` e, quando necessário, `S3_ENDPOINT`/`S3_FORCE_PATH_STYLE`. Conferir acesso público bloqueado, backup independente e limites do provedor.
3. Informar `SESSION_SECRET` forte e a **chave original** `TOKEN_ENCRYPTION_KEY` em formato hexadecimal de 64 caracteres. Os dois processos devem usar os mesmos valores; não trocar a chave durante a migração.
4. Configurar a autenticação de usuários já existente (`SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`), OAuth do YouTube por canal e, quando utilizados, segundo cliente Google e TikTok. Registrar os callbacks HTTPS no domínio que o web receberá.
5. Com o sistema antigo parado, fazer cópia independente da origem, executar a migração explícita com backup e verificar contagens, vínculos e restauração em banco vazio. Os comandos e cuidados estão em [render.md](render.md).
6. Escolher onde executar `npm run worker` com o mesmo banco, bucket e segredos. Nenhum worker é provisionado no Render nesta opção gratuita. Computador próprio ligado ou execução manual são alternativas sem contratar hospedagem; comentários, edição e agendamentos locais só avançam enquanto o processo estiver ativo.
7. Somente após decisão futura de publicar, conectar o repositório e revisar o Blueprint gratuito na branch `main`. O arquivo está preparado para deploy automático após essa ativação, mas não foi aplicado ou sincronizado nesta tarefa.

O web gratuito pode suspender por inatividade. Não há garantia de comentários ou tarefas locais 24h somente com ele. Vídeos já enviados com `publishAt` continuam agendados no próprio YouTube. A gratuidade e os limites do banco/bucket externos precisam ser conferidos antes de escolher um provedor; nenhum serviço foi contratado nesta preparação.
