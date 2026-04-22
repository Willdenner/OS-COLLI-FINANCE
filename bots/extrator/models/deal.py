from pydantic import BaseModel


class Client(BaseModel):
    nome: str = ""
    email: str = ""
    telefone: str = ""
    cnpj: str = ""


class Installment(BaseModel):
    numero: str = ""
    vencimento: str = ""
    status_pagamento: str = ""
    valor: str = ""
    link_pagamento: str = ""


class Responsible(BaseModel):
    nome: str = ""
    email: str = ""
    telefone: str = ""


class Deal(BaseModel):
    # Da lista
    nome_deal: str = ""
    empresa: str = ""
    tipo: str = ""
    data_criacao: str = ""
    valor_total: str = ""
    metodo_pagamento: str = ""
    status: str = ""
    url: str = ""

    # Do detalhe
    cliente: Client = Client()
    servicos: list[str] = []
    desconto: str = ""
    parcelas: list[Installment] = []
    responsaveis: list[Responsible] = []
