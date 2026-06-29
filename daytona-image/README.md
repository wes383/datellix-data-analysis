# Daytona Sandbox Image

## Build the Image

```bash
cd daytona-image
docker build -t datellix-data-analysis .

# Push to a container registry accessible by Daytona
# Example: push to GHCR
docker tag datellix-data-analysis ghcr.io/<your-org>/datellix-data-analysis:latest
docker push ghcr.io/<your-org>/datellix-data-analysis:latest
```

> Alternatively, push the code to GitHub and the `build-daytona-image.yml`
> workflow will build and push the image automatically.

## Configure Environment Variables

Set the following in `.env.local`:

```bash
DAYTONA_API_KEY=your-api-key
DAYTONA_SERVER_URL=https://app.daytona.io  # or self-hosted URL
DAYTONA_IMAGE=ghcr.io/<your-org>/datellix-data-analysis:latest
```

## Image Contents

| Package | Purpose |
| --- | --- |
| duckdb | OLAP queries (directly on CSV/Parquet) |
| pandas | Data cleaning, feature engineering |
| scikit-learn | Prediction, clustering, classification |
| matplotlib | Static chart generation |
| plotly | Interactive complex charts |
| statsmodels | Time-series forecasting (ARIMA/ETS) |
| seaborn | Statistical visualization |
| openpyxl | Excel read/write |
| pyarrow | Parquet support |
