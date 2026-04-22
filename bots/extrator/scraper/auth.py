import logging
from playwright.async_api import Page
from config.settings import SIGNIN_URL, LOGIN_EMAIL, LOGIN_PASSWORD

logger = logging.getLogger(__name__)


async def login(page: Page) -> bool:
    """Faz login no sistema Finance MKTLab."""
    logger.info(f"Navegando para {SIGNIN_URL}")
    await page.goto(SIGNIN_URL, wait_until="networkidle")

    # Preencher email
    email_input = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]')
    await email_input.wait_for(state="visible", timeout=10000)
    await email_input.fill(LOGIN_EMAIL)

    # Preencher senha
    password_input = page.locator('input[type="password"], input[name="password"]')
    await password_input.fill(LOGIN_PASSWORD)

    # Clicar no botão de login
    submit_btn = page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Sign in")')
    await submit_btn.click()

    # Aguardar navegação pós-login
    try:
        await page.wait_for_url(
            lambda url: "/signin" not in url,
            timeout=15000,
        )
        logger.info("Login realizado com sucesso")
        return True
    except Exception as e:
        logger.error(f"Falha no login: {e}")
        return False
