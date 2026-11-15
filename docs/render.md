# Revisão da adaptação para Render

Nenhum serviço foi criado, nenhum deploy foi executado e os dados reais não foram migrados. Conforme a opção do usuário, o Blueprint define somente um web gratuito, com deploy automático de `main`. O worker permanece separado no código e não será provisionado no Render. Agendamentos locais, comentários e edição exigem um processo independente `npm run worker`, com as mesmas variáveis do web. Não há pendência de autorização para plano pago nesta etapa.

## Funcionamento gratuito e alternativas para execução contínua

O web gratuito do Render suspende após 15 minutos sem tráfego; não é um executor 24h. O Render não oferece Background Worker gratuito. A aplicação não inicia workers no web nem usa chamadas artificiais para mantê-lo acordado. Sem um worker externo ativo, comentários, edição e agendamentos que ainda dependem de envio local ficam pendentes. Vídeos já enviados ao YouTube com `status.publishAt` são publicados pelo próprio YouTube, mesmo com o site suspenso.

| Alternativa | Disponibilidade | Limitação |
| --- | --- | --- |
| Worker em computador próprio ou máquina já disponível | Enquanto a máquina, a internet e o processo estiverem ativos | Sem contratação de hospedagem; há consumo de energia e dependência da máquina |
| Iniciar `npm run worker` manualmente e interromper com Ctrl+C ao terminar | Durante a sessão | Pendências são reavaliadas quando iniciar; não garante o horário enquanto estiver parado |
| Worker gerenciado no Render | Exige serviço pago | Fora do escopo; nenhuma configuração ou contratação será feita |

A alternativa preparada para esta etapa é web gratuito mais worker externo opcional. Nenhuma alternativa foi ativada. Um worker 24h gerenciado no Render dependeria de contratação futura, que não está autorizada.

O banco e o bucket privados também precisam existir externamente. A aplicação aceita PostgreSQL e armazenamento compatível com S3, sem exigir que sejam do Render. Não assumir que todo serviço externo é gratuito: verificar limites de espaço, tráfego, suspensão e cobrança antes de escolher. Para evitar contratação nesta etapa, usar recursos existentes ou manter somente a configuração preparada. O PostgreSQL gratuito do Render expira em 30 dias e não deve ser a única cópia de dados importantes. Nenhum banco gratuito temporário é criado pelo Blueprint.

`npm run validate:render` verifica tanto o schema atual do Render quanto a política deste projeto: somente um web `free`, sem worker, bancos ou discos provisionados pelo arquivo. O site ainda precisa dos segredos e da migração validada antes de uma futura ativação.

## Processos e armazenamento

| Responsabilidade | Comando / armazenamento |
| --- | --- |
| HTTP, OAuth, prévias e operações manuais | `node server/server.js` |
| Agendamentos YouTube/TikTok, comentários e edição | `npm run worker` |
| Inventários, contas OAuth, configurações e fila de edição | PostgreSQL, documentos AES-256-GCM com revisões |
| Sessões e estado do fluxo OAuth | PostgreSQL, cookies HTTP-only e Secure em produção |
| Vídeos originais e editados | Bucket privado compatível com S3, objetos por SHA-256 |
| Arquivos locais | Cache descartável em `DATA_DIR`, nunca fonte de dados de produção |

O web não inicia agendadores nem o editor. Comentários manuais retornam `202` após entrar na fila. Uploads manuais continuam disponíveis. O worker usa um advisory lock de sessão PostgreSQL: durante sobreposição de processos, somente o eleito executa tarefas. Se perder a conexão que sustenta o lock, encerra imediatamente. SIGTERM interrompe a busca por novas tarefas e aguarda a atual; após 115 segundos o processo sai sem liberar uma intenção como se tivesse concluído.

O modo JSON local continua disponível para desenvolvimento HTTP e para a suíte legada. O worker independente o recusa, pois dois processos escrevendo JSON não oferecem controle de concorrência compartilhado.

As leituras usam um snapshot por requisição/tarefa, sem cache global de contas. `saveItems` e o armazenamento de configurações/OAuth continuam sendo os únicos caminhos de mutação. Checkpoints fazem transações com comparação da revisão; respostas de sucesso só terminam após a confirmação. Se outro processo mudou o mesmo documento, a operação retorna `409`, sem sobrescrever a revisão vencedora. Atualize a página e repita a operação. Não repetir automaticamente uma chamada externa de resultado incerto.

Os arquivos são enviados ao bucket antes das referências serem confirmadas. Os objetos antigos não são apagados automaticamente, permitindo recuperar backups e referências antigas. Habilite versionamento, bloqueio de acesso público, criptografia do provedor e backup independente no bucket; isso é configuração operacional de recursos existentes, não foi aplicado por esta mudança. Conceda à aplicação somente leitura/escrita/multipart no prefixo necessário, sem exclusão de objetos. Separe as credenciais de administração/backup.

