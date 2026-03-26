"""
Scheduler: sets up APScheduler cron jobs for each account based on its
configured frequency (daily / weekly / monthly).
"""
import logging

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

logger = logging.getLogger(__name__)

DAY_MAP = {
    "monday":    "mon",
    "tuesday":   "tue",
    "wednesday": "wed",
    "thursday":  "thu",
    "friday":    "fri",
    "saturday":  "sat",
    "sunday":    "sun",
}


def _make_trigger(schedule: dict) -> CronTrigger:
    frequency = schedule.get("frequency", "monthly").lower()
    hour      = schedule.get("hour_utc", 8)
    minute    = schedule.get("minute_utc", 0)

    if frequency == "daily":
        return CronTrigger(hour=hour, minute=minute, timezone="UTC")

    if frequency == "weekly":
        raw_day = schedule.get("day_of_week", "monday").lower()
        day_of_week = DAY_MAP.get(raw_day, raw_day)
        return CronTrigger(day_of_week=day_of_week, hour=hour, minute=minute, timezone="UTC")

    # monthly
    dom = schedule.get("day_of_month", 1)
    return CronTrigger(day=dom, hour=hour, minute=minute, timezone="UTC")


def build_scheduler(accounts: list, run_fn) -> BlockingScheduler:
    """
    Create a BlockingScheduler with one cron job per account.

    Args:
        accounts: List of resolved account dicts from config_loader.
        run_fn:   Callable that accepts a single account dict and generates
                  + sends the report. Signature: run_fn(account: dict) -> None

    Returns:
        Configured (not yet started) BlockingScheduler.
    """
    scheduler = BlockingScheduler(timezone="UTC")

    for account in accounts:
        schedule = account.get("schedule", {})
        trigger  = _make_trigger(schedule)
        acct_id  = account["id"]

        # Bind the account dict into the closure
        def make_job(acct=account):
            def job():
                logger.info("Scheduled trigger fired for account: %s", acct["id"])
                try:
                    run_fn(acct)
                except Exception:
                    logger.exception("Report failed for account: %s", acct["id"])
            return job

        scheduler.add_job(
            make_job(),
            trigger=trigger,
            id=acct_id,
            name=f"DNS report — {account.get('display_name', acct_id)}",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=3600,  # 1 hour grace if scheduler was down
        )
        logger.info(
            "Scheduled '%s' (%s) — trigger: %s",
            account.get("display_name", acct_id),
            schedule.get("frequency", "?"),
            trigger,
        )

    return scheduler
