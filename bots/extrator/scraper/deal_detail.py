import logging
from playwright.async_api import Page
from models.deal import Deal, Client, Installment, Responsible

logger = logging.getLogger(__name__)


async def extract_deal_detail(page: Page, deal_url: str) -> Deal:
    """Extrai todos os detalhes de um deal específico."""
    logger.info(f"Extraindo detalhes: {deal_url}")
    await page.goto(deal_url, wait_until="networkidle")
    await page.wait_for_timeout(2000)

    deal = Deal(url=deal_url)

    # Extrair Nome do Deal provisório (pode ser sobrescrito pelo nome do cliente depois)
    try:
        title_el = page.locator("h1, [class*='title']").first
        deal.nome_deal = (await title_el.text_content(timeout=1000) or "").strip()
    except Exception:
        pass

    # Extrair informações do cliente
    deal.cliente = await _extract_client_info(page)
    
    # Se o nome do deal estiver vazio ou for o genérico "Financeiro", usar o nome do cliente
    if not deal.nome_deal or deal.nome_deal.lower() == "financeiro" or "deal" in deal.nome_deal.lower():
        deal.nome_deal = deal.cliente.nome if deal.cliente.nome else f"Deal {deal_url.split('/')[-1]}"

    # Extrair detalhes do deal
    await _extract_deal_info(page, deal)

    # Extrair parcelas
    deal.parcelas = await _extract_installments(page)

    # Extrair responsáveis financeiros
    deal.responsaveis = await _extract_responsibles(page)

    logger.info(f"Deal extraído: {deal.cliente.nome} - {deal.valor_total}")
    return deal


async def _extract_client_info(page: Page) -> Client:
    """Extrai informações do cliente da página de detalhe."""
    client = Client()

    # Seção "Informações do cliente"
    section = page.locator("text=Informações do cliente").locator("..").locator("..")

    # Nome do cliente
    try:
        el = page.locator("span:has-text('Cliente') ~ span").first
        client.nome = (await el.text_content(timeout=1000) or "").strip()
    except Exception:
        pass

    # Email
    try:
        el = page.locator("span:has-text('E-mail') ~ span").first
        client.email = (await el.text_content(timeout=1000) or "").strip()
    except Exception:
        pass

    # Telefone
    try:
        el = page.locator("span:has-text('Telefone') ~ span").first
        client.telefone = (await el.text_content(timeout=1000) or "").strip()
    except Exception:
        pass

    # CNPJ
    try:
        el = page.locator("span:has-text('CNPJ') ~ span").first
        client.cnpj = (await el.text_content(timeout=1000) or "").strip()
    except Exception:
        pass

    return client


async def _extract_deal_info(page: Page, deal: Deal) -> None:
    """Extrai informações gerais do deal."""
    # Status
    try:
        status_el = page.locator("[class*='badge'], [class*='status'], [class*='chip']").first
        deal.status = (await status_el.text_content() or "").strip()
    except Exception:
        pass

    # Serviços
    try:
        servicos_section = page.locator("text=Serviços").locator("..")
        servico_items = servicos_section.locator("li, p, [class*='item'], [class*='service']")
        count = await servico_items.count()
        for i in range(count):
            text = (await servico_items.nth(i).text_content() or "").strip()
            if text and text != "Serviços":
                deal.servicos.append(text)
    except Exception:
        pass

    # Valor total
    try:
        total_el = page.locator("text=Total").locator("..").locator("[class*='value'], [class*='amount'], span, p").last
        deal.valor_total = (await total_el.text_content() or "").strip()
    except Exception:
        pass

    # Desconto
    try:
        desc_el = page.locator("text=Desconto").locator("..").locator("[class*='value'], span, p").last
        deal.desconto = (await desc_el.text_content() or "").strip()
    except Exception:
        pass

    # Método de pagamento
    try:
        method_el = page.locator("text=Método de pagamento").locator("..").locator("span, p, [class*='value']").last
        deal.metodo_pagamento = (await method_el.text_content() or "").strip()
    except Exception:
        pass


