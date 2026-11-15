## Context

As APIs internas de leitura são síncronas e os testes existentes dependem desse contrato. Os arquivos contêm inventário, tokens e configurações; o editor também mantém uma fila persistente.

## Goals / Non-Goals

Preservar os contratos e o isolamento por usuário/canal. Não provisionar serviços nem executar a migração dos dados reais nesta revisão.

## Decisions

- Em produção, carregar documentos criptografados do PostgreSQL em um contexto AsyncLocalStorage por requisição ou tarefa. Leituras síncronas usam esse contexto, sem cache global de dados. Escritas são confirmadas com revisão otimista e transação atômica; conflitos retornam 409, nunca sobrescrevem silenciosamente outra revisão.
- Checkpoints persistem a intenção antes de chamadas externas. Um lock de sessão PostgreSQL elege um único worker, inclusive durante sobreposição de deploys.
- S3 privado com chaves por conteúdo; publicar o objeto antes de confirmar referências no banco. Manter objetos antigos para recuperação e rollback. Disco local é cache descartável e arquivos temporários.
- Comentários POSTING e falhas de transporte entram em reconciliação paginada por canal e texto congelado. Ausência de resultado confirmado exige revisão; a API do YouTube não fornece chave de idempotência para inserção.
- Migração explícita lê todos os arquivos antes de alterar qualquer destino, valida formatos e tokens, salva backup criptografado e manifesto SHA-256 e importa tudo em uma transação sem modificar originais. Contas sem dono são preservadas inacessíveis, para recuperação administrativa.

## Risks / Trade-offs

- Documentos inteiros podem causar conflitos sob concorrência: rejeitar com 409 e repetir a operação após atualizar; evolução futura pode normalizar linhas por item.
- O cache materializa vídeos referenciados; exige espaço temporário proporcional ao acervo. Não usar discos Render como volume compartilhado entre serviços.
- Sem idempotência externa não há garantia de exatamente uma inserção com repetição automática: resultados incertos não são reenviados.
- O usuário confirmou a opção gratuita: o arquivo final declara somente web gratuito; o worker fica separado para execução externa opcional, sem contratação nesta etapa. Comentários e tarefas locais não têm garantia 24h sem uma máquina externa ativa. O processo worker permanece implementado e testado, usando o mesmo PostgreSQL e bucket.

## Migration Plan

Parar o sistema antigo, executar backup/importação explícita, conferir contagens e hashes, configurar os mesmos segredos nos dois processos e só então iniciar web e worker. Rollback exige parar ambos, exportar um backup atualizado e restaurar em uma cópia; os arquivos originais não são modificados.