## Ambiente

Em ambos os processos:

- `NODE_ENV=production`, `PERSISTENCE_DRIVER=postgres` e Node 22 ou superior.
- `DATABASE_URL`: mesmo PostgreSQL, **conexão direta com sessão estável**, sem pool transacional intermediário: a eleição depende de advisory lock de sessão. Use conexão privada na mesma região; em conexão externa, TLS com verificação do certificado. Não use `rejectUnauthorized=false`.
- `TOKEN_ENCRYPTION_KEY`: **a mesma chave original**, com 64 caracteres hexadecimais; nunca gerar outra durante migração. Mantenha uma cópia segura fora do banco e do bucket.
- `SESSION_SECRET`: mesmo segredo aleatório com pelo menos 32 caracteres, preservado entre deploys.
- `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
- `S3_ENDPOINT` e `S3_FORCE_PATH_STYLE=true` quando o provedor exigir. Na AWS, endpoint vazio.
- Credenciais YouTube 1 e, quando usado, 2; credenciais TikTok. O web também recebe as variáveis de autenticação de usuários já existentes em `.env.example`.
- `DATA_DIR=/tmp/tube-autopilot-cache`. Não copiar os caminhos locais de JSON para o ambiente Render. Os nomes lógicos dos documentos devem permanecer os padrões.

`render.yaml` usa somente `sync: false` para segredos. Variáveis opcionais podem ficar vazias; o segundo cliente Google permanece opcional. Não incluir `.env`, `data/`, backups ou chaves no Git. O arquivo não cria banco ou bucket; ambos precisam existir antes de qualquer futura ativação. `sync: false` solicita valores na criação, mas não atualiza os existentes nas sincronizações seguintes.

No console Google/TikTok, adicionar os callbacks HTTPS do domínio do web (`/api/auth/google/callback`, alias `/auth/youtube/callback`, e `/api/tiktok/auth/callback`). Preservar `credentialSet`, `accountId`, `channelId` e a relação com `userId`; trocar o domínio do callback não exige trocar os tokens se as credenciais originais forem mantidas.

## Migração explícita, com os processos antigos parados

1. Fazer uma cópia independente de todo `data/` e da chave original, fora do repositório. Não iniciar o novo servidor com as origens reais para testar.
2. Configurar um banco **vazio**, bucket privado e a chave original. Definir `LEGACY_DATA_DIR` com caminho absoluto da cópia de origem e `MIGRATION_BACKUP_DIR` com caminho absoluto e seguro. Se houver `INVENTORY_PATH`, `OAUTH_ACCOUNTS_PATH`, `COMMENT_SETTINGS_PATH`, `METADATA_PATH`, `EDITOR_SETTINGS_PATH`, `EDITOR_JOBS_PATH` ou `EDITED_VIDEOS_DIR`, conferir seus caminhos: o importador os respeita.
3. Executar `npm run migrate:shared -- --offline-confirmed`. O comando valida todos os JSONs e os arquivos referenciados antes de importar; cria backup cifrado com os bytes originais em base64, manifesto de vídeos e arquivo `.sha256`; verifica o backup e então envia os vídeos e importa todos os documentos em uma única transação. Os vídeos sem referência são arquivados por conteúdo. Qualquer falha deixa os originais intactos; objetos já enviados permanecem disponíveis e o banco não recebe importação parcial. Um destino preenchido é recusado.
4. Conferir contagens, backup e vínculos de canais. Contas sem `userId` são preservadas, sem atribuição automática nem acesso por outro usuário. Recuperação de titularidade exige conferência administrativa da origem; não usar uma conta padrão arbitrária. JSON inválido, chave errada, dono divergente ou arquivo físico ausente interrompem a migração para correção na cópia.
5. Guardar o backup, seu checksum, cópia dos vídeos e a chave em locais independentes. Validar a restauração em outro banco vazio antes de descartar qualquer origem.
6. Só após revisão e autorização de infraestrutura, iniciar web e worker com os mesmos segredos. Verificar `/api/health`, login, listagem sem tokens, dois canais, reconexão do segundo cliente OAuth, upload, prévia, agendamento, cancelamento de edição e reinício com cache vazio.

Repetir a migração em banco preenchido não altera o destino. Para tentar novamente após falha, manter os processos antigos parados e usar o destino vazio; todos os backups são criados com nome novo, sem sobrescrever os anteriores. Não há migração automática na inicialização de produção.

## Backup e restauração

`BACKUP_PATH` deve apontar para um arquivo novo fora do repositório. `npm run backup:shared` exporta uma leitura consistente de todos os documentos, criptografada, com checksum. O manifesto referencia objetos imutáveis do bucket: **o backup do banco não substitui o backup independente dos vídeos**. Não aplicar políticas de expiração ou remoção a objetos ainda necessários para backups.

Para restaurar, parar web e worker, apontar `DATABASE_URL` para outro banco vazio, fornecer a chave original, o bucket com os vídeos preservados e `BACKUP_PATH`, e executar `npm run restore:shared -- --offline-confirmed`. O comando verifica checksum, descriptografia e presença/tamanho/hash declarado dos objetos antes de importar em transação. Aceita tanto o backup da migração quanto exportações posteriores. Uma restauração com cache vazio confere também o SHA-256 do conteúdo baixado.

Para rollback depois de novas publicações, primeiro exportar um backup atualizado. Não retomar os JSONs antigos enquanto o banco novo está recebendo alterações: isso cria duas fontes divergentes e pode repetir publicações. Manter o worker parado até definir uma única fonte restaurada.

## Comentários de resultado incerto

Antes da inserção, o worker persiste `POSTING`, texto congelado e canal da tentativa. A inserção não tem repetição automática HTTP. Depois de reinício, `POSTING`/`RECONCILING` são consultados com paginação no YouTube, comparando **autor do canal e texto original**. Um resultado encontrado vira `POSTED` com o ID do comentário, sem nova inserção.

Se a consulta falhar, permanece em reconciliação. Se concluir sem localizar o comentário, vira `REVIEW_REQUIRED`; as próximas consultas ainda podem confirmá-lo, mas nenhum reenvio é feito. O endpoint manual também impede reenfileirar esse estado. A API de inserção não tem chave de idempotência, portanto ausência na listagem não prova que a tentativa anterior falhou. Essa escolha pode exigir intervenção administrativa para um comentário que nunca chegou a ser enviado, preservando a prioridade de não duplicar.

## Limites para revisão

- O cache atualmente materializa o acervo referenciado. Dimensionar espaço temporário para originais e editados; acervos maiores exigem evolução para carregamento sob demanda e descarte do cache.
- O controle de revisão é por documento. Edição/progresso, importações e cliques simultâneos podem gerar `409`; a evolução para linhas por item pode reduzir contenção.
- Uploads externos interrompidos em `UPLOADING` não são repetidos automaticamente. Conferir YouTube/TikTok antes de liberar nova tentativa.
- O web gratuito pode suspender por inatividade e tem limites de recursos; a configuração é uma proposta sem custo de provisionamento, não uma instalação completa de produção.
- Testes SQL usam PostgreSQL embarcado via PGlite e testes HTTP locais; S3, Google e TikTok são simulados nos testes. Integração com fornecedores reais permanece uma verificação posterior, antes de ativar publicações.

Referências verificadas: [Blueprint](https://render.com/docs/blueprint-spec), [workers](https://render.com/docs/background-workers), [planos](https://render.com/docs/compute-plans), [deploys](https://render.com/docs/deploys), [segredos](https://render.com/docs/configure-environment-variables).

## Alterações para revisar

- `server/worker.js`: processo independente, eleição e encerramento.
- `server/persistence.js`, `server/schema.sql`, `server/metadata.js`: documentos compartilhados, transações, versões e isolamento de contexto.
- `server/media-store.js`: objetos privados e cache com verificação de integridade.
- `server/migrate-shared.js`, `server/backup-shared.js`, `server/restore-shared.js`: importação sem sobrescrita e recuperação verificável.
- `server/server.js`, `server/inventory.js`, `server/comments.js`, `server/oauth-store.js`, `server/tiktok.js`, `server/editor.js`, `server/categories.js`: integração com os recursos existentes.
- `render.yaml`, `.env.example`, `package.json`, `package-lock.json`, `.gitignore`, `README.md`: execução e configuração.
- `test/render.test.js`, cenário novo em `test/editor.test.js` e `openspec/changes/render-shared-worker/`: regressões e especificação.

O diretório contém Git e alterações anteriores, embora as instruções fornecidas indiquem o contrário. Alterações preexistentes em `src/`, nos testes de categorias/isolamento e no editor foram preservadas; o diff total não representa somente esta tarefa. Não foram feitos commits, pushes ou mudanças de branch.

Validação local final: **73 testes passaram, sem falhas ou testes ignorados**. Inclui inicialização real do servidor em ambiente isolado e comentário automático novo sem repetição no ciclo seguinte. A suíte também cobre a política gratuita, worker sem liderança sem acesso às filas, recusa de JSON em produção, recuperação de comentários, backup/restauração e perda do cache. `npm run validate:render` passou no schema público atual e na política gratuita; `openspec validate render-shared-worker --strict` passou. Integração com fornecedores reais continua fora dos testes offline. Resultados e configuração pendente estão em [validacao-final.md](validacao-final.md).

A suíte também revelou uma falha intermitente anterior na importação de arquivos iguais: a conclusão paralela das leituras podia preservar o segundo nome selecionado. A importação passou a processar na ordem de seleção, limitando também a memória usada simultaneamente. O teste de isolamento afetado passou isoladamente e na suíte completa após a correção.