async def _extract_installments(page: Page) -> list[Installment]:
    """Extrai as parcelas e links de pagamento."""
    installments = []

    # Localizar a tabela/seção de parcelas
    parcelas_section = page.locator("text=Parcelas").locator("..").locator("..")

    # Tentar pegar linhas da tabela de parcelas
    rows = parcelas_section.locator("table tbody tr, [role='row']")
    # Fallback: pegar todas as tabelas e encontrar a de parcelas
    if await rows.count() == 0:
        rows = page.locator("table").filter(has=page.locator("text=Vencimento")).locator("tbody tr")

    count = await rows.count()
    logger.info(f"Encontradas {count} parcelas")

    for i in range(count):
        row = rows.nth(i)
        cells = row.locator("td")
        cell_count = await cells.count()

        installment = Installment()

        if cell_count >= 1:
            installment.numero = (await cells.nth(0).text_content() or "").strip()
        if cell_count >= 2:
            installment.vencimento = (await cells.nth(1).text_content() or "").strip()
        if cell_count >= 3:
            installment.status_pagamento = (await cells.nth(2).text_content() or "").strip()
        if cell_count >= 5:
            installment.valor = (await cells.nth(4).text_content() or "").strip()

        # Extrair link de pagamento
        # Pular extração de link se a parcela já consta como paga
        is_paid = installment.status_pagamento and "pago" in installment.status_pagamento.lower()
        
        if not is_paid:
            try:
                # Hover na linha para garantir que os botões de ação apareçam no DOM
                await row.hover(timeout=2000)
                await page.wait_for_timeout(300)
            except Exception:
                pass
                
            link_btn = row.locator("td").nth(5).locator("button").first
            if await link_btn.count() > 0:
                # Clicar para copiar e ler do clipboard, ou tentar pegar de atributo
                try:
                    # Limpar clipboard previamente
                    await page.evaluate("navigator.clipboard.writeText('')")
                    
                    # Tentar pegar de data-attribute ou title
                    link_value = await link_btn.first.get_attribute("data-link")
                    if not link_value:
                        link_value = await link_btn.first.get_attribute("data-clipboard-text")
                    if not link_value:
                        link_value = await link_btn.first.get_attribute("title")

                    # Se não conseguiu por atributo, clicar e ler do clipboard
                    if not link_value:
                        try:
                            await link_btn.first.click(timeout=1000, force=True)
                        except Exception:
                            pass
                        await page.wait_for_timeout(500)
                        try:
                            link_value = await page.evaluate("navigator.clipboard.readText()")
                        except Exception:
                            pass

                    if link_value and ("http" in link_value or "pay" in link_value.lower()):
                        installment.link_pagamento = link_value
                except Exception as e:
                    logger.debug(f"Não foi possível extrair link da parcela {i+1}: {e}")

        installments.append(installment)

    return installments


async def _extract_responsibles(page: Page) -> list[Responsible]:
    """Extrai os responsáveis financeiros."""
    responsibles = []

    try:
        section = page.locator("text=Responsáveis financeiros, text=Responsáveis Financeiros").locator("..")

        # Titular
        try:
            titular_section = section.locator("text=Titular").locator("..")
            resp = Responsible()
            resp.nome = "Titular"

            email_el = titular_section.locator("a[href^='mailto:'], [class*='email']")
            if await email_el.count() > 0:
                resp.email = (await email_el.first.text_content() or "").strip()

            tel_el = titular_section.locator("a[href^='tel:'], [class*='phone'], [class*='tel']")
            if await tel_el.count() > 0:
                resp.telefone = (await tel_el.first.text_content() or "").strip()

            if resp.email or resp.telefone:
                responsibles.append(resp)
        except Exception:
            pass

    except Exception:
        pass

    return responsibles
