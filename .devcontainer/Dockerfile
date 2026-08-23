# The detection service pins Python 3.11 deliberately.
#
# The geospatial and ML stack this service depends on — torch, segment-geospatial,
# rasterio — publishes wheels well behind the newest interpreter. Building on the
# host's Python (3.14 at time of writing) means compiling GDAL and torch from
# source, or finding no wheel at all. 3.11 is the newest interpreter the whole
# stack ships binaries for, so the image resolves in minutes rather than hours.
FROM mcr.microsoft.com/devcontainers/python:1-3.11-bookworm

# Node is here because this is one repository, not two. The client (Vite/React)
# and the service (FastAPI) are developed together, and a contributor who opens
# the devcontainer should be able to run `npm run test` and `pytest service/`
# without leaving it.
ARG NODE_VERSION=22
RUN su vscode -c ". /usr/local/share/nvm/nvm.sh \
    && nvm install ${NODE_VERSION} \
    && nvm alias default ${NODE_VERSION}"

# libpq backs psycopg for the decision store (U9). The GDAL runtime is not
# required by rasterio — its wheels bundle their own — but having `gdalinfo`
# available makes a misbehaving corridor read inspectable by hand.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpq-dev \
        gdal-bin \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Torch resolves to the CPU build inside the devcontainer. Inference in production
# runs on Modal's GPU image, which derives from the same `service/pyproject.toml`
# but overrides this index — pinning CPU here keeps the local image small enough
# to rebuild casually, without letting the dependency set drift between the two.
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cpu

# Dependencies install in postCreateCommand rather than here, so the image layer
# stays cacheable across dependency edits and a contributor editing
# `service/pyproject.toml` does not trigger a full image rebuild.
