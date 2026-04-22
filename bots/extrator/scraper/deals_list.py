import logging
from playwright.async_api import Page
from config.settings import BASE_URL, DEALS_PATH

logger = logging.getLogger(__name__)


async def extract_deals_urls(page: Page) -> list[str]:
    """Extrai as URLs de todos os deals da lista."""
    deals_url = f"{BASE_URL}{DEALS_PATH}"
    logger.info(f"Navegando para lista de deals: {deals_url}")
    await page.goto(deals_url, wait_until="networkidle")

    # Aguardar tabela carregar
    await page.wait_for_selector("table, [role='table'], [class*='table']", timeout=15000)
    await page.wait_for_timeout(2000)  # Aguardar dados carregarem

    all_urls: list[str] = []

    while True:
        # Extrair links dos deals na página atual
        urls = await _extract_urls_from_current_page(page)
        all_urls.extend(urls)
        logger.info(f"Encontrados {len(urls)} deals na página atual (total: {len(all_urls)})")

        # Verificar se há próxima página
        next_btn = page.locator(
            'button:has-text("Próxim"), '
            'button:has-text("Next"), '
            'button[aria-label="Next page"], '
            '[class*="pagination"] button:last-child:not([disabled])'
        )

        if await next_btn.count() > 0 and await next_btn.first.is_enabled():
            await next_btn.first.click()
            await page.wait_for_timeout(2000)
        else:
            break

    logger.info(f"Total de deals encontrados: {len(all_urls)}")
    return all_urls


async def _extract_urls_from_current_page(page: Page) -> list[str]:
    """Extrai URLs dos deals visíveis na página atual."""
    # Tentar extrair links das linhas da tabela
    rows = page.locator("table tbody tr, [role='table'] [role='row']")
    count = await rows.count()
    urls = []

    for i in range(count):
        row = rows.nth(i)

        # Tentar encontrar link na linha
        link = row.locator("a[href*='deal'], a[href*='Deal']")
        if await link.count() > 0:
            href = await link.first.get_attribute("href")
            if href:
                full_url = href if href.startswith("http") else f"{BASE_URL}{href}"
                urls.append(full_url)
        else:
            # Se não há link direto, tentar clicar na linha e capturar a URL
            # Algumas tabelas usam navegação via JS no click da linha
            pass

    # Fallback: se não encontrou links, tenta pegar todos os <a> com href de deal
    if not urls:
        all_links = page.locator("a[href*='/deals/'], a[href*='/deal/']")
        link_count = await all_links.count()
        for i in range(link_count):
            href = await all_links.nth(i).get_attribute("href")
            if href:
                full_url = href if href.startswith("http") else f"{BASE_URL}{href}"
                if full_url not in urls:
                    urls.append(full_url)

    return urls
