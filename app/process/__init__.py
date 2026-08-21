"""Process-lifetime helpers (JobObject watchdog, spawn policy)."""

from .job_object import KillOnCloseJob, attach_kill_on_close

__all__ = ["KillOnCloseJob", "attach_kill_on_close"]
