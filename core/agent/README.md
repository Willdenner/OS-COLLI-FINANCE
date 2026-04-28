# Analista FP&A

Sistema web para importar extratos bancários, consolidar lançamentos financeiros, montar uma leitura gerencial de caixa/DRE e enviar lançamentos para o Conta Azul.

## O que o sistema faz

- Importa extratos em CSV e OFX.
- Consolida entradas, saídas, saldo líquido, burn médio e caixa conhecido.
- Filtra análises por mês e por conta bancária.
- Permite excluir contas de teste e lançamentos específicos.
- Permite revisar categorias uma a uma ou salvar alterações em massa.
- Aprende padrões de descrição/conta/categoria para classificar próximos meses automaticamente.
- Mantém um plano de contas DRE para conciliação gerencial.
- Configura OAuth do Conta Azul na própria tela FP&A.
- Gera prévia e envia lançamentos financeiros para contas a pagar/receber no Conta Azul.
- Recebe webhooks do Lovable para criar contratos recorrentes no Conta Azul e dar baixa automática em recebimentos confirmados.

## Requisitos

- Node.js 18+
- npm
- PostgreSQL opcional para produção

## Rodar localmente

```bash
npm install
ADMIN_USER=admin ADMIN_PASSWORD=admin PORT=3000 npm start
```

Abra `http://localhost:3000`.

O painel e as APIs são protegidos por HTTP Basic Auth. Defina sempre `ADMIN_USER` e `ADMIN_PASSWORD` antes de iniciar o servidor.

## Conta Azul

A tela `Conta Azul` dentro do painel concentra a configuração OAuth e a exportação FP&A.

Fluxo recomendado para desenvolvimento:

1. Informe `Client ID`, `Client Secret` e `Redirect URI`.
2. Use `https://www.contaazul.com` como Redirect URI quando esse for o endereço cadastrado no app Conta Azul.
3. Clique em `Conectar Conta Azul`.
4. Faça login no Conta Azul.
5. Copie o parâmetro `code` da URL final.
6. Cole o código no painel e clique em `Trocar Código`.
7. Clique em `Testar Conexão`.
8. Informe o ID do contato padrão e o ID da conta financeira padrão para exportar lançamentos.

A URL de autorização gerada segue o formato:

```text
https://auth.contaazul.com/login?response_type=code&client_id=...&redirect_uri=https://www.contaazul.com&state=...&scope=openid+profile+aws.cognito.signin.user.admin
```

As credenciais podem ser salvas pelo painel ou fornecidas por variáveis de ambiente:

```bash
CONTA_AZUL_CLIENT_ID=
CONTA_AZUL_CLIENT_SECRET=
CONTA_AZUL_REDIRECT_URI=https://www.contaazul.com
```

**Endpoints e OAuth (opcionais):** o agente assume a API pública v2. Para fixar tudo no ambiente (Deploy / Docker / Render), use por exemplo:

```bash
# Base da API e fluxo OAuth (padrões oficiais se omitidos)
CONTA_AZUL_BASE_URL=https://api-v2.contaazul.com
CONTA_AZUL_AUTH_URL=https://auth.contaazul.com/login
CONTA_AZUL_TOKEN_URL=https://auth.contaazul.com/oauth2/token
CONTA_AZUL_SCOPE=openid profile aws.cognito.signin.user.admin

# Cadastro de contrato após o contrato vindo do Finance (POST e próximo número)
CONTA_AZUL_CONTRACTS_PATH=/v1/contratos
CONTA_AZUL_NEXT_CONTRACT_NUMBER_PATH=/v1/contratos/proximo-numero

# Teste de conexão (GET conta conectada)
CONTA_AZUL_HEALTH_PATH=/v1/pessoas/conta-conectada
```

**Autorização da chamada à API:** após o OAuth no painel, o `access_token` fica no estado do app. Em ambiente você pode ainda definir `CONTA_AZUL_ACCESS_TOKEN` / `CONTA_AZUL_REFRESH_TOKEN` (bootstrap), `CONTA_AZUL_AUTH_MODE=bearer` (padrão) ou `custom_header` com `CONTA_AZUL_CUSTOM_HEADER_NAME` e `CONTA_AZUL_CUSTOM_HEADER_VALUE` se a sua integração exigir outro mecanismo.

## Integração Lovable

O Analista FP&A pode atuar como ponte entre o sistema de contratos/cobrança criado no Lovable e o Conta Azul.

