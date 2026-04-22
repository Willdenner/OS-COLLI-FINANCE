# Colli Finance OS — Guia de Deploy no Hetzner

## Pré-requisitos
- Conta no GitHub com o monorepo criado
- Conta no Hetzner Cloud (hetzner.com/cloud)
- Terminal no seu computador (Mac/Linux) ou WSL no Windows

---

## PARTE 1 — Criar o Servidor no Hetzner

### 1.1 — Criar conta e servidor

1. Acesse **cloud.hetzner.com** e crie uma conta
2. Crie um novo projeto: `Colli Finance OS`
3. Clique em **Add Server** e configure:

| Campo | Valor |
|-------|-------|
| **Location** | Nuremberg (NBG1) ou Falkenstein (FSN1) |
| **Image** | Ubuntu 24.04 |
| **Type** | **CX22** (2 vCPU, 4GB RAM, 40GB SSD) — R$ ~30/mês |
| **SSH Key** | Adicionar sua chave (veja 1.2) |
| **Name** | `colli-finance-os` |

### 1.2 — Criar chave SSH (se não tiver)

No seu computador:

```bash
# Gerar chave SSH
ssh-keygen -t ed25519 -C "colli-finance-deploy" -f ~/.ssh/colli_hetzner

# Copiar a chave pública
cat ~/.ssh/colli_hetzner.pub
```

Cole o conteúdo no campo **SSH Key** do Hetzner.

### 1.3 — Anotar o IP

Após criar, o Hetzner mostra o IP do servidor.
Exemplo: `49.12.XXX.XXX` — **guarde esse IP**.

---

## PARTE 2 — Configurar o Servidor

### 2.1 — Conectar via SSH

```bash
ssh -i ~/.ssh/colli_hetzner root@SEU_IP_AQUI
```

### 2.2 — Atualizar sistema e instalar Docker

```bash
# Atualizar pacotes
apt update && apt upgrade -y

# Instalar dependências
apt install -y curl git ufw fail2ban

# Instalar Docker (script oficial)
curl -fsSL https://get.docker.com | sh

# Instalar Docker Compose
apt install -y docker-compose-plugin

# Verificar instalação
docker --version
docker compose version
```

### 2.3 — Criar usuário de deploy (não usar root)

```bash
# Criar usuário
useradd -m -s /bin/bash deploy
usermod -aG docker deploy
usermod -aG sudo deploy

# Configurar SSH para o usuário deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

### 2.4 — Configurar Firewall

```bash
# Ativar UFW
ufw default deny incoming
ufw default allow outgoing

# Liberar portas necessárias
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS

# Ativar
ufw enable
ufw status
```

### 2.5 — Configurar fail2ban (proteção contra força bruta)

```bash
systemctl enable fail2ban
systemctl start fail2ban
```

---

## PARTE 3 — Fazer o Primeiro Deploy Manual

### 3.1 — Clonar o repositório no servidor

```bash
# Mudar para usuário deploy
su - deploy

# Clonar repositório
mkdir -p /opt
cd /opt
git clone https://github.com/Willdenner/colli-finance-os.git
cd colli-finance-os
```

> **Repo privado?** Gere um Deploy Key:
> ```bash
> ssh-keygen -t ed25519 -C "hetzner-deploy" -f ~/.ssh/deploy_key
> cat ~/.ssh/deploy_key.pub
> # Cole no GitHub: Settings → Deploy Keys → Add deploy key
> ```

### 3.2 — Criar o arquivo .env

```bash
cp .env.example .env
nano .env
```

Preencha TODAS as variáveis. As críticas:
- `ANTHROPIC_API_KEY`
- `REDIS_PASSWORD` (invente uma senha forte)
- `POSTGRES_PASSWORD` (invente uma senha forte)
- `CONTA_AZUL_CLIENT_ID` e `CONTA_AZUL_CLIENT_SECRET`
- `EVOLUTION_API_KEY`

### 3.3 — Subir o sistema

```bash
# Build e subir todos os containers
docker compose up -d --build

# Verificar se estão rodando
docker compose ps

# Ver logs em tempo real
docker compose logs -f
```

### 3.4 — Verificar saúde dos serviços

```bash
# Saúde individual
docker compose logs fpsa-agent --tail=20
docker compose logs bot-extrator --tail=20
docker compose logs bot-cobranca --tail=20

