"""Deploy the detection service on Modal: image, GPU function, and the poll binding.

**This file has never been run.** There is no Modal account, CLI or SDK in the
environment this was written in, `modal` is not installed and cannot be, and
nothing in `service/tests/` imports this module. It is real, reviewable
deployment code and it is unverified deployment code, and the difference matters:
treat the first `modal deploy` as the first execution, not as a re-run.

That constraint is also why the file is shaped the way it is. Everything
interesting about spawn-and-poll — the pending state, the budget, the typed
timeout — lives in `service/app.py` behind the `JobRunner` protocol, and is
tested there against `InProcessJobRunner`. What remains here is a thin adapter
over `Function.spawn` and `FunctionCall.get(timeout=0)` plus an image
definition. If this file grows logic, that logic has become untestable; push it
back across the protocol.

**Why Modal, and why asynchronous** (KTD6). Per-second billing with scale-to-zero
puts a handful of contributors near zero cost, which an always-on GPU endpoint
does not. The call is asynchronous because Modal caps a web request at 150 s and
past that issues a redirect its own documentation says does not work with CORS —
and a cold GPU container pays boot, torch import, CUDA init and checkpoint load
before inference starts. A synchronous call would surface a cold start as a
failed fetch rather than as the typed timeout R12 requires.

**Why the checkpoint is baked into the image** rather than downloaded per
request: a multi-gigabyte SAM 2 checkpoint pulled at request time would add tens
of seconds to *every* cold start, on the billed side of the clock, and would make
the service's availability depend on Hugging Face's. Baking it makes the
container's start cost its own boot and nothing else.

**Why the image is derived from `service/pyproject.toml`** rather than listed
here: U0's whole argument is that the local and deployed environments cannot
drift, and two dependency lists drift the moment someone edits one of them.

**Auth is not here** (KTD11). Production sits behind an authenticating identity
proxy which owns access control; the service carries none and forwards no
identity into the decision store, whose schema deliberately has no column for
one. `allow_local_cors` stays off in this deployment for the same reason — the
proxy owns CORS. The endpoint URL is not a secret in either posture.

Deploy with:

    modal deploy service/modal_deploy.py

Version note: this targets the Modal SDK's post-1.0 naming — `min_containers`,
`max_containers` and `scaledown_window`, which were `keep_warm`,
`concurrency_limit` and `container_idle_timeout` on older releases. On an older
SDK these keyword names raise at deploy time rather than silently doing nothing.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import modal

from service.app import (
    DEFAULT_BUDGET_SECONDS,
    DEFAULT_PIPELINE,
    Detection,
    DetectionRequest,
    JobStatus,
    create_app,
    run_detection,
)
from service.results import Invalid, Result, Upstream
from service.segment import SAM2_MODEL_ID
from service.store import engine_for_url

APP_NAME = "golf-hole-detection"

#: The repository root as seen from this file, so the image can read the same
#: `pyproject.toml` a contributor installs from.
REPO_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = REPO_ROOT / "service" / "pyproject.toml"

#: Where the baked model checkpoint lives inside the image. An explicit path
#: rather than the default cache under `$HOME`, because Modal functions do not
#: necessarily run as the user the build step ran as, and a checkpoint baked into
#: one home directory and looked for in another is a silent re-download.
HF_HOME = "/opt/huggingface"

#: A10G rather than anything larger. SAM 2 automatic mask generation over a
#: corridor of a few megapixels is not a memory-bound workload, and the larger
#: cards cost multiples per second for a step that is not the bottleneck.
GPU_KIND = "A10G"

#: How long a detection may run inside the container. Deliberately above the
#: endpoint's 60 s budget — a job that finishes at 70 s is still worth recording,
#: since a contributor who polls again gets it — and well below Modal's 150 s web
#: ceiling, so nothing runs on unbilled hope after every client has given up.
DETECTION_TIMEOUT_SECONDS = 120

#: How long an idle container survives. Two minutes covers a contributor moving
#: to the next hole, which is the common case and the one where a cold start
#: hurts most; past that the per-second billing argues for letting it go.
SCALEDOWN_WINDOW_SECONDS = 120

#: A ceiling on concurrent GPU containers. Not a performance tuning knob — a cost
#: fuse. KTD11 puts access control at the proxy, but an authenticated contributor
#: (or a client retry loop) can still submit faster than jobs complete.
MAX_CONTAINERS = 4

#: Modal secret carrying `DATABASE_URL` for U9's store. Read inside the container
#: at request time, never at import: no module in this service reads
#: configuration at import time, and a deployment missing the secret should
#: answer a typed failure rather than fail to import.
DATABASE_SECRET = "golf-detection-database"


def _bake_checkpoint() -> None:
    """Download the SAM 2 checkpoint into the image at build time.

    Runs once, during `modal deploy`, so the weights are a layer of the image
    rather than a per-cold-start download. `snapshot_download` rather than
    constructing `SamGeo2`: instantiating the model here would also initialise
    CUDA, and the build step has no GPU.
    """
    from huggingface_hub import snapshot_download

    snapshot_download(SAM2_MODEL_ID)


image = (
    modal.Image.debian_slim(python_version="3.11")
    # GDAL's runtime is not needed — rasterio's wheels bundle their own — but
    # libpq is, for psycopg's binary build to link against on this base.
    .apt_install("libpq5")
    # One dependency list, U0's, with the extra that carries torch and
    # segment-geospatial. The devcontainer installs the same file without the
    # extra, which is the only difference between the two environments.
    .pip_install_from_pyproject(str(PYPROJECT), optional_dependencies=["segmentation"])
    .env({"HF_HOME": HF_HOME, "HUGGINGFACE_HUB_CACHE": f"{HF_HOME}/hub"})
    .run_function(_bake_checkpoint)
    # The service package itself, added last so a code change does not invalidate
    # the multi-gigabyte layers above it.
    .add_local_python_source("service")
)

app = modal.App(APP_NAME, image=image)


@app.function(
    gpu=GPU_KIND,
    timeout=DETECTION_TIMEOUT_SECONDS,
    scaledown_window=SCALEDOWN_WINDOW_SECONDS,
    max_containers=MAX_CONTAINERS,
    # Scale to zero is the default and is stated rather than assumed: it is the
    # entire cost argument for choosing Modal, and a later edit adding
    # `min_containers` should have to delete this line to do it.
    min_containers=0,
)
def detect_remote(request: DetectionRequest) -> Result[Detection]:
    """One detection, on a GPU container. The only GPU-bound step in the service.

    Returns a `Result`, never raises for an expected condition — the whole
    pipeline speaks `service.results`, and a remote function that raised would
    turn a corridor outside NAIP's footprint into a Modal exception the poll path
    would have to reverse-engineer. `Detection` holds only plain dicts, so the
    value crossing back out of this container carries no numpy array, no rasterio
    dataset and no CRS object.
    """
    return run_detection(request, DEFAULT_PIPELINE)


class ModalJobRunner:
    """`JobRunner` over Modal's own spawn and poll. The adapter, and nothing else.

    **The job id carries its own submit time**, as `"{call_id}.{epoch}"`. Modal's
    `FunctionCall` knows whether a call is finished but not when it started, and
    the web container that answers a poll is frequently not the one that answered
    the submit — under scale-to-zero it may not even have existed then. Any
    server-side map of job to start time would therefore be wrong exactly when it
    mattered. Putting the timestamp in the reference makes the elapsed
    computation stateless, which is what lets the budget rule hold across
    containers.

    The client is expected to treat the reference as opaque; nothing here trusts
    the embedded timestamp for anything but reporting elapsed time, so a client
    editing it can only mislead itself about how long its own job took.
    """

    def __init__(self, function: Any = detect_remote) -> None:
        self._function = function

    def submit(self, request: DetectionRequest) -> str:
        call = self._function.spawn(request)
        return f"{call.object_id}.{time.time():.0f}"

    def poll(self, job_id: str, budget_seconds: float) -> JobStatus:
        call_id, _, stamp = job_id.rpartition(".")
        try:
            elapsed = max(time.time() - float(stamp), 0.0)
        except ValueError:
            return JobStatus(
                job_id=job_id,
                elapsed_seconds=0.0,
                result=Invalid(
                    "That is not a detection job reference.",
                    field_name="job_id",
                    detail={"job_id": job_id},
                ),
            )

        try:
            call = modal.FunctionCall.from_id(call_id)
        except Exception as error:  # noqa: BLE001 - an unusable id is one outcome
            return JobStatus(
                job_id=job_id,
                elapsed_seconds=elapsed,
                result=Invalid(
                    "No detection job with that reference.",
                    field_name="job_id",
                    detail={"job_id": job_id, "cause": str(error)},
                ),
            )

        try:
            # timeout=0 is a poll, not a wait: it raises rather than blocking, so
            # the web container never holds a request open against the 150 s cap
            # that made this asynchronous in the first place.
            result: Result[Detection] = call.get(timeout=0)
        except TimeoutError:
            # Still running. The endpoint owns the budget comparison — see
            # `_status_response` — so a pending status is all this returns.
            return JobStatus(job_id=job_id, elapsed_seconds=elapsed)
        except modal.exception.OutputExpiredError:
            return JobStatus(
                job_id=job_id,
                elapsed_seconds=elapsed,
                result=Invalid(
                    "That detection finished too long ago for its result to still be "
                    "available. Submit the line again, or map the hole by hand.",
                    field_name="job_id",
                    detail={"job_id": job_id},
                ),
            )
        except Exception as error:  # noqa: BLE001 - a remote crash is one outcome
            # `detect_remote` returns typed results for every expected condition,
            # so reaching here means the container itself failed — OOM, a killed
            # worker, a checkpoint that would not load.
            return JobStatus(
                job_id=job_id,
                elapsed_seconds=elapsed,
                result=Upstream(
                    "Detection failed inside the inference container.",
                    source="modal",
                    cause=f"{type(error).__name__}: {error}",
                ),
            )

        return JobStatus(job_id=job_id, elapsed_seconds=elapsed, result=result)


@app.function(
    # No GPU on the web container. It validates a line, spawns a call and reads
    # the decision store; the one expensive step happens in `detect_remote`, and
    # attaching a GPU here would bill for one every time a client polls.
    timeout=60,
    scaledown_window=SCALEDOWN_WINDOW_SECONDS,
    secrets=[modal.Secret.from_name(DATABASE_SECRET)],
)
@modal.asgi_app()
def fastapi_app():
    """The HTTP surface, wired to Modal's spawn-and-poll and the decision store.

    Everything configurable is passed in here rather than read at import: the
    engine is built from `DATABASE_URL` inside the container, at the moment the
    web app is constructed, so importing this module for a deploy neither needs
    the secret nor touches a database.

    `allow_local_cors` stays off. The identity proxy in front of production owns
    both access control and CORS (KTD11); a wildcard origin here would be a
    posture, and a wrong one.
    """
    database_url = os.environ.get("DATABASE_URL")
    session_factory = None
    if database_url:
        # `pool_pre_ping` is on by default in `engine_for_url`, which matters
        # more here than anywhere: under scale-to-zero a pooled connection idle
        # across a container's whole lifetime is the normal case, and without it
        # the first write after a scale-up fails on a stale socket.
        engine = engine_for_url(database_url)
        from sqlalchemy.orm import Session

        session_factory = lambda: Session(engine)  # noqa: E731

    return create_app(
        runner=ModalJobRunner(),
        session_factory=session_factory,
        budget_seconds=DEFAULT_BUDGET_SECONDS,
        allow_local_cors=False,
    )
