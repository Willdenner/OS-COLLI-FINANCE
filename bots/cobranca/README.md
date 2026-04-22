# Protótipo: cobrança via WhatsApp (WhatsApp Web)

Este projeto é um **protótipo** para:

- Cadastrar clientes (nome + telefone)
- Criar cobranças (valor + data + link opcional + anexos opcionais)
- Cadastrar clientes em massa por planilha Excel, com opção de já criar a cobrança na mesma importação
- Editar uma **mensagem-template** com variáveis:
  - `[valor]`
  - `[nome do cliente]`
  - `[data de pagamento]`
  - `[Link do pagamento]`
  - `[forma de pagamento]`
  - `[instruções de pagamento]`
  - `[anexos da cobrança]`
- Enviar a mensagem (e/ou boleto como anexo) via **WhatsApp Web** (QR Code)
- Enviar cobranças por **e-mail via Gmail** quando necessário
- Receber cobranças automaticamente de um sistema de carteira Lovable/Supabase via webhook assinado

## Requisitos

- Node.js 18+ (recomendado)

> Observação: a automação via WhatsApp Web **não é oficial** e pode falhar/bloquear números dependendo do uso.

## Rodar

```bash
cd whatsapp-cobranca-prototipo
npm install
npm start
```

Abra o painel em `http://localhost:3000` e escaneie o QR Code.

Antes de subir, copie o arquivo `.env.example` para a sua configuração de ambiente e ajuste os valores necessários, principalmente `ADMIN_USER` e `ADMIN_PASSWORD`.

> Observação: o projeto não carrega `.env` automaticamente sozinho. Use sua plataforma de deploy, um loader externo ou exporte as variáveis no shell antes de rodar.

## Docker

O projeto agora inclui um [Dockerfile](/Users/denner/Documents/whatsapp-cobranca-prototipo/Dockerfile:1) baseado em `node:20-slim`, com `chromium` instalado via `apt` e `CHROME_EXECUTABLE_PATH=/usr/bin/chromium`.

Build:

```bash
docker build -t whatsapp-cobranca-prototipo .
```

Run:

```bash
docker run --rm -p 3000:3000 \
  --env-file .env \
  -v whatsapp-cobranca-uploads:/app/data/uploads \
  -v whatsapp-cobranca-auth:/app/data/.wwebjs_auth \
  whatsapp-cobranca-prototipo
```

> Se você estiver usando o modo local com `data/db.json`, o ideal é montar `BOT_DATA_DIR` inteiro como volume em vez de persistir apenas `uploads` e `.wwebjs_auth`.

### Produção em Render

Para o WhatsApp Web funcionar de forma estável no Render, configure estes pontos:

- use um **Persistent Disk** montado no mesmo caminho do `BOT_DATA_DIR`
- se estiver usando o `Dockerfile` deste projeto, monte o disk em `/app/data`
- defina `CHROME_EXECUTABLE_PATH=/usr/bin/chromium`
- mantenha `ADMIN_USER` e `ADMIN_PASSWORD` configurados

Se o serviço reiniciar e o disk não estiver montado, a pasta `.wwebjs_auth` some e a sessão do WhatsApp precisa ser refeita.

Se o Render acusar estouro de memória:

- revise os logs do serviço para confirmar se a falha acontece ao subir o Chromium
- suba o serviço para um plano com mais memória se necessário
- evite rodar outros processos pesados no mesmo container

O launcher do Chromium deste projeto já usa flags enxutas para ambiente de container, como `--disable-dev-shm-usage`, `--disable-gpu`, `--disable-extensions` e `--no-zygote`, mas em instâncias muito pequenas ainda pode ser necessário mais memória no Render.

### Docker Compose

Também existe um [docker-compose.yml](/Users/denner/Documents/whatsapp-cobranca-prototipo/docker-compose.yml:1) para rodar localmente com:

- `app`: o painel/servidor Node com Chromium para o WhatsApp Web
- `postgres`: banco PostgreSQL com bootstrap automático via `database/postgres-bootstrap.sql`

Subida local:

```bash
docker compose up --build
```

