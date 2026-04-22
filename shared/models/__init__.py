"""
Modelos compartilhados — Colli Finance OS
Todos os serviços importam daqui. Schema único = sem divergência.
"""

from pydantic import BaseModel, Field
from typing import Optional, Literal
from datetime import date, datetime
from decimal import Decimal
from enum import Enum


# ── Enums ─────────────────────────────────────────────────────────────

class Vertical(str, Enum):
    TER      = "TER"
    SABER    = "SABER"
    EXECUTAR = "EXECUTAR"
    HOLDING  = "HOLDING"

class StatusContrato(str, Enum):
    ATIVO      = "ativo"
    SUSPENSO   = "suspenso"
    CANCELADO  = "cancelado"
    CONCLUIDO  = "concluido"

class StatusRecebimento(str, Enum):
    PENDENTE   = "pendente"
    VENCIDO    = "vencido"
    RECEBIDO   = "recebido"
    NEGOCIADO  = "negociado"

class StatusPagamento(str, Enum):
    PENDENTE   = "pendente"
    APROVADO   = "aprovado"        # Aprovação humana dada
    EXECUTADO  = "executado"
    CANCELADO  = "cancelado"

class Banco(str, Enum):
    ITAU    = "itau"
    SICREDI = "sicredi"
    KAMINO  = "kamino"
    CLARA   = "clara"
    CGG     = "cgg"


# ── Cliente ───────────────────────────────────────────────────────────

class Cliente(BaseModel):
    id: str
    nome: str
    cnpj_cpf: Optional[str] = None
    email: Optional[str] = None
    whatsapp: Optional[str] = None
    vertical: Vertical
    criado_em: datetime = Field(default_factory=datetime.now)
    atualizado_em: datetime = Field(default_factory=datetime.now)


# ── Contrato ─────────────────────────────────────────────────────────

class Contrato(BaseModel):
    id: str
    cliente_id: str
    vertical: Vertical
    valor_mensal: Decimal
    data_inicio: date
    data_fim: Optional[date] = None
    dia_vencimento: int = Field(ge=1, le=31)
    status: StatusContrato = StatusContrato.ATIVO
    pilar: Optional[str] = None          # Pilar V4 (CPC 47)
    reconhecimento: Literal[
        "ponto_no_tempo", "ao_longo_do_tempo"
    ] = "ao_longo_do_tempo"
    criado_em: datetime = Field(default_factory=datetime.now)


# ── Recebimento ──────────────────────────────────────────────────────

class Recebimento(BaseModel):
    id: str
    contrato_id: str
    cliente_id: str
    valor: Decimal
    vencimento: date
    recebido_em: Optional[date] = None
    valor_recebido: Optional[Decimal] = None
    status: StatusRecebimento = StatusRecebimento.PENDENTE
    dias_atraso: int = 0
    tentativas_cobranca: int = 0
    ultima_cobranca_em: Optional[datetime] = None
    conta_destino: Optional[Banco] = None
    obs: Optional[str] = None


# ── Pagamento ────────────────────────────────────────────────────────

class Pagamento(BaseModel):
    id: str
    descricao: str
    valor: Decimal
    vencimento: date
    conta_origem: Banco
    categoria: str                       # DRE: categoria do gasto
    vertical: Optional[Vertical] = None
    status: StatusPagamento = StatusPagamento.PENDENTE
    aprovado_por: Optional[str] = None   # Quem aprovou
    aprovado_em: Optional[datetime] = None
    executado_em: Optional[datetime] = None
    obs: Optional[str] = None


# ── Extrato Bancário ─────────────────────────────────────────────────

class LancamentoExtrato(BaseModel):
    id: str
    banco: Banco
    data: date
    descricao: str
    valor: Decimal                       # Negativo = débito
    saldo_apos: Optional[Decimal] = None
    conciliado: bool = False
    recebimento_id: Optional[str] = None
    pagamento_id: Optional[str] = None


class ExtratoImportado(BaseModel):
    banco: Banco
    periodo_inicio: date
    periodo_fim: date
    lancamentos: list[LancamentoExtrato]
    saldo_inicial: Decimal
    saldo_final: Decimal
    importado_em: datetime = Field(default_factory=datetime.now)


# ── Aging List ───────────────────────────────────────────────────────

class AgingItem(BaseModel):
    recebimento_id: str
    cliente_id: str
    cliente_nome: str
    whatsapp: Optional[str]
    valor: Decimal
    vencimento: date
    dias_atraso: int
    faixa: Literal["0-15", "16-30", "31-60", "60+"]
    tentativas: int
    ultima_tentativa: Optional[datetime]


# ── Alerta ───────────────────────────────────────────────────────────

class Alerta(BaseModel):
    nivel: Literal["info", "warning", "critical"]
    titulo: str
    mensagem: str
    dados: Optional[dict] = None
    gerado_em: datetime = Field(default_factory=datetime.now)