No painel, acesse **Configurações → Lovable · Contratos e Recebimentos**, ative a integração, salve um segredo exclusivo e copie as duas URLs de webhook exibidas. Como alternativa para deploys que preferem variável de ambiente, configure:

```bash
LOVABLE_WEBHOOK_SECRET=um-segredo-forte
```

O Lovable deve enviar esse valor no header `x-lovable-webhook-secret` ou como `Authorization: Bearer <segredo>`.

## Conexão diária com Colli Finance

Para o orquestrador de Contas a Receber puxar cadastros novos do Finance sem depender de envio manual, configure no serviço principal `os-colli-finance`:

```bash
COLLI_FINANCE_CONTRACTS_URL=https://seu-finance/api/contracts
COLLI_FINANCE_BILLING_CARDS_URL=https://seu-finance/api/billing-cards
COLLI_FINANCE_PAYMENTS_URL=https://seu-finance/api/payments
COLLI_FINANCE_API_TOKEN=token-opcional
```

O FP&A chama essas URLs com filtros de data no query string:

- contratos: `businessDate`, `date`, `status=new`
- cards de cobrança: `businessDate`, `dueTo`, `overdue=true`, `status=pending`
- pagamentos: `businessDate`, `paymentDate`, `status=paid`

Cada endpoint pode responder um array direto ou um objeto com a lista em `contracts`, `newContracts`, `billingCards`, `cards`, `walletItems`, `payments`, `receipts`, `items`, `records` ou `data`. Use o botão **Testar Finance** no painel do orquestrador para validar HTTP, quantidade de itens e chaves detectadas do JSON.

### Novo contrato

Endpoint:

```text
POST /api/integrations/lovable/contracts
```

Campos mínimos quando não enviar um payload pronto do Conta Azul:

```json
{
  "contractId": "lovable_ct_123",
  "customerId": "uuid_cliente_conta_azul",
  "productId": "uuid_produto_ou_servico_conta_azul",
  "description": "Mensalidade assessoria financeira",
  "amountCents": 99000,
  "startDate": "2026-05-01",
  "endDate": "2027-04-30",
  "firstDueDate": "2026-05-10",
  "dueDay": 10,
  "paymentMethod": "PIX"
}
```

Também é possível enviar `contaAzulPayload` ou `contaAzulContractPayload` já no formato oficial do `POST /v1/contratos`.

O pull do **Finance** (orquestrador) mapeia automaticamente, entre outros, `contract_start_date` / `first_charge_date` / `monthly_value`, `billing_clients` (lista com `id` ou `conta_azul_id`), `id_conta_financeira` e `servico_id` / `productId` — nomes alinhados ao JSON típico do app. Se algum ID não vier no contrato, use os defaults do painel (contato e conta financeira FP&A) ou, em último caso, `CONTA_AZUL_DEFAULT_CONTRACT_ITEM_ID`, `CONTA_AZUL_DEFAULT_CONTRACT_CUSTOMER_ID` e `CONTA_AZUL_DEFAULT_CONTRACT_FINANCIAL_ACCOUNT_ID` no ambiente.

### Recebimento confirmado

Endpoint:

```text
POST /api/integrations/lovable/receipts
```

Campos mínimos recomendados:

```json
{
  "paymentId": "lovable_pay_123",
  "contractId": "lovable_ct_123",
  "installmentId": "uuid_parcela_conta_azul",
  "amountCents": 99000,
  "paidAt": "2026-05-10",
  "paymentMethod": "PIX",
  "nsu": "abc123"
}
```

Se `installmentId` não for enviado, o sistema tenta localizar a parcela por `eventId`/`contaAzulEventId` ou por busca de recebíveis com data e valor. Para testes sem enviar ao Conta Azul, use `?dryRun=true`.

## Exportação para n8n

Para automações no n8n puxarem dados consolidados do FP&A hospedado no Render, use:

```text
GET /api/integrations/n8n/export
```

A rota usa o mesmo HTTP Basic Auth do painel (`ADMIN_USER` e `ADMIN_PASSWORD`). No n8n, configure um node HTTP Request com autenticação Basic e a URL do Render, por exemplo:

```text
https://seu-servico.onrender.com/api/integrations/n8n/export?limit=200
```

Parâmetros opcionais:

- `limit`: controla o volume retornado, com teto seguro no servidor.
- `from` e `to`: filtram transações por período.
- `months`: filtra meses, separado por vírgula.
- `accountName`: filtra por conta bancária/importada.

O JSON retorna um snapshot com `settings` sanitizado, status de persistência, transações/importações FP&A, contas DRE, vínculos Finance, últimas execuções do orquestrador de recebíveis e histórico de sincronizações Lovable/Conta Azul.

