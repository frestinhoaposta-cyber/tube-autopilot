# Tube AutoPilot v2 — login Google + upload real para YouTube

Esta versão troca os botões demonstrativos por integração real com OAuth 2.0 e YouTube Data API v3.

## 1. Instalar e rodar

No VS Code, abra a pasta do projeto e rode:

```bash
npm install
```

Copie `.env.example` para `.env` e preencha as credenciais. Depois:

```bash
npm run dev
```

Abra exatamente:

http://localhost:3000

## 2. Criar as credenciais do Google

1. Entre no Google Cloud Console.
2. Crie ou selecione um projeto.
3. Vá em APIs e serviços > Biblioteca.
4. Ative **YouTube Data API v3**.
5. Configure a **Tela de consentimento OAuth**.
6. Se o app estiver em modo Testing, adicione sua conta Google em **Test users / Usuários de teste**.
7. Vá em Credenciais > Criar credenciais > ID do cliente OAuth.
8. Escolha **Aplicativo da Web**.
9. Em URI de redirecionamento autorizados, coloque EXATAMENTE:

```
http://localhost:3000/auth/youtube/callback
```

10. Copie o Client ID e Client Secret para o `.env`:

```env
PORT=3000
SESSION_SECRET=coloque-aqui-uma-frase-aleatoria-grande
YOUTUBE_CLIENT_ID=SEU_CLIENT_ID.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=SEU_CLIENT_SECRET
YOUTUBE_REDIRECT_URI=http://localhost:3000/auth/youtube/callback
```

11. Pare o servidor (`Ctrl+C`) e execute `npm run dev` de novo.
12. Abra Configurações > **Conectar com Google**.

## 3. Como enviar um vídeo

1. Conecte seu canal em Configurações.
2. Vá em Gerar conteúdo e selecione MP4/MOV/WEBM.
3. Gere ou escreva título, descrição e tags.
4. Clique em Continuar para agendamento.
5. Escolha data/hora/visibilidade.
6. Clique em **Enviar / agendar no YouTube**.

Para uma publicação pública futura, a API exige que o vídeo seja enviado como `private` e use `status.publishAt`. O YouTube fará a publicação depois.

## Problemas comuns

### redirect_uri_mismatch
A URI no Google Cloud precisa ser exatamente igual à `YOUTUBE_REDIRECT_URI` do `.env`.

### Error 403 / access_denied
Confira a Tela de consentimento OAuth e adicione sua conta em Usuários de teste enquanto o app estiver em Testing.

### Vídeo fica privado mesmo escolhendo Público
Projetos de API não verificados podem ter uploads via `videos.insert` restritos a privado até o projeto passar pela auditoria de conformidade do YouTube.

### "Conecte sua conta primeiro"
O login não foi concluído ou a sessão do Node foi reiniciada. Conecte novamente.

## Observações de segurança

- Não envie seu `YOUTUBE_CLIENT_SECRET` para ninguém e não coloque credenciais dentro de `src/app.js`.
- Esta versão guarda tokens OAuth na sessão em memória, adequada para desenvolvimento local. Para colocar o site para clientes, use banco/armazenamento persistente e criptografado.
- O upload passa pelo servidor Node; mantenha espaço em disco suficiente durante o envio.

## Estoque e uploads em massa

1. Abra **Estoque** no menu.
2. Escolha **Roube um Brainrot** e selecione vários vídeos.
3. Os arquivos são guardados em `data/videos` e os metadados persistentes em `data/inventory.json`.
4. Revise os títulos ou use **Outro título** / **Gerar novos títulos**.
5. Selecione os vídeos e use **Enviar selecionados** ou **Agendar selecionados**.
6. No agendamento, informe a data inicial e o intervalo, confira a prévia e confirme.

## Fontes de vídeo na aba Shorts

- **Estoque / Biblioteca:** mostra os vídeos LONG disponíveis, com busca, categoria, ordenação, quantidade e seleção manual. Ao adicionar, cria um registro SHORT independente usando o mesmo arquivo físico.
- **Arquivos locais:** envia arquivos novos diretamente como SHORT pelo endpoint `/api/shorts`.
- A conversão da Biblioteca usa `/api/shorts/from-library` e impede outro SHORT com o mesmo `fileHash`.
- Excluir uma das referências LONG/SHORT não remove o arquivo enquanto a outra ainda estiver usando-o.

O gerador é local e não usa OpenAI. A configuração central da categoria fica em `server/categories.js`. Os vídeos dessa categoria usam a categoria oficial **Jogos** (`categoryId` 20) no YouTube.
