# Inicialização automática no Windows 10/11

Este modo roda o Tube AutoPilot sem abrir o VS Code. No logon do usuário, dois processos separados são iniciados:

| Serviço | Função | Entrada |
| --- | --- | --- |
| Web | Painel HTTP em `http://127.0.0.1:3000` | `server/server.js` |
| Worker | Agendamentos, comentários e edição automática | `server/local-worker.js` |

O instalador usa o **Agendador de Tarefas** quando o serviço `Schedule` está disponível. Se ele estiver parado ou sem permissão, o instalador usa automaticamente entradas `TubeAutoPilot-Web` e `TubeAutoPilot-Worker` no registro do usuário (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`). As duas opções são nativas e gratuitas; não é necessário administrador no modo registro.

Não há deploy, migração, PostgreSQL, S3, Render ou serviço pago. Os dados continuam em `data/`, incluindo vídeos, inventário, contas OAuth e a chave de criptografia original.

## Antes de instalar

1. Instale o Node.js 22 ou superior.
2. Na raiz do projeto, execute `npm install` uma vez.
3. Confira se o arquivo `.env` existe. Se ainda não existir, copie `.env.example` para `.env` e preencha as credenciais.
4. Use a **mesma** `TOKEN_ENCRYPTION_KEY` de sempre. Trocar essa chave impede a leitura dos tokens OAuth salvos.
5. Se usar `AUTH_MODE=single`, preencha `SINGLE_USER_ID` com o `userId` original e `PANEL_PASSWORD` (mínimo de 12 caracteres). Supabase não é necessário nesse modo.

Os scripts não editam `.env`, não movem arquivos, não apagam backups e não executam migração.

## Instalar

No Explorador de Arquivos, abra `scripts\windows` e dê duplo clique em:

```text
instalar-inicio.cmd
```

Se o Agendador negar permissão para criar tarefas na raiz, o próprio script cai para o registro do usuário. Se preferir forçar o Agendador, abra o PowerShell como **Administrador** e execute:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\windows\instalar-inicio.ps1"
```

A instalação registra as duas entradas para o usuário atual, com:

- gatilho **Na inicialização do usuário**;
- reinício automático pelo Agendador após falha quando ele está disponível (3 tentativas, intervalo de 1 minuto);
- supervisor Node que reinicia o processo filho com espera progressiva nos dois modos;
- bloqueio de instância duplicada por porta loopback (`43110` para o web, `43111` para o worker);
- `PERSISTENCE_DRIVER=local`, `HOST=127.0.0.1` e `PORT=3000` forçados pelo supervisor.

A porta 3000 escuta apenas em `127.0.0.1`. O painel não fica exposto à rede.

## Uso diário

```text
iniciar.cmd       inicia as tarefas manualmente sem precisar relogar
parar.cmd         para o web e o worker, mantendo as tarefas registradas
diagnostico.cmd   mostra status, portas, health, config e últimas linhas dos logs
```

O painel fica em:

```text
http://127.0.0.1:3000
```

Os logs ficam em:

```text
logs\windows\web.log
logs\windows\worker.log
```

Cada log é girado para `.log.1` quando passa de 10 MB.

## Como funciona a proteção contra duplicidade

`scripts/run-service.js` abre uma porta TCP somente em `127.0.0.1` antes de iniciar o processo real. Se outra instância já estiver ativa, a nova termina com código `3` e registra a mensagem no log. Não há arquivo de lock stale: o sistema operacional libera a porta quando o processo encerra, mesmo após uma parada forçada.

Além disso, quando o Agendador está disponível, as tarefas usam `MultipleInstances=IgnoreNew`.

## Como funciona a reinicialização

Se `server/server.js` ou `server/local-worker.js` sair, o supervisor registra o código/sinal no log e inicia um novo processo após 5 segundos, dobrando a espera até 60 segundos enquanto as falhas se repetem. Após 30 segundos estáveis, a contagem volta ao início. Isso vale tanto para o Agendador quanto para o registro do usuário. O Agendador também tenta reiniciar a tarefa em caso de falha.

## Desinstalar

Para remover apenas a inicialização automática:

```text
desinstalar-inicio.cmd
```

Ou, como Administrador:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\windows\desinstalar-inicio.ps1"
```

Isso remove as tarefas e/ou as entradas de registro `TubeAutoPilot-Web` e `TubeAutoPilot-Worker` e encerra os processos correspondentes. **Não** remove `.env`, `data/`, vídeos, tokens, chaves, backups ou logs. Para apagar logs, faça manualmente depois de conferir o diagnóstico.

## Solução de problemas

- **`/api/health` indisponível:** rode `diagnostico.cmd`, veja `web.log` e confirme se outro processo está usando a porta 3000.
- **Worker não processa agendamentos:** confirme `worker.log`; procure por `[scheduler] pending=` e `[worker local] ciclo concluído`.
- **Agendador parado:** `diagnostico.cmd` mostra `Agendador de Tarefas: Stopped`. Se aparecer `Modo de inicialização: Registro do usuário (HKCU Run)`, está tudo certo: o fallback já cobre o logon. Para usar tarefas, inicie o serviço `Schedule` como Administrador e rode `instalar-inicio.cmd` novamente.
- **Tarefa não inicia após reiniciar o PC:** verifique se o usuário do Windows ainda é o mesmo usado na instalação e execute `instalar-inicio.cmd` novamente.
- **Erro de descriptografia OAuth:** a `TOKEN_ENCRYPTION_KEY` atual não é a original. Restaure o valor antigo no `.env`; não execute migração.
- **Porta exposta:** se `diagnostico.cmd` mostrar `0.0.0.0` na porta 3000, pare os serviços, remova qualquer `HOST=0.0.0.0` manual do `.env` e reinstale.

Nenhum destes comandos envia dados ao GitHub nem altera os backups existentes.
