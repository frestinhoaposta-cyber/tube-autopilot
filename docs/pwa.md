# Tube AutoPilot PWA

O painel agora possui manifest, ícone e service worker, permitindo instalação como aplicativo em navegadores compatíveis após hospedagem HTTPS.

## Teste
1. Inicie o servidor com `npm start` e abra `http://localhost:3000` (ou a porta configurada).
2. Confira `/manifest.webmanifest` e `/icon.svg`.
3. No Chrome/Edge, use a opção de instalar aplicativo quando disponível.
4. Confira no DevTools > Application se o manifest e service worker estão registrados.

A instalação não hospeda o backend nem executa agendamentos no dispositivo. Comentários e publicações continuam dependendo do worker na nuvem, banco persistente, credenciais e armazenamento de vídeos.

Por segurança, o service worker não guarda respostas de API, páginas autenticadas ou dados de usuários. A navegação continua exigindo conexão com o servidor.