O compose já:

- publica o painel em `http://localhost:3000`
- publica o Postgres em `localhost:5432`
- monta volumes para `uploads`, sessão do WhatsApp e dados do Postgres
- injeta `DATABASE_URL` automaticamente apontando para o serviço `postgres`

Se quiser customizar usuário, senha e nome do banco, defina no seu `.env`:

```bash
POSTGRES_DB=whatsapp_cobranca
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_PORT=5432
ADMIN_USER=admin
ADMIN_PASSWORD=troque-esta-senha-forte
```

## Scripts úteis

```bash
npm start   # sobe o painel
npm run dev # sobe com watch
npm test    # roda testes do store e da lógica principal
```

## Integração com carteira Lovable

O bot agora pode receber um `POST` externo para criar ou atualizar cobranças vindas da carteira criada no Lovable.

Endpoint do bot:

- `POST /api/integrations/lovable/wallet-items`

Segurança:

- o endpoint não usa o HTTP Basic Auth do painel
- ele valida assinatura `HMAC-SHA256` com a variável `LOVABLE_WEBHOOK_SECRET`
- a assinatura pode vir nos headers `X-Lovable-Signature`, `X-Signature` ou `X-Webhook-Signature`

Payload esperado:

```json
{
  "event": "card.created",
  "timestamp": "2026-04-15T14:30:00Z",
  "data": {
    "card_id": "a1b2c3",
    "client_name": "Empresa XPTO Ltda",
    "client_phone": "5511999998888",
    "client_email": "financeiro@xpto.com.br",
    "target_amount": 5000.0,
    "due_date": "2026-04-20T00:00:00Z",
    "status": "pendente",
    "payment_method": "boleto",
    "is_installment": false,
    "installment_count": 1,
    "notes": "Contrato mensal"
  }
}
```

Regras atuais:

- cria a cobrança quando o card estiver `pendente`, sem bloqueio e com telefone preenchido
- usa `billing_wallet_items.id` como chave de idempotência
- se o mesmo card chegar novamente, faz update da cobrança existente em vez de duplicar
- se o status vier diferente de `pendente`, o evento é ignorado por enquanto
- se o card não informar `payment_link`, a cobrança é criada sem link de pagamento

## Importação em massa de clientes

Na tela **Cadastro de Clientes**, o sistema agora permite:

- baixar um modelo Excel com todos os campos necessários
- importar clientes em lote
- já criar a cobrança na mesma linha da planilha quando vierem `valor_cobranca` e `vencimento`

Campos do modelo:

- `nome_cliente`
- `empresa_razao_social`
- `telefone`
- `email`
- `observacoes`
- `criar_cobranca`
- `valor_cobranca`
- `vencimento`
- `recorrencia`
- `template_mensagem`
- `link_pagamento`

> A importação em massa é focada em dados cadastrais e cobrança. Anexos como boleto e nota fiscal continuam sendo adicionados pelo painel depois do cadastro.

## Melhorias já aplicadas

- Cache em memória para o `db.json`, reduzindo leitura/escrita repetitiva
- Deduplicação de mensagens inbound para evitar registros duplicados
- Filtro de grupos/broadcast para manter o inbox operacional limpo
- Rastreio de status das cobranças (`pending`, `sending`, `sent`, `failed`)
- Histórico de mensagens enviadas e recebidas por cliente
- Dashboard com métricas operacionais e pendências visíveis
- Validação melhor de telefone, valor, data e link de pagamento

## Novo módulo: analista FP&A

O painel agora também inclui uma área de **FP&A baseada em extratos bancários**, pensada para funcionar como uma primeira camada de analista financeiro dentro do sistema.

O módulo permite:

- Importar extratos em **CSV** e **OFX**
- Normalizar lançamentos bancários em uma estrutura única
- Categorizar automaticamente receitas, marketing, folha, impostos, tecnologia, transferências internas e outras saídas
- Revisar manualmente a categoria de cada lançamento
- Gerar análises de:
  - fluxo de caixa
  - despesas por categoria
  - burn rate
  - receitas
  - **DRE caixa aproximada**
