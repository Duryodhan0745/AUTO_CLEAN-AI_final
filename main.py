"""
main.py — AutoPrep AI  FastAPI Backend
Run:  uvicorn main:app --reload --port 8000
"""

import io
import uuid
import textwrap
import logging
import warnings
from pathlib import Path

import pandas as pd
import numpy as np

logger = logging.getLogger("autoprep")

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, Any

# ─── App setup ────────────────────────────────────────────────────────────────

app = FastAPI(title="AutoPrep AI", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store  {dataset_id: {"df": pd.DataFrame, "filename": str, ...}}
STORE: Dict[str, Dict[str, Any]] = {}

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# ─── Schemas ──────────────────────────────────────────────────────────────────

class ProcessConfig(BaseModel):
    remove_columns: list[str] = []
    missing_global: str = "mean"
    missing: Dict[str, str] = {}
    outliers: Dict[str, Any] = {"strategy": "cap"}
    encoding: Dict[str, str] = {"strategy": "onehot"}
    scaling: Dict[str, str] = {"strategy": "standard"}
    vif: Dict[str, Any] = {"enabled": False, "threshold": 10}
    rfe: Dict[str, Any] = {"enabled": False}
    pca: Dict[str, Any] = {"enabled": False, "variance": 0.95}

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _get_dataset(dataset_id: str) -> Dict[str, Any]:
    if dataset_id not in STORE:
        raise HTTPException(status_code=404, detail="Dataset not found. Please upload again.")
    return STORE[dataset_id]


def _project_file(name: str) -> Path:
    path = BASE_DIR / name
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{name} not found.")
    return path


def _infer_columns(df: pd.DataFrame):
    """Return a list of column-profile dicts."""
    cols = []
    for col in df.columns:
        missing = int(df[col].isna().sum())
        missing_pct = round(missing / len(df) * 100, 2) if len(df) else 0

        if pd.api.types.is_numeric_dtype(df[col]):
            series = df[col].dropna()
            q1, q3 = series.quantile(0.25), series.quantile(0.75)
            iqr = q3 - q1
            outliers = int(((series < q1 - 1.5 * iqr) | (series > q3 + 1.5 * iqr)).sum())
            cols.append({
                "name": col,
                "type": "numeric",
                "missing": missing,
                "missing_pct": missing_pct,
                "mean": round(float(series.mean()), 4) if len(series) else None,
                "std":  round(float(series.std()), 4)  if len(series) else None,
                "min":  round(float(series.min()), 4)  if len(series) else None,
                "max":  round(float(series.max()), 4)  if len(series) else None,
                "outliers": outliers,
            })
        else:
            top_vals = df[col].value_counts().head(3).to_dict()
            cols.append({
                "name": col,
                "type": "categorical",
                "missing": missing,
                "missing_pct": missing_pct,
                "unique": int(df[col].nunique()),
                "top_values": {str(k): int(v) for k, v in top_vals.items()},
            })
    return cols

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/healthz")
def healthcheck():
    return {"status": "ok"}


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are accepted.")

    content = await file.read()
    try:
        df = pd.read_csv(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    dataset_id = str(uuid.uuid4())[:8]
    STORE[dataset_id] = {
        "df_original": df.copy(),
        "df": df.copy(),
        "filename": file.filename,
        "cleaned_csv": None,
        "pipeline_script": None,
        "report_html": None,
    }
    return {"dataset_id": dataset_id, "filename": file.filename}


@app.get("/profile/{dataset_id}")
def profile(dataset_id: str):
    entry = _get_dataset(dataset_id)
    df = entry["df_original"]

    preview = df.head(8).fillna("").astype(str).to_dict(orient="records")
    columns = _infer_columns(df)

    return {
        "shape": {"rows": len(df), "columns": len(df.columns)},
        "preview": preview,
        "columns": columns,
    }


@app.post("/process/{dataset_id}")
def process(dataset_id: str, cfg: ProcessConfig):
    entry = _get_dataset(dataset_id)
    df = entry["df_original"].copy()
    logs = []
    pipeline_steps = []  # for script generation

    # ── Step 1: Column removal ─────────────────────────────────────────────────
    to_drop = [c for c in cfg.remove_columns if c in df.columns]
    if to_drop:
        df.drop(columns=to_drop, inplace=True)
        logs.append({"step": "column_removal",
                     "action": f"Removed {len(to_drop)} column(s): {', '.join(to_drop)}",
                     "impact": f"{len(df.columns)} columns remain"})
        pipeline_steps.append(f"df.drop(columns={to_drop}, inplace=True)")
    else:
        logs.append({"step": "column_removal", "action": "No columns removed", "impact": ""})

    # ── Step 2: Missing values ─────────────────────────────────────────────────
    num_cols = df.select_dtypes(include="number").columns.tolist()
    cat_cols = df.select_dtypes(exclude="number").columns.tolist()

    imputed_total = 0
    for col in df.columns:
        strategy = cfg.missing.get(col) or cfg.missing_global
        n_missing = int(df[col].isna().sum())
        if n_missing == 0:
            continue
        if strategy == "drop_rows":
            df.dropna(subset=[col], inplace=True)
            pipeline_steps.append(f"df.dropna(subset=['{col}'], inplace=True)")
        elif strategy == "drop_column":
            df.drop(columns=[col], inplace=True)
            pipeline_steps.append(f"df.drop(columns=['{col}'], inplace=True)")
        elif strategy == "mean" and col in df.select_dtypes(include="number").columns:
            fill_val = df[col].mean()
            df[col].fillna(fill_val, inplace=True)
            pipeline_steps.append(f"df['{col}'].fillna(df['{col}'].mean(), inplace=True)")
        elif strategy == "median" and col in df.select_dtypes(include="number").columns:
            fill_val = df[col].median()
            df[col].fillna(fill_val, inplace=True)
            pipeline_steps.append(f"df['{col}'].fillna(df['{col}'].median(), inplace=True)")
        else:
            # mode for categorical or fallback
            fill_val = df[col].mode().iloc[0] if not df[col].mode().empty else "Unknown"
            df[col].fillna(fill_val, inplace=True)
            pipeline_steps.append(f"df['{col}'].fillna(df['{col}'].mode()[0], inplace=True)")
        imputed_total += n_missing

    if imputed_total > 0:
        logs.append({"step": "missing_values",
                     "action": f"Imputed / removed {imputed_total} missing value(s)",
                     "impact": f"{int(df.isna().sum().sum())} missing cells remain"})
    else:
        logs.append({"step": "missing_values", "action": "No missing values found", "impact": ""})

    # ── Step 3: Outliers ───────────────────────────────────────────────────────
    num_cols = df.select_dtypes(include="number").columns.tolist()
    outlier_strategy = cfg.outliers.get("strategy", "cap")
    rows_before = len(df)
    outlier_count = 0

    if outlier_strategy == "remove":
        mask = pd.Series([True] * len(df))
        for col in num_cols:
            q1, q3 = df[col].quantile(0.25), df[col].quantile(0.75)
            iqr = q3 - q1
            mask = mask & ~((df[col] < q1 - 1.5 * iqr) | (df[col] > q3 + 1.5 * iqr))
        outlier_count = (~mask).sum()
        df = df[mask]
        pipeline_steps.append("# Outlier removal (IQR)\nfor col in df.select_dtypes('number'):\n    q1,q3=df[col].quantile(.25), df[col].quantile(.75); iqr=q3-q1\n    df=df[~((df[col]<q1-1.5*iqr)|(df[col]>q3+1.5*iqr))]")
    elif outlier_strategy == "cap":
        for col in num_cols:
            q1, q3 = df[col].quantile(0.25), df[col].quantile(0.75)
            iqr = q3 - q1
            lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
            capped = ((df[col] < lo) | (df[col] > hi)).sum()
            outlier_count += capped
            df[col] = df[col].clip(lo, hi)
        pipeline_steps.append("# Outlier capping (IQR)\nfor col in df.select_dtypes('number'):\n    q1,q3=df[col].quantile(.25),df[col].quantile(.75); iqr=q3-q1\n    df[col]=df[col].clip(q1-1.5*iqr,q3+1.5*iqr)")

    if outlier_strategy == "keep":
        logs.append({"step": "outliers", "action": "Outliers kept as-is (strategy=keep)", "impact": ""})
    else:
        action = "capped" if outlier_strategy == "cap" else "removed rows with"
        logs.append({"step": "outliers",
                     "action": f"{action} {outlier_count} outlier value(s)",
                     "impact": f"{len(df)} rows remain"})

    # ── Step 4: Encoding ───────────────────────────────────────────────────────
    cat_cols = df.select_dtypes(exclude="number").columns.tolist()
    enc_strategy = cfg.encoding.get("strategy", "onehot")

    if cat_cols:
        if enc_strategy == "onehot":
            df = pd.get_dummies(df, columns=cat_cols, drop_first=False)
            pipeline_steps.append(f"df = pd.get_dummies(df, columns={cat_cols}, drop_first=False)")
            logs.append({"step": "encoding",
                         "action": f"One-hot encoded {len(cat_cols)} categorical column(s)",
                         "impact": f"Dataset now has {len(df.columns)} columns"})
        else:
            from sklearn.preprocessing import LabelEncoder
            le = LabelEncoder()
            for col in cat_cols:
                df[col] = le.fit_transform(df[col].astype(str))
            pipeline_steps.append(f"from sklearn.preprocessing import LabelEncoder\nle=LabelEncoder()\nfor col in {cat_cols}:\n    df[col]=le.fit_transform(df[col].astype(str))")
            logs.append({"step": "encoding",
                         "action": f"Label-encoded {len(cat_cols)} categorical column(s)",
                         "impact": ""})
    else:
        logs.append({"step": "encoding", "action": "No categorical columns to encode", "impact": ""})

    # ── Step 5: Scaling ────────────────────────────────────────────────────────
    num_cols = df.select_dtypes(include="number").columns.tolist()
    sc_strategy = cfg.scaling.get("strategy", "standard")

    if num_cols:
        if sc_strategy == "standard":
            from sklearn.preprocessing import StandardScaler
            sc = StandardScaler()
            df[num_cols] = sc.fit_transform(df[num_cols])
            pipeline_steps.append("from sklearn.preprocessing import StandardScaler\ndf[num_cols]=StandardScaler().fit_transform(df[num_cols])")
        elif sc_strategy == "minmax":
            from sklearn.preprocessing import MinMaxScaler
            sc = MinMaxScaler()
            df[num_cols] = sc.fit_transform(df[num_cols])
            pipeline_steps.append("from sklearn.preprocessing import MinMaxScaler\ndf[num_cols]=MinMaxScaler().fit_transform(df[num_cols])")
        elif sc_strategy == "robust":
            from sklearn.preprocessing import RobustScaler
            sc = RobustScaler()
            df[num_cols] = sc.fit_transform(df[num_cols])
            pipeline_steps.append("from sklearn.preprocessing import RobustScaler\ndf[num_cols]=RobustScaler().fit_transform(df[num_cols])")
        logs.append({"step": "scaling",
                     "action": f"Applied {sc_strategy} scaling to {len(num_cols)} numeric column(s)",
                     "impact": ""})
    else:
        logs.append({"step": "scaling", "action": "No numeric columns to scale", "impact": ""})

    # ── Step 6: VIF ────────────────────────────────────────────────────────────
    vif_enabled = cfg.vif.get("enabled", False)
    vif_threshold = float(cfg.vif.get("threshold", 10))
    dropped_vif = []

    if vif_enabled:
        try:
            from statsmodels.stats.outliers_influence import variance_inflation_factor
            num_cols = df.select_dtypes(include="number").columns.tolist()
            vif_df = df[num_cols].dropna()
            changed = True
            while changed:
                changed = False
                vif_vals = [variance_inflation_factor(vif_df.values, i) for i in range(vif_df.shape[1])]
                max_vif = max(vif_vals)
                if max_vif > vif_threshold:
                    idx = vif_vals.index(max_vif)
                    col_to_drop = vif_df.columns[idx]
                    dropped_vif.append(col_to_drop)
                    vif_df.drop(columns=[col_to_drop], inplace=True)
                    df.drop(columns=[col_to_drop], inplace=True)
                    changed = True
            if dropped_vif:
                logs.append({"step": "vif",
                             "action": f"VIF filter removed {len(dropped_vif)} column(s): {', '.join(dropped_vif)}",
                             "impact": f"{len(df.columns)} columns remain (threshold={vif_threshold})"})
            else:
                logs.append({"step": "vif", "action": "VIF check passed — no columns exceed threshold", "impact": ""})
        except ImportError:
            logs.append({"step": "vif", "action": "Skipped — statsmodels not installed", "impact": ""})
    else:
        logs.append({"step": "vif", "action": "VIF filter disabled", "impact": ""})

    # ── Step 7: RFE ────────────────────────────────────────────────────────────
    rfe_enabled = cfg.rfe.get("enabled", False)
    rfe_target  = cfg.rfe.get("target", "")
    rfe_n       = cfg.rfe.get("n_features") or None

    if rfe_enabled and rfe_target and rfe_target in df.columns:
        try:
            from sklearn.feature_selection import RFE
            from sklearn.linear_model import LogisticRegression
            X = df.drop(columns=[rfe_target]).select_dtypes(include="number")
            y = df[rfe_target]
            n = rfe_n if rfe_n else max(1, X.shape[1] // 2)
            rfe = RFE(LogisticRegression(max_iter=500), n_features_to_select=n)
            rfe.fit(X, y)
            kept = X.columns[rfe.support_].tolist()
            df = df[[rfe_target] + kept]
            logs.append({"step": "rfe",
                         "action": f"RFE selected {len(kept)} feature(s) targeting '{rfe_target}'",
                         "impact": f"Kept: {', '.join(kept)}"})
        except Exception as e:
            logs.append({"step": "rfe", "action": f"RFE skipped: {e}", "impact": ""})
    else:
        logs.append({"step": "rfe", "action": "RFE disabled or no target specified", "impact": ""})

    # ── Step 8: PCA ────────────────────────────────────────────────────────────
    pca_enabled = cfg.pca.get("enabled", False)
    pca_variance = float(cfg.pca.get("variance", 0.95))

    if pca_enabled:
        try:
            from sklearn.decomposition import PCA
            num_cols = df.select_dtypes(include="number").columns.tolist()
            if len(num_cols) >= 2:
                pca = PCA(n_components=pca_variance)
                pca_data = pca.fit_transform(df[num_cols].fillna(0))
                pca_cols = [f"PC{i+1}" for i in range(pca_data.shape[1])]
                pca_df = pd.DataFrame(pca_data, columns=pca_cols, index=df.index)
                df = pd.concat([df.drop(columns=num_cols), pca_df], axis=1)
                logs.append({"step": "pca",
                             "action": f"PCA reduced {len(num_cols)} numeric columns → {pca_data.shape[1]} components",
                             "impact": f"Retained {round(pca_variance*100)}% variance"})
            else:
                logs.append({"step": "pca", "action": "PCA skipped — fewer than 2 numeric columns", "impact": ""})
        except Exception as e:
            logs.append({"step": "pca", "action": f"PCA skipped: {e}", "impact": ""})
    else:
        logs.append({"step": "pca", "action": "PCA disabled", "impact": ""})

    # ── Save cleaned df ────────────────────────────────────────────────────────
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    entry["cleaned_csv"] = buf.getvalue()
    entry["df"] = df

    # ── Generate pipeline script ──────────────────────────────────────────────
    script = textwrap.dedent(f"""\
        # AutoPrep AI — Generated Pipeline Script
        # Dataset: {entry['filename']}
        #
        # Requirements: pip install pandas scikit-learn statsmodels

        import pandas as pd
        import numpy as np

        df = pd.read_csv("{entry['filename']}")

        # ── Steps applied ──────────────────────────────────────────────────────
        """)
    for step in pipeline_steps:
        script += "\n" + step + "\n"
    script += "\ndf.to_csv('cleaned_dataset.csv', index=False)\nprint('Done! Cleaned dataset saved.')\n"
    entry["pipeline_script"] = script

    # ── Try ydata-profiling report ─────────────────────────────────────────────
    report_available = False
    try:
        from ydata_profiling import ProfileReport
        warnings.filterwarnings("ignore")

        # Prepare a clean copy for profiling
        report_df = df.copy().reset_index(drop=True)

        # pandas 2.x get_dummies returns bool dtype — convert to int so profiling works
        bool_cols = report_df.select_dtypes(include="bool").columns.tolist()
        if bool_cols:
            report_df[bool_cols] = report_df[bool_cols].astype(int)

        # Cap at 1000 rows for speed
        if len(report_df) > 1000:
            report_df = report_df.sample(1000, random_state=42)

        rpt = ProfileReport(
            report_df,
            title="AutoPrep AI — Cleaned Dataset",
            minimal=True,
            progress_bar=False,
        )
        entry["report_html"] = rpt.to_html()
        report_available = True
        logger.info("ydata-profiling report generated successfully")
    except Exception as exc:
        logger.warning(f"ydata-profiling failed: {exc}")
        entry["report_html"] = None
        entry["report_error"] = str(exc)

    orig_df = entry["df_original"]
    return {
        "rows_before": len(orig_df),
        "rows_after":  len(df),
        "cols_before": len(orig_df.columns),
        "cols_after":  len(df.columns),
        "report_available": report_available,
        "logs": logs,
    }


@app.get("/download/{dataset_id}")
def download_csv(dataset_id: str):
    entry = _get_dataset(dataset_id)
    if not entry.get("cleaned_csv"):
        raise HTTPException(status_code=400, detail="Dataset has not been processed yet.")
    return StreamingResponse(
        io.StringIO(entry["cleaned_csv"]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=cleaned_{entry['filename']}"},
    )


@app.get("/pipeline/{dataset_id}")
def download_pipeline(dataset_id: str):
    entry = _get_dataset(dataset_id)
    if not entry.get("pipeline_script"):
        raise HTTPException(status_code=400, detail="Dataset has not been processed yet.")
    return StreamingResponse(
        io.StringIO(entry["pipeline_script"]),
        media_type="text/x-python",
        headers={"Content-Disposition": "attachment; filename=pipeline.py"},
    )


@app.get("/report/{dataset_id}", response_class=HTMLResponse)
def view_report(dataset_id: str):
    entry = _get_dataset(dataset_id)
    if not entry.get("report_html"):
        raise HTTPException(status_code=404, detail="Report not available.")
    return HTMLResponse(content=entry["report_html"])


@app.get("/download-report/{dataset_id}")
def download_report(dataset_id: str):
    entry = _get_dataset(dataset_id)
    if not entry.get("report_html"):
        raise HTTPException(status_code=404, detail="Report not available.")
    return StreamingResponse(
        io.StringIO(entry["report_html"]),
        media_type="text/html",
        headers={"Content-Disposition": "attachment; filename=profiling_report.html"},
    )


@app.get("/report-status/{dataset_id}")
def report_status(dataset_id: str):
    """Debug endpoint — shows whether report generation succeeded and why."""
    entry = _get_dataset(dataset_id)
    return {
        "report_available": entry.get("report_html") is not None,
        "report_html_length": len(entry["report_html"]) if entry.get("report_html") else 0,
        "report_error": entry.get("report_error", None),
    }


@app.get("/", response_class=FileResponse)
def serve_frontend():
    """Serve the main HTML frontend."""
    return FileResponse(_project_file("index.html"))

@app.get("/styles.css")
def serve_css():
    return FileResponse(_project_file("styles.css"), media_type="text/css")

@app.get("/api.js")
def serve_api_js():
    return FileResponse(_project_file("api.js"), media_type="application/javascript")

@app.get("/app.js")
def serve_app_js():
    return FileResponse(_project_file("app.js"), media_type="application/javascript")
