import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        print("Logging in...")
        await page.goto("https://finance.mktlab.app/signin")
        await page.fill("input[name='email']", "will@v4company.com")
        await page.fill("input[name='password']", "750A776a3563@")
        await page.click("button[type='submit']")
        await page.wait_for_url("**/deals**", timeout=10000)
        
        print("Navigating to deal...")
        url = "https://finance.mktlab.app/deals/7ae7f9c6-5fe7-43d3-b002-849928eb1945"
        await page.goto(url, wait_until="networkidle")
        
        section = page.locator("text=Informações do cliente").locator("..").locator("..")
        html = await section.inner_html()
        print("Section HTML snippet:", html[:1000])
        
        # Test Locators
        print("--- Locators ---")
        try:
            el = page.locator("p", has_text="Cliente").locator("xpath=following-sibling::p").first
            print("Cliente (has_text):", await el.text_content(timeout=1000))
        except Exception as e:
            print("Cliente method 1 failed:", type(e).__name__)
            
        try:
            el = page.locator("p:has-text('Cliente') + p").first
            print("Cliente (+ p):", await el.text_content(timeout=1000))
        except Exception as e:
            print("Cliente method 2 failed:", type(e).__name__)

        try:
            el = page.locator("text=Cliente").locator("..").locator("p").nth(1)
            print("Cliente (.. nth 1):", await el.text_content(timeout=1000))
        except Exception as e:
            print("Cliente method 3 failed:", type(e).__name__)

        try:
            # Maybe the label isn't "Cliente" exactly? Or it has trailing spaces?
            # Let's just find "Prime Dente" and see its parent structure.
            pd = page.locator("text=Prime Dente").first
            print("Prime Dente HTML:", await pd.evaluate("el => el.outerHTML"))
            print("Prime Dente Parent HTML:", await pd.evaluate("el => el.parentElement.outerHTML"))
        except Exception as e:
            print("Finding Prime Dente failed:", type(e).__name__)

        await browser.close()

asyncio.run(main())
