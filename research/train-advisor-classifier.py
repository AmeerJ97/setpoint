#!/usr/bin/env python3
"""Train Claude Ops advisor classifier.

Pipeline
--------
1. Load `~/.claude/plugins/claude-ops/usage-history.jsonl` (one record
   per 5 min per session, written by src/analytics/history.js).
2. Engineer four features per record:
      readEditRatio, burnVelocityVsP50, contextPct, reversalsPer1k
3. Derive 3-class labels from the existing advisor signal:
      increase|nominal → healthy
      reduce           → watch
      throttle|limit_hit → risk
4. Min-max normalise, train using a compatible local softmax+SGD repo
   supplied via --lr-repo or CLAUDE_OPS_LR_REPO.
5. Export weights + scaler to
   claude-ops/src/advisor/classifier-weights.json
   (gitignored; overrides the vendored .default.json at inference time)

The repo implements multi-class logistic regression as softmax with
mini-batch SGD + momentum (shape returned from fit(): (D+1, C) with
bias appended as the final row — matches exactly what our JS
inference expects, no reshape needed).

Run this whenever you want to re-personalise the classifier; the JS
inference side reloads on every HUD render so no restart is needed.

Usage
-----
  python research/train-advisor-classifier.py           # default paths
  python research/train-advisor-classifier.py --history /path/to/file.jsonl

Requires: numpy and scikit-learn in the chosen LR repo environment.
"""

from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Tuple

# ---------- config ----------------------------------------------------------

FEATURES = ["readEditRatio", "burnVelocityVsP50", "contextPct", "reversalsPer1k"]
CLASSES  = ["healthy", "watch", "risk"]

DEFAULT_HISTORY = Path.home() / ".claude" / "plugins" / "claude-ops" / "usage-history.jsonl"
DEFAULT_OUT     = Path(__file__).parent.parent / "src" / "advisor" / "classifier-weights.json"
DEFAULT_LR_REPO_CANDIDATES = [
    Path("/home/core/dev/production/Multi-class-Logistic-Regression-and-Mini-Batch-Stochastic-Gradient-Descent"),
    Path.home() / "dev" / "production" / "Multi-class-Logistic-Regression-and-Mini-Batch-Stochastic-Gradient-Descent",
]

SIGNAL_TO_LABEL = {
    "increase": 0,   # healthy
    "nominal":  0,   # healthy
    "reduce":   1,   # watch
    "throttle": 2,   # risk
    "limit_hit":2,   # risk
}