# Testar endpoint de health
curl http://localhost/health
```

---

## PARTE 4 — Configurar Deploy Automático (GitHub Actions)

### 4.1 — Criar chave SSH exclusiva para o GitHub Actions

No seu computador local:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_actions_deploy
```

### 4.2 — Adicionar chave pública no servidor

```bash
# No servidor (conectado como deploy)
echo "CONTEUDO_DA_CHAVE_PUBLICA" >> ~/.ssh/authorized_keys
# Cole o conteúdo de: cat ~/.ssh/github_actions_deploy.pub
```

### 4.3 — Adicionar Secrets no GitHub

No repositório GitHub:
`Settings → Secrets and variables → Actions → New repository secret`

| Secret | Valor |
|--------|-------|
| `HETZNER_HOST` | IP do servidor (ex: 49.12.XXX.XXX) |
| `HETZNER_USER` | `deploy` |
| `HETZNER_SSH_KEY` | Conteúdo da chave PRIVADA: `cat ~/.ssh/github_actions_deploy` |

### 4.4 — Testar o pipeline

```bash
# No seu computador, faça qualquer alteração e push
git add .
git commit -m "test: validando deploy automático"
git push origin main
```

Acesse **GitHub → Actions** e acompanhe o deploy em tempo real.

---

## PARTE 5 — Operação Diária

### Comandos úteis no servidor

```bash
# Ver status de todos os containers
docker compose ps

# Logs de um serviço específico
docker compose logs -f fpsa-agent
docker compose logs -f bot-cobranca

# Reiniciar um serviço sem derrubar os outros
docker compose restart fpsa-agent

# Atualizar manualmente (sem GitHub Actions)
git pull && docker compose up -d --build

# Ver uso de recursos
docker stats

# Entrar dentro de um container para debug
docker compose exec fpsa-agent bash
```

### Monitorar logs de erro

```bash
# Erros nas últimas 2 horas
docker compose logs --since 2h | grep ERROR

# Acompanhar logs de todos os serviços
docker compose logs -f --tail=50
```

---

## PARTE 6 — Backups Automáticos (Opcional mas Recomendado)

### 6.1 — Script de backup do banco de dados

```bash
# Criar script
cat > /opt/backup_db.sh << 'EOF'
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M)
BACKUP_DIR=/opt/backups
mkdir -p $BACKUP_DIR

# Backup Postgres
docker compose -f /opt/colli-finance-os/docker-compose.yml \
  exec -T postgres pg_dump -U colli_admin colli_finance \
  > $BACKUP_DIR/db_$DATE.sql

# Manter apenas últimos 7 dias
find $BACKUP_DIR -name "db_*.sql" -mtime +7 -delete

echo "Backup realizado: $BACKUP_DIR/db_$DATE.sql"
EOF

chmod +x /opt/backup_db.sh

# Agendar backup diário às 3h
crontab -e
# Adicionar linha:
# 0 3 * * * /opt/backup_db.sh >> /var/log/backup.log 2>&1
```

### 6.2 — Habilitar Snapshots no Hetzner

No painel Hetzner: `Server → Backups → Enable`
Custo: +20% do valor do servidor (~R$ 6/mês). Vale muito.

---

## Resumo do Fluxo

```
Você faz git push na main
        ↓
GitHub Actions roda os testes
        ↓
Se passar → SSH no servidor Hetzner
        ↓
git pull + docker compose build
        ↓
Sistema atualizado em ~2 minutos
        ↓
Notificação no terminal do Actions
```

---

## Suporte e Troubleshooting

| Problema | Solução |
|----------|---------|
| Container não sobe | `docker compose logs NOME_SERVICO` |
| Erro de variável de ambiente | Revisar `.env`, verificar se o nome bate com o código |
| Deploy falha no GitHub Actions | Ver aba Actions → clicar no job → ver step que falhou |
| Servidor sem espaço | `docker system prune -a` |
| Redis não conecta | Verificar `REDIS_PASSWORD` no `.env` |

---

*Colli Finance OS — Infraestrutura de Tesouraria Autônoma*
*Holding V4 Colli&Co*
