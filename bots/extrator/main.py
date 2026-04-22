import asyncio
import argparse
import logging
import os
import shlex
import sys
from pathlib import Path

from playwright.async_api import async_playwright
from scraper.auth import login
from scraper.deals_list import extract_deals_urls
from scraper.deal_detail import extract_deal_detail
from export.google_sheets import export_to_sheets
from config.settings import LOGIN_EMAIL, SPREADSHEET_ID

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("agente-finance")

DEFAULT_CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--no-zygote",
]


def build_chromium_launch_options(headless: bool) -> dict:
    """Build Playwright launch options for Render/container environments."""
    options = {
        "headless": headless,
        "args": DEFAULT_CHROMIUM_ARGS + shlex.split(os.getenv("PLAYWRIGHT_CHROMIUM_ARGS", "")),
    }
    executable_path = (
        os.getenv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
        or os.getenv("CHROMIUM_EXECUTABLE_PATH")
        or ""
    ).strip()
    if executable_path:
        options["executable_path"] = executable_path
    return options


async def run(headless: bool = True, skip_export: bool = False):
    """Fluxo principal do bot."""

    # Validar configuração
    if not LOGIN_EMAIL:
        logger.error("LOGIN_EMAIL não configurado. Copie .env.example para .env e preencha.")
        sys.exit(1)

    if not skip_export and not SPREADSHEET_ID:
        logger.error("SPREADSHEET_ID não configurado no .env")
        sys.exit(1)

    async with async_playwright() as p:
        browser = await p.chromium.launch(**build_chromium_launch_options(headless))
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            locale="pt-BR",
        )

        # Conceder permissão de clipboard para extrair links de pagamento
        await context.grant_permissions(["clipboard-read", "clipboard-write"])

        page = await context.new_page()

        try:
            # 1. Login
            logger.info("=" * 50)
            logger.info("ETAPA 1: Login")
            logger.info("=" * 50)
            success = await login(page)
            if not success:
                logger.error("Falha no login. Verifique suas credenciais no .env")
                return

            # 2. Extrair lista de deals
            logger.info("=" * 50)
            logger.info("ETAPA 2: Extraindo lista de deals")
            logger.info("=" * 50)
            deal_urls = await extract_deals_urls(page)

            if not deal_urls:
                logger.warning("Nenhum deal encontrado!")
                return

            # Limitar a 2 deals para teste
            deal_urls = deal_urls[:2]

            # LIMITAR A 2 DEALS PARA TESTE
            deal_urls = deal_urls[:2]

            # 3. Extrair detalhes de cada deal
            logger.info("=" * 50)
            logger.info(f"ETAPA 3: Extraindo detalhes de {len(deal_urls)} deals")
            logger.info("=" * 50)
            deals = []
            for i, url in enumerate(deal_urls, 1):
                logger.info(f"[{i}/{len(deal_urls)}] Processando deal...")
                deal = await extract_deal_detail(page, url)
                
                # Regra: Pular cliente se já está Pago
                status_list = [inst.status_pagamento.lower() for inst in deal.parcelas]
                is_all_paid = len(status_list) > 0 and all("pago" in s for s in status_list)
                if "pago" in deal.status.lower() or is_all_paid:
                    logger.info(f"Cliente {deal.cliente.nome} tem status de pagamento PAGO. Pulando e indo para o próximo...")
                    continue
                
                deals.append(deal)
                # Delay entre requests para não sobrecarregar
                await page.wait_for_timeout(1000)

            # 4. Exportar para Google Sheets
            if not skip_export:
                logger.info("=" * 50)
                logger.info("ETAPA 4: Exportando para Google Sheets")
                logger.info("=" * 50)
                sheet_url = export_to_sheets(deals)
                logger.info(f"Planilha atualizada: {sheet_url}")
            else:
                logger.info("Exportação ignorada (--skip-export)")
                for deal in deals:
                    logger.info(
                        f"  - {deal.cliente.nome} | {deal.valor_total} | "
                        f"{len(deal.parcelas)} parcelas"
                    )

            logger.info("=" * 50)
            logger.info(f"Concluído! {len(deals)} deals processados.")
            logger.info("=" * 50)

        except Exception as e:
            logger.error(f"Erro durante execução: {e}", exc_info=True)
            # Salvar screenshot para debug
            Path("screenshots").mkdir(parents=True, exist_ok=True)
            await page.screenshot(path="screenshots/error.png")
            logger.info("Screenshot de erro salvo em screenshots/error.png")
        finally:
            await browser.close()


def main():
    parser = argparse.ArgumentParser(description="Bot extrator de deals - Finance MKTLab")
    parser.add_argument(
        "--visible",
        action="store_true",
        help="Executar com browser visível (modo debug)",
    )
    parser.add_argument(
        "--skip-export",
        action="store_true",
        help="Pular exportação para Google Sheets (apenas exibir dados)",
    )
    args = parser.parse_args()

    asyncio.run(run(headless=not args.visible, skip_export=args.skip_export))


if __name__ == "__main__":
    main()
