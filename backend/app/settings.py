from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()

@dataclass(frozen=True)
class Settings:
    app_env: str
    supabase_url: str
    supabase_publishable_key: str
    supabase_secret_key: str
    bootstrap_owner_email: str
    frontend_url: str
    cors_origins: tuple[str, ...]

    @classmethod
    def from_env(cls) -> "Settings":
        raw_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173")
        return cls(
            app_env=os.getenv("APP_ENV", "development"),
            supabase_url=os.getenv("SUPABASE_URL", "").rstrip("/"),
            supabase_publishable_key=os.getenv("SUPABASE_PUBLISHABLE_KEY", ""),
            supabase_secret_key=os.getenv("SUPABASE_SECRET_KEY", ""),
            bootstrap_owner_email=os.getenv("BOOTSTRAP_OWNER_EMAIL", "").strip().lower(),
            frontend_url=os.getenv("FRONTEND_URL", "").rstrip("/"),
            cors_origins=tuple(origin.strip() for origin in raw_origins.split(",") if origin.strip()),
        )

    @property
    def supabase_configured(self) -> bool:
        return all((self.supabase_url, self.supabase_publishable_key, self.supabase_secret_key))