## Persistência das conexões

As conexões do Conta Azul e do Lovable são salvas no estado do app. Em produção, use `DATABASE_URL` apontando para um PostgreSQL durável. Se o app rodar em Render, Railway, Fly ou outro deploy com filesystem efêmero e sem banco/disco persistente, os tokens e segredos podem desaparecer quando o serviço reiniciar, o que parece um reset após atualizar a página.

Alternativas seguras:

- Configure `DATABASE_URL` e, quando necessário, `DATABASE_SSL=require`.
- Em Docker Compose local, use o `docker-compose.yml`, que já sobe PostgreSQL e volumes.
- Se preferir arquivo local, configure `BOT_DATA_DIR` para um diretório em disco persistente do provedor.

## Variáveis de ambiente

- `PORT`: porta HTTP do app.
- `ADMIN_USER`: usuário do Basic Auth.
- `ADMIN_PASSWORD`: senha do Basic Auth.
- `BOT_DATA_DIR`: diretório local para `db.json` quando não há PostgreSQL.
- `DATABASE_URL`: conexão PostgreSQL opcional.
- `DATABASE_SSL`: use `require` quando o provedor exigir SSL.
- `PG_CONNECTION_TIMEOUT_MS`: timeout de conexão PostgreSQL.
- `PG_QUERY_TIMEOUT_MS`: timeout de queries PostgreSQL.
- `CONTA_AZUL_CLIENT_ID`: Client ID opcional para pré-configurar a integração.
- `CONTA_AZUL_CLIENT_SECRET`: Client Secret opcional para pré-configurar a integração.
- `CONTA_AZUL_REDIRECT_URI`: Redirect URI opcional para pré-configurar a integração.
- `CONTA_AZUL_BASE_URL` / `CONTA_AZUL_API_BASE_URL`, `CONTA_AZUL_AUTH_URL`, `CONTA_AZUL_TOKEN_URL`, `CONTA_AZUL_SCOPE` / `CONTA_AZUL_OAUTH_SCOPE`: URLs e escopo OAuth (opcionais; há padrões oficiais).
- `CONTA_AZUL_CONTRACTS_PATH`, `CONTA_AZUL_NEXT_CONTRACT_NUMBER_PATH`: criação de contrato e próximo número (padrão `/v1/contratos` e `/v1/contratos/proximo-numero`).
- `CONTA_AZUL_HEALTH_PATH` / `CONTA_AZUL_HEALTH_ENDPOINT`: GET de teste de conexão.
- `CONTA_AZUL_AUTH_MODE`, `CONTA_AZUL_ACCESS_TOKEN`, `CONTA_AZUL_REFRESH_TOKEN`, `CONTA_AZUL_TOKEN_TYPE`, `CONTA_AZUL_CUSTOM_HEADER_*`: modo de auth e credenciais opcionais.
- `LOVABLE_WEBHOOK_SECRET`: segredo opcional para aceitar webhooks do Lovable via ambiente. Também pode ser configurado pelo painel do Analista FP&A.

## Docker

Build:

```bash
docker build -t analista-fpa .
```

Run:

```bash
docker run --rm -p 3000:3000 \
  --env-file .env \
  -v analista-fpa-data:/app/data \
  analista-fpa
```

## Docker Compose

```bash
docker compose up --build
```

O compose sobe:

- `app`: servidor Node do Analista FP&A.
- `postgres`: banco PostgreSQL com a tabela `app_state`.

## Endpoints principais

- `GET /api/fpa/bootstrap`
- `POST /api/fpa/imports`
- `GET /api/fpa/transactions`
- `PUT /api/fpa/transactions/:id`
- `PUT /api/fpa/transactions/batch`
- `DELETE /api/fpa/transactions/:id`
- `GET /api/fpa/dre-accounts`
- `POST /api/fpa/dre-accounts`
- `POST /api/fpa/conta-azul/settings`
- `POST /api/fpa/conta-azul/preview`
- `POST /api/fpa/conta-azul/push`
- `GET /api/integrations/n8n/export`
- `POST /api/integrations/lovable/settings`
- `POST /api/integrations/lovable/contracts`
- `POST /api/integrations/lovable/receipts`
- `GET /api/integrations/lovable/syncs`
- `POST /api/conta-azul/oauth/authorize-url`
- `POST /api/conta-azul/oauth/exchange-code`
- `POST /api/conta-azul/test-connection`

## Testes

```bash
npm test
```
