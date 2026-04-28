import json
import sys

if len(sys.argv) > 1:
    market_id = sys.argv[1]
else:
    print("Usage: python analyze_market_detail.py <market_id>")
    print("Example: python analyze_market_detail.py 0x0be664ea0f08b3884ac15ed0174065438adf9d4847fcea6257eb85f9ba1a5751")
    sys.exit(1)

market_file = f"analyze/BestMarkets/{market_id}.jsonl"
try:
    with open(market_file, 'r') as f:
        lines = f.readlines()
        last_line = json.loads(lines[-1])
        outcomes = last_line['outcomes']
        first_line = json.loads(lines[1])
        initial_outcomes = first_line['outcomes']
        
        up_price_initial = initial_outcomes[0]['price']
        down_price_initial = initial_outcomes[1]['price']
        up_price_final = outcomes[0]['price']
        down_price_final = outcomes[1]['price']
        
        winner = "Up" if up_price_final > down_price_final else "Down"
        
        print(f"Initial: Up=${up_price_initial}, Down=${down_price_initial}")
        print(f"Final: Up=${up_price_final}, Down=${down_price_final} -> Winner: {winner}")
except Exception as e:
    print(f"Error reading market file: {e}")
    sys.exit(1)

trade_file = f"data/trades/0xe1d6b51521bd4365769199f392f9818661bd907c/{market_id}.json"
try:
    with open(trade_file, 'r') as f:
        trades_raw = json.load(f)
        trades = [{'timestamp': t['timestamp'], 'outcome': t['outcome'], 
                   'size': t['size'], 'usdValue': t['usdValue'], 'price': t['price']} 
                  for t in trades_raw]
except Exception as e:
    print(f"Error reading trade file: {e}")
    sys.exit(1)

up_shares = 0
up_cost = 0
down_shares = 0
down_cost = 0

base_time = trades[0]['timestamp']

print("=" * 160)
print(f"Market ID: {market_id}")
print("=" * 160)
print(f"| #  | Time   | Side | Price  | Shares   | USD     | Up Shares  | Up Cost   | Avg Up   | Down Shares | Down Cost | Avg Down | Spread | Total Inv | PnL ({winner}) |")
print("|" + "-"*158 + "|")

for i, t in enumerate(trades, 1):
    seconds = t['timestamp'] - base_time
    mins = seconds // 60
    secs = seconds % 60
    time_str = f"10:{mins:02d}:{secs:02d}"
    
    if t['outcome'] == 'Up':
        up_shares += t['size']
        up_cost += t['usdValue']
    else:
        down_shares += t['size']
        down_cost += t['usdValue']
    
    avg_up = up_cost / up_shares if up_shares > 0 else 0
    avg_down = down_cost / down_shares if down_shares > 0 else 0
    spread = 1 - (avg_up + avg_down) if (up_shares > 0 and down_shares > 0) else 0
    total_invested = up_cost + down_cost
    
    if winner == "Up":
        pnl = up_shares * up_price_final + down_shares * down_price_final - total_invested
    else:
        pnl = down_shares * down_price_final + up_shares * up_price_final - total_invested
    
    print(f"| {i:2d} | {time_str} | {t['outcome']:4s} | ${t['price']:.2f} | {t['size']:8.2f} | ${t['usdValue']:7.2f} | {up_shares:10.2f} | ${up_cost:8.2f} | ${avg_up:.3f} | {down_shares:11.2f} | ${down_cost:8.2f} | ${avg_down:.3f} | {spread:+.3f} | ${total_invested:8.2f} | ${pnl:10.2f} |")

print("\n" + "="*160)
print("FINAL POSITION:")
if up_shares > 0:
    print(f"  UP:   {up_shares:.2f} shares @ avg ${up_cost/up_shares:.4f} = ${up_cost:.2f}")
if down_shares > 0:
    print(f"  DOWN: {down_shares:.2f} shares @ avg ${down_cost/down_shares:.4f} = ${down_cost:.2f}")
print(f"  TOTAL INVESTED: ${up_cost + down_cost:.2f}")

up_final_value = up_shares * up_price_final
down_final_value = down_shares * down_price_final

