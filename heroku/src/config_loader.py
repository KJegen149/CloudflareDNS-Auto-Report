"""
Config loader: reads accounts.json and resolves all *_env references to real
environment variable values. Keeps secrets out of the config file.
"""
import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class ConfigError(Exception):
    pass


def _resolve_env(value: Any, key: str) -> str:
    """Look up an environment variable by name; raise ConfigError if missing."""
    env_var = os.environ.get(value)
    if not env_var:
        raise ConfigError(
            f"Environment variable '{value}' (referenced by '{key}') is not set."
        )
    return env_var


def _resolve_smtp_profile(profile: dict, profile_name: str) -> dict:
    """Return a resolved SMTP profile with actual credential values."""
    resolved = {
        "host": _resolve_env(profile["host_env"], f"smtp_profiles.{profile_name}.host_env"),
        "port": int(_resolve_env(profile["port_env"], f"smtp_profiles.{profile_name}.port_env")),
        "username": _resolve_env(profile["username_env"], f"smtp_profiles.{profile_name}.username_env"),
        "password": _resolve_env(profile["password_env"], f"smtp_profiles.{profile_name}.password_env"),
        "from_email": _resolve_env(profile["from_email_env"], f"smtp_profiles.{profile_name}.from_email_env"),
        "from_name": profile.get("from_name", "Cloudflare DNS Reports"),
        "use_tls": profile.get("use_tls", True),
        "use_starttls": profile.get("use_starttls", False),
    }
    return resolved


def load_config(config_path: str | None = None) -> dict:
    """
    Load and validate the accounts config file.

    Resolves all *_env fields to actual environment variable values so the
    rest of the application never needs to touch os.environ directly.

    Args:
        config_path: Path to accounts.json. Falls back to ACCOUNTS_CONFIG_PATH
                     env var, then 'config/accounts.json' relative to cwd.

    Returns:
        Dict with structure:
        {
            "accounts": [...],     # fully resolved account configs
            "smtp_profiles": {...} # fully resolved SMTP profile dicts
        }
    """
    if config_path is None:
        config_path = os.environ.get("ACCOUNTS_CONFIG_PATH", "config/accounts.json")

    path = Path(config_path)
    if not path.exists():
        raise ConfigError(
            f"Accounts config not found at '{config_path}'. "
            "Copy config/accounts.example.json to config/accounts.json and fill it in."
        )

    with path.open() as f:
        raw = json.load(f)

    # ── Resolve SMTP profiles ──────────────────────────────────────────────────
    smtp_profiles_raw = raw.get("smtp_profiles", {})
    smtp_profiles = {}
    for name, profile in smtp_profiles_raw.items():
        try:
            smtp_profiles[name] = _resolve_smtp_profile(profile, name)
        except ConfigError as e:
            raise ConfigError(f"SMTP profile '{name}': {e}") from e

    # ── Resolve per-account secrets ────────────────────────────────────────────
    accounts = []
    for raw_account in raw.get("accounts", []):
        account_id = raw_account.get("id", "unknown")

        token_env_name = raw_account.get("cloudflare_api_token_env")
        if not token_env_name:
            raise ConfigError(f"Account '{account_id}' missing 'cloudflare_api_token_env'.")

        api_token = _resolve_env(token_env_name, f"accounts[{account_id}].cloudflare_api_token_env")

        smtp_profile_name = raw_account.get("email", {}).get("smtp_profile", "default")
        if smtp_profile_name not in smtp_profiles:
            raise ConfigError(
                f"Account '{account_id}' references smtp_profile '{smtp_profile_name}' "
                "which is not defined in smtp_profiles."
            )

        account = {
            **raw_account,
            "cloudflare_api_token": api_token,
            "smtp": smtp_profiles[smtp_profile_name],
        }
        accounts.append(account)
        logger.debug("Loaded account config: %s (%s)", account_id, raw_account.get("display_name"))

    logger.info("Loaded %d account(s) from %s", len(accounts), config_path)
    return {"accounts": accounts, "smtp_profiles": smtp_profiles}


def get_accounts_for_frequency(config: dict, frequency: str) -> list:
    """Return all accounts whose schedule matches the given frequency."""
    return [
        a for a in config["accounts"]
        if a.get("schedule", {}).get("frequency", "").lower() == frequency.lower()
    ]
