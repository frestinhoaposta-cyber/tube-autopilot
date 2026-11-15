## Purpose

Executar o Tube AutoPilot no Render com processos independentes e dados duráveis compartilhados, preservando canais, arquivos e configurações.

## ADDED Requirements

### Requirement: Execução independente
O sistema MUST executar agendamentos, comentários e edição automática somente no worker; produção MUST eleger um único worker.

#### Scenario: Sobreposição de processos
- **WHEN** web e dois workers são iniciados
- **THEN** somente o worker eleito executa tarefas e o web apenas enfileira comentários e edição.

### Requirement: Persistência compartilhada segura
O sistema MUST criptografar documentos em repouso, confirmar alterações antes de responder sucesso e rejeitar gravações concorrentes obsoletas.

#### Scenario: Atualização concorrente
- **WHEN** dois contextos alteram a mesma revisão do inventário
- **THEN** somente um confirma e o outro recebe conflito sem apagar dados.

### Requirement: Migração recuperável
A migração MUST preservar originais, canais e arquivos, produzir backup criptografado verificável e rejeitar dados inválidos ou destino já preenchido.

#### Scenario: Arquivo inválido
- **WHEN** um JSON de origem está corrompido
- **THEN** a migração falha sem substituir os dados por listas vazias.

### Requirement: Recuperação de comentários
O worker MUST reconciliar resultados incertos antes de qualquer nova inserção e MUST impedir reenvio automático quando não há confirmação suficiente.

#### Scenario: Reinício depois da inserção
- **WHEN** o YouTube aceitou um comentário mas o banco ainda registra POSTING
- **THEN** o worker encontra o comentário pelo canal e texto e grava POSTED sem inserir novamente.

### Requirement: Vídeos duráveis
O sistema MUST manter vídeos originais e editados em armazenamento privado compartilhado antes de confirmar referências no banco.

#### Scenario: Cache vazio
- **WHEN** um processo inicia sem vídeos locais
- **THEN** os arquivos referenciados são recuperados do bucket e os recursos continuam disponíveis.

### Requirement: Operação sem contratação
O Blueprint MUST declarar somente um Web Service gratuito e MUST NOT provisionar worker, banco ou disco no Render nesta etapa. A documentação MUST explicar que o web gratuito não oferece execução contínua e apresentar alternativas externas antes de qualquer contratação.

#### Scenario: Configuração de infraestrutura ampliada
- **WHEN** alguém adiciona worker, banco, disco ou omite o plano gratuito do web
- **THEN** a validação local rejeita o Blueprint antes de qualquer aplicação.
