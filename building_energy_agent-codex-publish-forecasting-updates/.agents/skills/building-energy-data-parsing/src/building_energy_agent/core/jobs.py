"""Generic read access to asynchronous jobs.

The status vocabulary and progress representation are deliberately owned by
the public contract models. In particular, this module does not freeze a
JobStatus enum; implementations must preserve the ``needs_input`` semantic.
"""

from typing import Protocol, TypeVar

StatusT_co = TypeVar("StatusT_co", covariant=True)
ResultT_co = TypeVar("ResultT_co", covariant=True)


class JobAccess(Protocol[StatusT_co, ResultT_co]):
    """Read status and result values for a previously started job."""

    def status(self, job_id: str) -> StatusT_co:
        """Return the current lightweight job status."""
        ...

    def result(self, job_id: str) -> ResultT_co:
        """Return the lightweight result of a completed job."""
        ...
