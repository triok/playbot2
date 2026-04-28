"""
AI Decision Engine - Feature Extraction and Model Training
=============================================================
This script:
1. Loads training data from all_markets.json
2. Extracts features from each market
3. Trains XGBoost model
4. Saves model to models/decision_model.json
"""

import json
import os
import numpy as np
import pandas as pd
from pathlib import Path

# For ML
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from xgboost import XGBClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix

# ========================
# CONFIGURATION
# ========================
DATA_DIR = Path(__file__).parent.parent / "data" / "training_data"
MODEL_DIR = Path(__file__).parent / "models"
INPUT_FILE = DATA_DIR / "all_markets.json"
OUTPUT_MODEL = MODEL_DIR / "decision_model.json"

# ========================
# FEATURE EXTRACTION
# ========================
def extract_features(market):
    """Extract features from a single market"""
    
    features = {}
    
    # Skip if no full match
    if market.get('status') != 'full_match':
        return None
    
    entry = market.get('entry', {})
    hedge = market.get('hedge', {})
    
    if not entry or not hedge:
        return None
    
    # === Basic features ===
    features['entry_price'] = entry.get('price', 0)
    features['entry_size'] = entry.get('size', 0)
    features['hedge_price'] = hedge.get('price', 0)
    features['hedge_size'] = hedge.get('size', 0)
    features['total_invested'] = market.get('total_invested', 0)
    
    # === Entry vs Hedge relationship ===
    features['price_spread_at_entry'] = abs(features['entry_price'] - features['hedge_price'])
    features['size_ratio'] = features['entry_size'] / features['hedge_size'] if features['hedge_size'] > 0 else 0
    
    # === Time-based features ===
    if entry.get('time') and hedge.get('time'):
        features['time_to_hedge_ms'] = hedge['time'] - entry['time']
        features['time_to_hedge_sec'] = features['time_to_hedge_ms'] / 1000
    
    # === Price trajectory features ===
    trajectory = market.get('price_trajectory', [])
    if len(trajectory) >= 10:
        # Get prices at different points
        entry_idx = 0
        hedge_idx = len(trajectory) // 2
        end_idx = len(trajectory) - 1
        
        # Get price arrays
        prices_A = [t['A'] for t in trajectory]
        prices_B = [t['B'] for t in trajectory]
        
        # Entry point
        features['price_A_at_entry'] = prices_A[entry_idx]
        features['price_B_at_entry'] = prices_B[entry_idx]
        
        # Mid point
        features['price_A_at_mid'] = prices_A[hedge_idx]
        features['price_B_at_mid'] = prices_B[hedge_idx]
        
        # End point
        features['price_A_at_end'] = prices_A[end_idx]
        features['price_B_at_end'] = prices_B[end_idx]
        
        # === Momentum features ===
        # First 30 seconds (first ~30 ticks)
        early_ticks = min(30, len(trajectory) - 1)
        if early_ticks > 0:
            features['momentum_30s_A'] = prices_A[early_ticks] - prices_A[0]
            features['momentum_30s_B'] = prices_B[early_ticks] - prices_B[0]
        
        # Full trajectory momentum
        features['momentum_full_A'] = prices_A[-1] - prices_A[0]
        features['momentum_full_B'] = prices_B[-1] - prices_B[0]
        
        # === Volatility features ===
        features['volatility_A'] = np.std(prices_A)
        features['volatility_B'] = np.std(prices_B)
        
        # === Spread features ===
        spreads = [abs(a - b) for a, b in zip(prices_A, prices_B)]
        features['avg_spread'] = np.mean(spreads)
        features['max_spread'] = max(spreads)
        features['min_spread'] = min(spreads)
        
        # === Leader changes ===
        leaders = [0 if a > b else 1 for a, b in zip(prices_A, prices_B)]
        leader_changes = sum(1 for i in range(1, len(leaders)) if leaders[i] != leaders[i-1])
        features['leader_changes'] = leader_changes
        
    # === Target variable ===
    features['result'] = 1 if market.get('result') == 'win' else 0
    
    return features


def load_and_process_data():
    """Load data and extract features"""
    
    print(f"Loading data from {INPUT_FILE}...")
    
    with open(INPUT_FILE, 'r') as f:
        markets = json.load(f)
    
    print(f"Total markets: {len(markets)}")
    
    # Extract features from each market
    feature_list = []
    for i, market in enumerate(markets):
        if i % 200 == 0:
            print(f"Processing market {i+1}/{len(markets)}...")
        
        features = extract_features(market)
        if features:
            features['market_id'] = market['market_id']
            feature_list.append(features)
    
    print(f"\nMarkets with full features: {len(feature_list)}")
    
    # Convert to DataFrame
    df = pd.DataFrame(feature_list)
    
    return df


def train_model(df):
    """Train XGBoost model"""
    
    print("\n=== TRAINING MODEL ===")
    
    # Prepare features and target
    feature_cols = [col for col in df.columns if col not in ['result', 'market_id']]
    X = df[feature_cols]
    y = df['result']
    
    print(f"Features: {len(feature_cols)}")
    print(f"Feature columns: {feature_cols}")
    print(f"Class distribution: Win={sum(y)}, Loss={len(y)-sum(y)}")
    
    # Split data
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    
    print(f"\nTrain size: {len(X_train)}, Test size: {len(X_test)}")
    
    # Train model
    model = XGBClassifier(
        n_estimators=100,
        max_depth=5,
        learning_rate=0.1,
        random_state=42,
        use_label_encoder=False,
        eval_metric='logloss'
    )
    
    print("\nTraining XGBoost...")
    model.fit(X_train, y_train)
    
    # Evaluate
    y_pred = model.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    
    print(f"\n=== MODEL EVALUATION ===")
    print(f"Accuracy: {accuracy:.4f}")
    
    print("\nClassification Report:")
    print(classification_report(y_test, y_pred, target_names=['Loss', 'Win']))
    
    print("\nConfusion Matrix:")
    cm = confusion_matrix(y_test, y_pred)
    print(cm)
    
    # Feature importance
    print("\n=== TOP FEATURES ===")
    importance = pd.DataFrame({
        'feature': feature_cols,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print(importance.head(15).to_string(index=False))
    
    # Save model
    print(f"\nSaving model to {OUTPUT_MODEL}...")
    
    # Save as JSON with metadata
    model_data = {
        'model': model,
        'feature_cols': feature_cols,
        'label_encoder': None,  # Not needed for binary
        'accuracy': accuracy
    }
    
    # Use joblib or simple save
    import pickle
    with open(OUTPUT_MODEL, 'wb') as f:
        pickle.dump(model_data, f)
    
    print(f"✅ Model saved successfully!")
    print(f"   Accuracy: {accuracy:.2%}")
    
    return model_data


def main():
    print("=" * 60)
    print("AI DECISION ENGINE - TRAINING")
    print("=" * 60)
    
    # Create model directory if needed
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    
    # Load and process data
    df = load_and_process_data()
    
    # Train model
    model_data = train_model(df)
    
    print("\n" + "=" * 60)
    print("TRAINING COMPLETE")
    print("=" * 60)
    print(f"Model saved to: {OUTPUT_MODEL}")
    print(f"Accuracy: {model_data['accuracy']:.2%}")


if __name__ == "__main__":
    main()