- Pedir relatórios em linguagem natural no painel, por exemplo:
  - `Quero uma visão geral do caixa`
  - `Mostre despesas por categoria`
  - `Gere uma DRE do período`

### Endpoints principais de FP&A

- `GET /api/fpa/bootstrap`
- `GET /api/fpa/imports`
- `GET /api/fpa/transactions`
- `POST /api/fpa/imports`
- `POST /api/fpa/report`
- `PUT /api/fpa/transactions/:id`

### Rodar o app sem inicializar WhatsApp

Se você quiser usar somente o módulo financeiro, pode subir o sistema sem tentar abrir o navegador do WhatsApp Web:

```bash
PORT=3100 DISABLE_WHATSAPP_INIT=1 ADMIN_USER=admin ADMIN_PASSWORD=senha node src/server.js
```

Isso é útil para validar o painel de FP&A em uma porta separada, sem depender da automação de cobrança.

### Separar as duas visões

O sistema agora pode abrir **duas interfaces diferentes**:

- `index.html`: visão de **Cobrança / WhatsApp**
- `fpa.html`: visão do **Analista FP&A**

Se quiser que uma porta abra diretamente no app financeiro, use:

```bash
APP_MODE=fpa PORT=3100 DISABLE_WHATSAPP_INIT=1 ADMIN_USER=admin ADMIN_PASSWORD=senha node src/server.js
```

Nesse modo:

- `/` abre direto a interface de FP&A
- `/cobrancas` continua disponível para voltar ao app operacional
- `/fpa` também abre a interface financeira explicitamente

## Variáveis de ambiente úteis

- `PORT=3000`
- `ADMIN_USER=admin`
- `ADMIN_PASSWORD=troque-esta-senha-forte`
- `DEFAULT_COUNTRY_CODE=55`
- `BOT_DATA_DIR=/caminho/personalizado/data`
- `DATABASE_URL=postgres://usuario:senha@host:5432/database`
- `DATABASE_SSL=require`
- `PG_CONNECTION_TIMEOUT_MS=10000`
- `PG_QUERY_TIMEOUT_MS=15000`
- `MAX_STORED_MESSAGES=2000`
- `CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- `WHATSAPP_CHROMIUM_ARGS=--window-size=1280,720 --lang=pt-BR`
- `DISABLE_WHATSAPP_INIT=1`
- `GMAIL_USER=seu-email@gmail.com`
- `GMAIL_APP_PASSWORD=sua-app-password`
- `GMAIL_FROM_NAME=V4 Cobrancas`
- `LOVABLE_WEBHOOK_SECRET=troque-este-secret-compartilhado`

> Para Gmail, use uma **App Password** da conta Google. O painel mostra quando a integração está ativa.
> Você pode configurar a conta Gmail diretamente na tela **Configurações** do sistema. Se preferir, as variáveis de ambiente continuam funcionando como fallback.

## Subir em banco online

O sistema agora consegue usar **PostgreSQL online** quando `DATABASE_URL` estiver configurada.

1. Importe o arquivo `database/postgres-bootstrap.sql` no seu banco.
2. Configure no servidor:
   - `DATABASE_URL`
   - `DATABASE_SSL=require` se o provedor exigir SSL
3. Suba o projeto normalmente com `npm start`.

Com `DATABASE_URL` ativo, o sistema deixa de ler/escrever o `data/db.json` e passa a persistir o estado no Postgres.

## Importante para produção

- O banco online resolve **clientes, cobranças, mensagens, templates e configurações**.
- Os anexos enviados continuam sendo gravados em `data/uploads/`.
- A sessão do WhatsApp Web continua em `data/.wwebjs_auth/`.

Por isso, em produção, o ideal é montar `BOT_DATA_DIR` em um volume persistente do servidor ou container.

## Onde os dados ficam

- `data/db.json`: clientes, cobranças e template (modo local, sem `DATABASE_URL`)
- `data/uploads/`: anexos enviados (boletos, notas fiscais, contratos e outros docs)
- `data/.wwebjs_auth/`: sessão do WhatsApp Web (para não precisar escanear sempre)
