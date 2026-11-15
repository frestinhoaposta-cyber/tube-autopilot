## 1. Persistência

- [x] 1.1 Implementar documentos compartilhados e sessões, verificando conflitos, criptografia e falhas nos testes.
- [x] 1.2 Integrar vídeos S3 e migração com backup, verificando hashes, preservação de originais e recuperação em testes.

## 2. Processos

- [x] 2.1 Extrair worker independente e eleição, verificando ausência de workers no web e encerramento.
- [x] 2.2 Recuperar comentários incertos, verificando reconciliação e ausência de reenvio.

## 3. Revisão

- [x] 3.1 Preparar render.yaml, documentação e exemplo de ambiente, validando o schema sem deploy. Blueprint somente com web gratuito conforme escolha do usuário; worker separado para execução externa opcional.
- [x] 3.2 Executar a suíte completa e registrar evidências e limitações para revisão: 65 testes passaram; schema Render e OpenSpec estrito válidos; git diff --check sem erros.
- [x] 3.3 Seguir a decisão explícita do usuário: somente web gratuito no Render e worker separado no código, sem proposta de contratação nesta etapa.
- [x] 3.4 Verificar a política gratuita, o worker em espera e a persistência sem fallback local; executar novamente a suíte e registrar os resultados e alternativas 24h. Resultado: 70 testes passaram; Blueprint e OpenSpec válidos; nenhuma infraestrutura criada ou publicada.
- [x] 3.5 Finalizar localmente: servidor real iniciado em ambiente isolado, comentário automático novo persistido sem segunda inserção, suíte completa com 73 testes aprovados, Blueprint e OpenSpec válidos; configuração pendente registrada em docs/validacao-final.md.