print("\n" + "="*160)
print(f"SETTLEMENT (Up = ${up_price_final}, Down = ${down_price_final}):")
print(f"  Up final value:   {up_shares:.2f} x ${up_price_final} = ${up_final_value:.2f}")
print(f"  Down final value: {down_shares:.2f} x ${down_price_final} = ${down_final_value:.2f}")
print(f"  Total value: ${up_final_value + down_final_value:.2f}")
total_pnl = (up_final_value + down_final_value) - (up_cost + down_cost)
print(f"  TOTAL PnL: ${total_pnl:.2f}")
print(f"  WINNER: {winner}")

# ==================== GRID ANALYSIS ====================
print("\n" + "="*160)
print("GRID ANALYSIS - Price Ranges Bot Trades In")
print("="*160)

# Analyze price ranges for Up and Down separately
up_prices = [t['price'] for t in trades if t['outcome'] == 'Up']
down_prices = [t['price'] for t in trades if t['outcome'] == 'Down']

# Price buckets
buckets = [
    (0.00, 0.10, "0.00-0.10"),
    (0.10, 0.20, "0.10-0.20"),
    (0.20, 0.30, "0.20-0.30"),
    (0.30, 0.40, "0.30-0.40"),
    (0.40, 0.45, "0.40-0.45"),
    (0.45, 0.50, "0.45-0.50"),
    (0.50, 0.55, "0.50-0.55"),
    (0.55, 0.60, "0.55-0.60"),
    (0.60, 0.65, "0.60-0.65"),
    (0.65, 0.70, "0.65-0.70"),
    (0.70, 0.75, "0.70-0.75"),
    (0.75, 0.80, "0.75-0.80"),
    (0.80, 0.83, "0.80-0.83"),
    (0.83, 0.90, "0.83-0.90"),
    (0.90, 1.00, "0.90-1.00"),
]

print("\n--- UP SIDE ---")
up_counts = {}
for low, high, label in buckets:
    count = sum(1 for p in up_prices if low <= p < high)
    if count > 0:
        up_counts[label] = count

for label, count in sorted(up_counts.items(), key=lambda x: x[1], reverse=True):
    pct = count / len(up_prices) * 100 if up_prices else 0
    print(f"  {label:12s}: {count:3d} trades ({pct:5.1f}%)")

print(f"\n  Total UP trades: {len(up_prices)}")
print(f"  Min price: ${min(up_prices):.2f}, Max price: ${max(up_prices):.2f}")

print("\n--- DOWN SIDE ---")
down_counts = {}
for low, high, label in buckets:
    count = sum(1 for p in down_prices if low <= p < high)
    if count > 0:
        down_counts[label] = count

for label, count in sorted(down_counts.items(), key=lambda x: x[1], reverse=True):
    pct = count / len(down_prices) * 100 if down_prices else 0
    print(f"  {label:12s}: {count:3d} trades ({pct:5.1f}%)")

print(f"\n  Total DOWN trades: {len(down_prices)}")
print(f"  Min price: ${min(down_prices):.2f}, Max price: ${max(down_prices):.2f}")

# Identify grid pattern
print("\n" + "="*160)
print("GRID PATTERN SUMMARY")
print("="*160)

up_main_range = [k for k, v in up_counts.items() if v >= len(up_prices)*0.05]
down_main_range = [k for k, v in down_counts.items() if v >= len(down_prices)*0.05]

print(f"\nUP main trading range: {', '.join(up_main_range) if up_main_range else 'None'}")
print(f"DOWN main trading range: {', '.join(down_main_range) if down_main_range else 'None'}")

# Check threshold behavior
up_above_083 = sum(1 for p in up_prices if p >= 0.83)
down_above_083 = sum(1 for p in down_prices if p >= 0.83)
up_below_045 = sum(1 for p in up_prices if p < 0.45)
down_below_045 = sum(1 for p in down_prices if p < 0.45)

print(f"\nTrades above $0.83:")
print(f"  UP side: {up_above_083} ({up_above_083/len(up_prices)*100:.1f}% of UP trades)")
print(f"  DOWN side: {down_above_083} ({down_above_083/len(down_prices)*100:.1f}% of DOWN trades)")

print(f"\nTrades below $0.45:")
print(f"  UP side: {up_below_045} ({up_below_045/len(up_prices)*100:.1f}% of UP trades)")
print(f"  DOWN side: {down_below_045} ({down_below_045/len(down_prices)*100:.1f}% of DOWN trades)")