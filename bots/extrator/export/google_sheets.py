import logging
import gspread
from google.oauth2.service_account import Credentials
from config.settings import GOOGLE_CREDENTIALS_PATH, SPREADSHEET_ID
from models.deal import Deal

logger = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

DEALS_HEADERS = [
    "Nome do Deal",
    "Cliente",
    "Email",
    "Telefone",
    "CNPJ",
    "Empresa",
    "Status",
    "Serviços",
    "Valor Total",
    "Desconto",
    "Método de Pagamento",
    "Data de Criação",
    "URL do Deal",
]

PARCELAS_HEADERS = [
    "Cliente",
    "Nome do Deal",
    "Parcela",
    "Vencimento",
    "Status Pagamento",
    "Valor",
    "Link de Pagamento",
]


def export_to_sheets(deals: list[Deal]) -> str:
    """Exporta os deals para Google Sheets. Retorna a URL da planilha."""
    logger.info(f"Exportando {len(deals)} deals para Google Sheets")

    creds = Credentials.from_service_account_file(GOOGLE_CREDENTIALS_PATH, scopes=SCOPES)
    gc = gspread.authorize(creds)

    spreadsheet = gc.open_by_key(SPREADSHEET_ID)

    _write_deals_sheet(spreadsheet, deals)
    _write_parcelas_sheet(spreadsheet, deals)

    url = f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}"
    logger.info(f"Exportação concluída: {url}")
    return url


def _get_or_create_worksheet(spreadsheet: gspread.Spreadsheet, title: str, headers: list[str]) -> gspread.Worksheet:
    """Obtém ou cria uma aba na planilha."""
    try:
        ws = spreadsheet.worksheet(title)
        ws.clear()
    except gspread.WorksheetNotFound:
        ws = spreadsheet.add_worksheet(title=title, rows=1000, cols=len(headers))

    ws.update(range_name="A1", values=[headers])

    # Formatar cabeçalho em negrito
    ws.format("A1:Z1", {
        "textFormat": {"bold": True},
        "backgroundColor": {"red": 0.2, "green": 0.2, "blue": 0.2},
        "horizontalAlignment": "CENTER",
    })

    return ws


def _write_deals_sheet(spreadsheet: gspread.Spreadsheet, deals: list[Deal]) -> None:
    """Escreve a aba de Deals."""
    ws = _get_or_create_worksheet(spreadsheet, "Deals", DEALS_HEADERS)

    rows = []
    for deal in deals:
        rows.append([
            deal.nome_deal,
            deal.cliente.nome,
            deal.cliente.email,
            deal.cliente.telefone,
            deal.cliente.cnpj,
            deal.empresa,
            deal.status,
            " | ".join(deal.servicos),
            deal.valor_total,
            deal.desconto,
            deal.metodo_pagamento,
            deal.data_criacao,
            deal.url,
        ])

    if rows:
        ws.update(range_name="A2", values=rows)
        logger.info(f"Aba 'Deals': {len(rows)} linhas escritas")


def _write_parcelas_sheet(spreadsheet: gspread.Spreadsheet, deals: list[Deal]) -> None:
    """Escreve a aba de Parcelas com links de pagamento."""
    ws = _get_or_create_worksheet(spreadsheet, "Parcelas", PARCELAS_HEADERS)

    rows = []
    for deal in deals:
        for parcela in deal.parcelas:
            rows.append([
                deal.cliente.nome,
                deal.nome_deal,
                parcela.numero,
                parcela.vencimento,
                parcela.status_pagamento,
                parcela.valor,
                parcela.link_pagamento,
            ])

    if rows:
        ws.update(range_name="A2", values=rows)
        logger.info(f"Aba 'Parcelas': {len(rows)} linhas escritas")