def resolve_lr_repo(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser()
        if path.exists():
            return path
        sys.exit(f"LR repo not found at {path}")

    env_value = os.environ.get("CLAUDE_OPS_LR_REPO")
    if env_value:
        path = Path(env_value).expanduser()
        if path.exists():
            return path
        sys.exit(f"CLAUDE_OPS_LR_REPO points to a missing path: {path}")

    for candidate in DEFAULT_LR_REPO_CANDIDATES:
        if candidate.exists():
            return candidate

    sys.exit(
        "no LR repo found. Pass --lr-repo /path/to/repo or set CLAUDE_OPS_LR_REPO."
    )


def load_lr_modules(lr_repo: Path):
    sys.path.insert(0, str(lr_repo))
    try:
        import numpy as np  # type: ignore
        from sklearn.preprocessing import MinMaxScaler  # noqa: F401
        import softmax_Regression as softmax_mod  # type: ignore
        import GradientDescent as gd_mod  # type: ignore
    except Exception as e:
        sys.exit(
            f"failed to import LR repo from {lr_repo}: {e}\n"
            "make sure numpy + scikit-learn are installed in that environment."
        )
    return np, softmax_mod, gd_mod

# ---------- data loading ----------------------------------------------------

def load_history(path: Path) -> List[Dict]:
    if not path.exists():
        sys.exit(f"history file not found: {path}\n"
                 f"(run Claude Code for a while first — the analytics daemon "
                 f"writes entries every 5 min)")
    out = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out

def engineer_features(entries: List[Dict], np) -> Tuple["np.ndarray", "np.ndarray", Dict]:
    """Turn raw history entries into (X, y, scaler_params).

    Scaler params are returned separately so they can be serialised
    alongside the weights and used by the JS inference side.
    """
    rows = []
    labels = []
    for e in entries:
        sig = e.get("signal", "nominal")
        if sig not in SIGNAL_TO_LABEL:
            continue
        ratio = e.get("readEditRatio") or e.get("ratio")
        if ratio is None:
            # Derive from reads/edits if present.
            r = e.get("reads", 0); ed = e.get("edits", 0)
            ratio = 20.0 if ed == 0 and r > 0 else (r / max(ed, 1))
        ratio = min(20.0, float(ratio))
        burnV = float(e.get("burnVelocity") or e.get("burnVelocityVsP50") or 1.0)
        ctx   = float(e.get("contextPct") or e.get("contextPercent") or 0.0)
        rev   = float(e.get("reversalsPer1k") or 0.0)
        rows.append([ratio, burnV, ctx, rev])
        labels.append(SIGNAL_TO_LABEL[sig])

    if not rows:
        sys.exit("no usable rows in history — every entry lacked a valid signal.")

    X = np.array(rows, dtype=np.float64)
    y = np.array(labels, dtype=np.int64)

    # Min-max scale. Store min/max so JS can replicate the transform.
    mins = X.min(axis=0)
    maxs = X.max(axis=0)
    spans = np.where(maxs - mins > 0, maxs - mins, 1.0)
    X_norm = (X - mins) / spans

    scaler = {"min": mins.tolist(), "max": maxs.tolist()}
    return X_norm, y, scaler

# ---------- training --------------------------------------------------------

def train(X, y, gd_mod, softmax_mod, np):
    """Call the user's softmax LR with mini-batch SGD + momentum.

    Inspect the LR repo's `softmax_Regression.fit` signature — it
    returns (w_optimal, encoder). We just want the weight matrix;
    encoder is one-hot over the integer labels we already supplied.
    """
    # The repo expects y as integer class labels. Feature-engineer has
    # done the min-max scaling per README expectations.
    optimizer = gd_mod.Gradient_Descent(
        alpha=0.05,        # learning rate
        beta=0.9,          # momentum
        batch_size=32,
        epochs=500,
    )
    try:
        w, _enc = softmax_mod.fit(X, y, optimizer)
    except TypeError:
        # API drift fallback — try a positional call.
        w, _enc = softmax_mod.fit(X, y, optimizer=optimizer)  # type: ignore
    return np.asarray(w, dtype=np.float64)

# ---------- serialisation ---------------------------------------------------

def save_weights(w: np.ndarray, scaler: Dict, out_path: Path, n_rows: int) -> None:
    """Write the JSON shape the JS inference side expects.

    Shape: weights is (D+1) × C (D features + bias row, C classes).
    """
    payload = {
        "trainedAt": _utc_now(),
        "trainedOn": f"user-history ({n_rows} rows)",
        "trainedWith": "Multi-class-Logistic-Regression-and-Mini-Batch-Stochastic-Gradient-Descent (softmax + SGD + momentum)",
        "features": FEATURES,
        "classes": CLASSES,
        "scaler": scaler,
        "weights": w.tolist(),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {out_path}")

def _utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")

# ---------- main ------------------------------------------------------------

def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", default=str(DEFAULT_HISTORY))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--lr-repo", default=None)
    args = ap.parse_args(argv)

    lr_repo = resolve_lr_repo(args.lr_repo)
    print(f"using LR repo {lr_repo}")
    np, softmax_mod, gd_mod = load_lr_modules(lr_repo)

    print(f"loading history from {args.history}")
    entries = load_history(Path(args.history))
    print(f"  {len(entries)} raw entries")

    X, y, scaler = engineer_features(entries, np)
    print(f"  feature matrix: {X.shape}; class counts: "
          f"{ {CLASSES[i]: int((y==i).sum()) for i in range(len(CLASSES))} }")

    if len(np.unique(y)) < 2:
        sys.exit("only one class present — need a more varied session history "
                 "before training. Use the vendored default weights for now.")

    w = train(X, y, gd_mod, softmax_mod, np)
    print(f"  weights shape: {w.shape}")

    save_weights(w, scaler, Path(args.out), n_rows=len(entries))
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
