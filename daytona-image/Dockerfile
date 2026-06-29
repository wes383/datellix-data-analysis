# Daytona sandbox image
#
# Pre-installs data analysis Python packages: DuckDB + Pandas + scikit-learn + matplotlib + plotly
# After building and pushing to a registry, set DAYTONA_IMAGE to point to it
#
# Local build example:
#   docker build -t datellix-data-analysis .
#   # Push to a registry accessible by Daytona (e.g., ghcr.io/your-org/datellix-data-analysis)

FROM python:3.11-slim

# Install system dependencies (required by matplotlib)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libfreetype6-dev \
    libpng-dev \
    libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*

# Install data analysis and ML packages
RUN pip install --no-cache-dir \
    duckdb \
    pandas \
    scikit-learn \
    matplotlib \
    plotly \
    statsmodels \
    seaborn \
    openpyxl \
    pyarrow

# Set working directory
WORKDIR /home/daytona/work
