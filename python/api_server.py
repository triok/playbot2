"""
AI Decision Engine - API Server
================================
FastAPI server that provides /decide endpoint for Node.js bot.
"""

import pickle
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import numpy as np

# ========================
# CONFIGURATION
# ========================
MODEL_PATH = Path(__file__).parent / "models" / "decision_model.json"
PORT = 8000

# ========================
# LOAD MODEL
# ========================
print("Loading model...")
try:
    with open(MODEL_PATH, 'rb') as f:
        model_data = pickle.load(f)
    
    model = model_data['model']
    feature_cols = model_data['feature_cols']
    accuracy = model_data.get('accuracy', 0)
    
    print(f"✅ Model loaded! Accuracy: {accuracy:.2%}")
except Exception as e:
    print(f"❌ Error loading model: {e}")
    model = None
    feature_cols = []

# ========================
# FASTAPI APP
# ========================
app = FastAPI(title="AI Decision Engine API")


# ========================
# REQUEST MODEL
# ========================
class DecisionRequest(BaseModel):
    market_id: str
    entry_side: str
    entry_price: float
    entry_size: float
    hedge_side: str
    hedge_price: float
    hedge_size: float
    total_invested: float
    
    # Current state
    current_prices: Dict[str, float]  # {"A": 0.45, "B": 0.55}
    price_history: Optional[List[Dict]] = None  # [{"ts": 123, "A": 0.45, "B": 0.55}, ...]
    positions: Dict[str, float]       # {"A": 6, "B": 4.5}
    time_until_close: int            # seconds
    
    # Optional: decision points history
    decision_history: Optional[list] = None


# ========================
# HELPER FUNCTIONS
# ========================
def prepare_features(request: DecisionRequest) -> np.ndarray:
    """Convert request to feature array"""
    
    # Current prices
    price_A = request.current_prices.get('A', 0.5)
    price_B = request.current_prices.get('B', 0.5)
    
    # Positions
    pos_A = request.positions.get('A', 0)
    pos_B = request.positions.get('B', 0)
    
    # Default values
    volatility_A = 0
    volatility_B = 0
    momentum_30s_A = 0
    momentum_30s_B = 0
    avg_spread = abs(price_A - price_B)
    max_spread = avg_spread
    min_spread = avg_spread
    leader_changes = 0
    
    # Calculate from price_history
    if request.price_history and len(request.price_history) >= 5:
        prices_A = [p['A'] for p in request.price_history]
        prices_B = [p['B'] for p in request.price_history]
        
        # Volatility (std dev)
        volatility_A = float(np.std(prices_A)) if len(prices_A) > 1 else 0
        volatility_B = float(np.std(prices_B)) if len(prices_B) > 1 else 0
        
        # Momentum - last 30 seconds (or all if less)
        recent_30_a = prices_A[-30:] if len(prices_A) >= 30 else prices_A
        recent_30_b = prices_B[-30:] if len(prices_B) >= 30 else prices_B
        momentum_30s_A = float(recent_30_a[-1] - recent_30_a[0]) if len(recent_30_a) > 1 else 0
        momentum_30s_B = float(recent_30_b[-1] - recent_30_b[0]) if len(recent_30_b) > 1 else 0
        
        # Spread stats
        spreads = [abs(a - b) for a, b in zip(prices_A, prices_B)]
        avg_spread = float(np.mean(spreads))
        max_spread = float(max(spreads))
        min_spread = float(min(spreads))
        
        # Leader changes
        leaders = [0 if a > b else 1 for a, b in zip(prices_A, prices_B)]
        leader_changes = sum(1 for i in range(1, len(leaders)) if leaders[i] != leaders[i-1])
    
    # Build feature array in same order as training
    features = {
        'entry_price': request.entry_price,
        'entry_size': request.entry_size,
        'hedge_price': request.hedge_price,
        'hedge_size': request.hedge_size,
        'total_invested': request.total_invested,
        'price_spread_at_entry': abs(request.entry_price - request.hedge_price),
        'size_ratio': request.entry_size / request.hedge_size if request.hedge_size > 0 else 0,
        'time_to_hedge_ms': 0,
        'time_to_hedge_sec': 0,
        'price_A_at_entry': request.entry_price,
        'price_B_at_entry': 1 - request.entry_price,
        'price_A_at_mid': price_A,
        'price_B_at_mid': price_B,
        'price_A_at_end': price_A,
        'price_B_at_end': price_B,
        'momentum_30s_A': momentum_30s_A,
        'momentum_30s_B': momentum_30s_B,
        'momentum_full_A': price_A - request.entry_price,
        'momentum_full_B': price_B - (1 - request.entry_price),
        'volatility_A': volatility_A,
        'volatility_B': volatility_B,
        'avg_spread': avg_spread,
        'max_spread': max_spread,
        'min_spread': min_spread,
        'leader_changes': leader_changes,
    }
    
    # Create array in feature column order
    return np.array([[features.get(col, 0) for col in feature_cols]])


def predict_action(features: np.ndarray) -> tuple:
    """Predict action and confidence"""
    
    if model is None:
        return "HOLD", 0.5, "Model not loaded"
    
    # Get prediction and probability
    pred = model.predict(features)[0]
    proba = model.predict_proba(features)[0]
    
    confidence = max(proba)
    
    # Map prediction to action
    # Since this is a binary classifier (win/loss), we need additional logic
    # to determine the specific action
    
    # For now, we'll use simple rules based on confidence
    if confidence < 0.55:
        action = "HOLD"
        reason = "Low confidence, keeping current position"
    elif pred == 1:  # Model predicts win
        action = "HOLD"
        reason = "Model predicts win, holding position"
    else:  # Model predicts loss
        action = "EARLY_EXIT"
        reason = "Model predicts loss, exiting position"
    
    return action, confidence, reason


# ========================
# API ENDPOINTS
# ========================
@app.get("/")
def root():
    return {
        "status": "running",
        "model_loaded": model is not None,
        "accuracy": accuracy if model else None
    }


@app.post("/decide")
def decide(request: DecisionRequest):
    """Make a decision based on current market state"""
    
    try:
        # Prepare features
        features = prepare_features(request)
        
        # Get prediction
        action, confidence, reason = predict_action(features)
        
        return {
            "action": action,
            "confidence": float(confidence),
            "reason": reason,
            "model_accuracy": float(accuracy) if model else None
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
def health():
    return {"status": "healthy", "model_loaded": model is not None}


# ========================
# RUN SERVER
# ========================
if __name__ == "__main__":
    import uvicorn
    print(f"\n🚀 Starting API server on port {PORT}")
    print(f"   Endpoint: http://localhost:{PORT}/decide")
    uvicorn.run(app, host="0.0.0.0", port=PORT)