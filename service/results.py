"""The typed outcomes every unit of the detection service returns.

The client half of this repo models every fallible call as a discriminated
result union and never throws — see `ApiResult<T>` in `src/api/types.ts` and the
way `src/api/opengolf.ts` folds network, HTTP and parse failures into it. The
service mirrors that discipline: a function that can fail for an *expected*
reason returns one of the variants here instead of raising, so the caller has to
look at `status` before it can reach a value. Raising is still correct for
genuine programmer error — a wrong argument type, a broken invariant — because
those are bugs, not outcomes.

Living in its own module rather than inside `naip.py` is deliberate. Corridor
fetch, segmentation, classification, vectorization, the HTTP endpoint and the
decision store all need to say "worked", "your input was bad", "there is nothing
here", "something upstream broke" or "we ran out of time", and five modules each
inventing their own vocabulary for that would leave the endpoint translating
between them. One vocabulary, imported everywhere.

Two variants deserve their rationale stated, because both are easy to collapse
into something else and both are load-bearing:

* `NoCoverage` is a *successful* request with a legitimately empty answer — no
  NAIP item over this bbox, or no masks in this corridor. Folded into a failure
  it would tell the contributor the service broke; folded into `Ok` with an
  empty payload it would be indistinguishable from a silent bug. It is answered
  with HTTP 200 and its own status string.
* `Timeout` is separate from `Upstream` because the endpoint answers it through
  a poll path rather than a transport error, and the client's recovery is
  different: retry later versus fall back to hand-mapping.

Every non-`Ok` variant carries an `http_status` so the endpoint's mapping is
mechanical rather than a chain of isinstance checks that must be kept in sync.

Dependency-light on purpose: standard library only, so importing this costs
nothing and no unit inherits a dependency it does not otherwise need.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar, Generic, Literal, TypeGuard, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class Ok(Generic[T]):
    """A successful outcome carrying its value.

    `status` is a field rather than a class attribute so that the union can be
    narrowed on it the same way the TypeScript client narrows on
    `result.status === 'ok'`.
    """

    value: T
    status: Literal["ok"] = "ok"


@dataclass(frozen=True)
class Invalid:
    """The caller's input was rejected before any work was done.

    `field` names the offending input when there is one (`"line"`, `"par"`), so
    the endpoint can point at it instead of returning an opaque message.
    `detail` carries machine-readable specifics — the observed value and the cap
    it exceeded — because a contributor who drew too long a line deserves to be
    told the actual limit rather than "invalid request".

    422 rather than 400: the body parsed fine, its contents failed validation,
    which is also what FastAPI's own request validation returns.
    """

    message: str
    field_name: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    status: Literal["invalid"] = "invalid"

    http_status: ClassVar[int] = 422


@dataclass(frozen=True)
class NoCoverage:
    """The request was well-formed and answerable, and the answer is nothing.

    Not an error. See the module docstring for why this cannot be folded into
    either `Ok` or a failure variant.
    """

    message: str
    detail: dict[str, Any] = field(default_factory=dict)
    status: Literal["no_coverage"] = "no_coverage"

    http_status: ClassVar[int] = 200


@dataclass(frozen=True)
class Upstream:
    """A dependency we do not control failed.

    `source` names it (`"planetary-computer"`, `"stac"`, `"cog"`) so an operator
    reading logs knows which third party to go look at. `cause` holds the
    stringified original exception: exceptions from rasterio, pystac-client and
    the signing endpoint are not part of any contract we can hand a client, so
    they are captured here rather than allowed to escape.

    502 because the service itself is healthy; something behind it is not.
    """

    message: str
    source: str
    cause: str | None = None
    status: Literal["upstream"] = "upstream"

    http_status: ClassVar[int] = 502


@dataclass(frozen=True)
class Timeout:
    """Work was still running when the budget ran out.

    Distinct from `Upstream` because nothing failed — the answer just did not
    arrive in time, and the client's response to that is to keep hand-mapping
    rather than to report a broken service.
    """

    message: str
    elapsed_seconds: float | None = None
    status: Literal["timeout"] = "timeout"

    http_status: ClassVar[int] = 504


#: Every non-success outcome. Named so functions that can only fail — validators,
#: mainly — can be typed without dragging a type parameter along.
Failure = Invalid | NoCoverage | Upstream | Timeout

#: The union every fallible service function returns. Parameterize it with the
#: success payload: `Result[CorridorRaster]`.
Result = Ok[T] | Invalid | NoCoverage | Upstream | Timeout


def is_ok(result: Result[T]) -> TypeGuard[Ok[T]]:
    """Narrow a result to its success branch.

    Exists so callers write `if not is_ok(r): return r` and hand the failure
    straight through — the Python equivalent of the client's early-return on
    `result.status !== 'ok'` — without repeating an isinstance check that a type
    checker would then have to be convinced about.
    """
    return isinstance(result, Ok)
