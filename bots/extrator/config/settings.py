import os
from dotenv import load_dotenv

load_dotenv()

BASE_URL = os.getenv("BASE_URL", "https://finance.mktlab.app")
LOGIN_EMAIL = os.getenv("LOGIN_EMAIL", "")
LOGIN_PASSWORD = os.getenv("LOGIN_PASSWORD", "")

GOOGLE_CREDENTIALS_PATH = os.getenv("GOOGLE_CREDENTIALS_PATH", "credentials.json")
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID", "")

SIGNIN_URL = f"{BASE_URL}/signin"
DEALS_PATH = "/deals"
