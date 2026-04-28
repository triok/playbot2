import json
import os
from pathlib import Path
from collections import defaultdict
import statistics

MARKETS_DIR = "analyze/BestMarkets"
TRADES_DIR = "data/trades/0xe1d6b51521bd4365769199f392f9818661bd907c"

def load_market_prices(market_file):
    """Load market price data from JSONL file."""
    prices = []
    with open(market_file, 'r') as f:
        for line in f:
            data = json.loads(line.strip())
            if 'meta' not in data:
                prices.append(data)
    return prices

def load_trades(trade_file):
    """Load trades from JSON file."""
    with open(trade_file, 'r') as f:
        return json.load(f)

def find_matching_trade_file(market_name):
    """Find the trade file that matches this market."""
    market_id = market_name.replace('.jsonl', '')
    
    trade_files = list(Path(TRADES_DIR).glob('*.json'))
    for tf in trade_files:
        with open(tf, 'r') as f:
            trades = json.load(f)
            if trades and trades[0].get('conditionId') == market_id:
                return tf.name
    return None

def analyze_market_detailed(market_file):
    """Analyze a single market with step-by-step PnL tracking."""
    market_name = os.path.basename(market_file)
    market_id = market_name.replace('.jsonl', '')
    
    print(f"\n{'='*60}")
    print(f"MARKET: {market_id[:30]}...")
    print(f"{'='*60}")
    
    prices = load_market_prices(market_file)
    if not prices:
        print("No price data")
        return None
    
    trade_file_name = find_matching_trade_file(market_name)
    if not trade_file_name:
        print("No matching trade file found")
        return None
    
    trades = load_trades(os.path.join(TRADES_DIR, trade_file_name))
    if not trades:
        print("No trades")
        return None
    
    # Sort by timestamp
    prices.sort(key=lambda x: x.get('ts', 0))
    trades.sort(key=lambda x: x.get('timestamp', 0))
    
    print(f"\nTotal trades: {len(trades)}")
    print(f"Price snapshots: {len(prices)}")
    
    # Get final outcome
    last_price = prices[-1]
    outcomes = last_price.get('outcomes', [])
    winner = "Up" if outcomes[0].get('price', 0) > outcomes[1].get('price', 0) else "Down"
    final_up_price = outcomes[0].get('price', 0)
    final_down_price = outcomes[1].get('price', 0)
    
    print(f"\n--- FINAL OUTCOME ---")
    print(f"Winner: {winner} (Up=${final_up_price:.4f}, Down=${final_down_price:.4f})")
    
    # Track running position step by step
    print(f"\n{'='*60}")
    print("STEP-BY-STEP POSITION EVOLUTION")
    print(f"{'='*60}")
    
    # Position tracking
    up_position = {'shares': 0, 'total_cost': 0, 'avg_price': 0}
    down_position = {'shares': 0, 'total_cost': 0, 'avg_price': 0}
    
    # Get current market prices at each trade time
    def get_market_price_at_time(timestamp):
        """Get closest market price to trade timestamp."""
        trade_ts_ms = timestamp * 1000
        for p in prices:
            if p.get('ts', 0) >= trade_ts_ms:
                return p
        return prices[-1] if prices else None
    
    events = []  # Track all position changes
    
    for i, trade in enumerate(trades):
        outcome = trade.get('outcome', 'Unknown')
        size = trade.get('size', 0)
        price = trade.get('price', 0)
        usd = trade.get('usdValue', 0)
        timestamp = trade.get('timestamp', 0)
        
        # Update position
        if outcome == "Up":
            old_shares = up_position['shares']
            old_cost = up_position['total_cost']
            up_position['shares'] += size
            up_position['total_cost'] += usd
            up_position['avg_price'] = up_position['total_cost'] / up_position['shares'] if up_position['shares'] > 0 else 0
            action = "ENTER_UP" if old_shares == 0 else "ADD_UP"
        else:
            old_shares = down_position['shares']
            old_cost = down_position['total_cost']
            down_position['shares'] += size
            down_position['total_cost'] += usd
            down_position['avg_price'] = down_position['total_cost'] / down_position['shares'] if down_position['shares'] > 0 else 0
            action = "ENTER_DOWN" if old_shares == 0 else "ADD_DOWN"
        
        # Calculate current PnL
        # PnL = (Up shares * final_up_price + Down shares * final_down_price) - total_cost
        up_value = up_position['shares'] * final_up_price
        down_value = down_position['shares'] * final_down_price
        total_value = up_value + down_value
        total_cost = up_position['total_cost'] + down_position['total_cost']
        current_pnl = total_value - total_cost
        
        # Net position (which side is larger)
        net_shares = up_position['shares'] - down_position['shares']
        net_direction = "UP_LEAN" if net_shares > 0 else ("DOWN_LEAN" if net_shares < 0 else "BALANCED")
        
        event = {
            'step': i + 1,
            'action': action,
            'outcome': outcome,
            'size': size,
            'price': price,
            'up_shares': up_position['shares'],
            'up_avg': up_position['avg_price'],
            'down_shares': down_position['shares'],
            'down_avg': down_position['avg_price'],
            'total_cost': total_cost,
            'current_pnl': current_pnl,
            'net_direction': net_direction
        }
        events.append(event)
        
        # Print key events (entry, hedge, and every 10th trade)
        show_event = (i < 3) or (i < 10 and i % 3 == 0) or (i % 20 == 0) or (i == len(trades) - 1)
        
        if show_event:
            print(f"\n--- Step {i+1} ---")
            print(f"Trade: {action} | {outcome} | {size:.2f} shares @ ${price:.4f}")
            print(f"Position: Up={up_position['shares']:.2f}@${up_position['avg_price']:.4f} | Down={down_position['shares']:.2f}@${down_position['avg_price']:.4f}")
            print(f"Total cost: ${total_cost:.2f} | Current PnL: ${current_pnl:.2f} | Net: {net_direction}")
    
    # Summary
    print(f"\n{'='*60}")
    print("FINAL SUMMARY")
    print(f"{'='*60}")
    print(f"Up position: {up_position['shares']:.2f} shares @ ${up_position['avg_price']:.4f} (cost ${up_position['total_cost']:.2f})")
    print(f"Down position: {down_position['shares']:.2f} shares @ ${down_position['avg_price']:.4f} (cost ${down_position['total_cost']:.2f})")
    
    total_cost = up_position['total_cost'] + down_position['total_cost']
    final_value = up_position['shares'] * final_up_price + down_position['shares'] * final_down_price
    final_pnl = final_value - total_cost
    
    print(f"\nTotal invested: ${total_cost:.2f}")
    print(f"Final value: ${final_value:.2f}")
    print(f"Final PnL: ${final_pnl:.2f}")
    print(f"Winner was: {winner}")
    
    return {
        'market_id': market_id[:20],
        'events': events,
        'final_pnl': final_pnl,
        'winner': winner,
        'total_cost': total_cost
    }

def analyze_decision_patterns(all_results):
    """Analyze decision patterns across all markets."""
    print(f"\n{'='*60}")
    print("DECISION ENGINE ANALYSIS")
    print(f"{'='*60}")
    
    # Analyze first action after entry
    first_actions_after_entry = []
    hedge_timing = []
    add_patterns = []
    
    for result in all_results:
        events = result.get('events', [])
        if not events:
            continue
        
        # First action after initial entry
        if len(events) > 1:
            first_action = events[1]['action']
            first_actions_after_entry.append(first_action)
        
        # Hedge timing (when opposite side was first added)
        entry_side = events[0]['outcome']
        for i, e in enumerate(events[1:], 1):
            if e['outcome'] != entry_side:
                hedge_timing.append(i)
                break
        
        # Add patterns - after entry, does bot add more to same side or switch?
        same_side_adds = 0
        switch_adds = 0
        for i in range(1, len(events)):
            if events[i]['action'].startswith('ADD'):
                if events[i]['outcome'] == events[i-1]['outcome']:
                    same_side_adds += 1
                else:
                    switch_adds += 1
        
        add_patterns.append({
            'same': same_side_adds,
            'switch': switch_adds
        })
    
    print(f"\n--- First Action After Entry ---")
    first_up = sum(1 for x in first_actions_after_entry if x == 'ADD_UP')
    first_down = sum(1 for x in first_actions_after_entry if x == 'ADD_DOWN')
    first_hedge = sum(1 for x in first_actions_after_entry if 'ADD_' in x and x.split('_')[1] != events[0]['outcome'])
    print(f"Add to same side first: {sum(1 for x in first_actions_after_entry if 'ADD' in x)}/{len(first_actions_after_entry)}")
    print(f"  - ADD_UP: {first_up}")
    print(f"  - ADD_DOWN: {first_down}")
    
    print(f"\n--- Hedge Timing (which trade #) ---")
    if hedge_timing:
        import statistics
        print(f"Average hedge at trade #: {statistics.mean(hedge_timing):.1f}")
        print(f"Range: {min(hedge_timing)} - {max(hedge_timing)}")
    
    print(f"\n--- Add Patterns (after entry) ---")
    total_same = sum(p['same'] for p in add_patterns)
    total_switch = sum(p['switch'] for p in add_patterns)
    print(f"Same side adds: {total_same}")
    print(f"Switch to opposite: {total_switch}")
    print(f"Ratio: {total_same/(total_switch+1):.1f}:1 (same:switch)")
    
    # Calculate step-by-step PnL progression for each market
    print(f"\n--- PnL Progression by Trade Step ---")
    
    # Aggregate PnL at each step across all markets
    step_pnls = {}
    step_counts = {}
    
    for result in all_results:
        events = result.get('events', [])
        for e in events:
            step = e['step']
            pnl = e.get('current_pnl', 0)
            if step not in step_pnls:
                step_pnls[step] = []
            step_pnls[step].append(pnl)
            step_counts[step] = step_counts.get(step, 0) + 1
    
    # Show average PnL at key steps
    key_steps = [1, 2, 3, 5, 10, 20, 50]
    for step in key_steps:
        if step in step_pnls:
            avg_pnl = statistics.mean(step_pnls[step])
            print(f"Step {step}: Avg Pnl = ${avg_pnl:.2f} (n={step_counts[step]})")
    
    prices = load_market_prices(market_file)
    if not prices:
        print("No price data")
        return
    
    trade_file_name = find_matching_trade_file(market_name)
    if not trade_file_name:
        print("No matching trade file found")
        return
    
    trades = load_trades(os.path.join(TRADES_DIR, trade_file_name))
    if not trades:
        print("No trades")
        return
    
    print(f"Price snapshots: {len(prices)}")
    print(f"Total trades: {len(trades)}")
    
    # Sort prices by timestamp
    prices.sort(key=lambda x: x.get('ts', 0))
    
    # Sort trades by timestamp
    trades.sort(key=lambda x: x.get('timestamp', 0))
    
    # Get time range
    first_price_ts = prices[0].get('ts', 0) // 1000  # Convert to seconds
    last_price_ts = prices[-1].get('ts', 0) // 1000
    first_trade_ts = trades[0].get('timestamp', 0)
    last_trade_ts = trades[-1].get('timestamp', 0)
    
    print(f"\n--- Time Range ---")
    print(f"Price data: {first_price_ts} to {last_price_ts} ({(last_price_ts - first_price_ts)/60:.1f} min)")
    print(f"Trade data: {first_trade_ts} to {last_trade_ts} ({(last_trade_ts - first_trade_ts)/60:.1f} min)")
    
    # Analyze trades by outcome
    up_trades = [t for t in trades if t.get('outcome') == 'Up']
    down_trades = [t for t in trades if t.get('outcome') == 'Down']
    
    print(f"\n--- Trade Summary ---")
    print(f"Up trades: {len(up_trades)}")
    print(f"Down trades: {len(down_trades)}")
    
    if up_trades:
        up_total_usd = sum(t.get('usdValue', 0) for t in up_trades)
        up_total_shares = sum(t.get('size', 0) for t in up_trades)
        up_avg_price = sum(t.get('price', 0) * t.get('size', 0) for t in up_trades) / up_total_shares if up_total_shares > 0 else 0
        print(f"Up: {up_total_shares:.2f} shares, ${up_total_usd:.2f}, avg price: {up_avg_price:.4f}")
    
    if down_trades:
        down_total_usd = sum(t.get('usdValue', 0) for t in down_trades)
        down_total_shares = sum(t.get('size', 0) for t in down_trades)
        down_avg_price = sum(t.get('price', 0) * t.get('size', 0) for t in down_trades) / down_total_shares if down_total_shares > 0 else 0
        print(f"Down: {down_total_shares:.2f} shares, ${down_total_usd:.2f}, avg price: {down_avg_price:.4f}")
    
    # Analyze entry sequence
    print(f"\n--- Entry Sequence ---")
    
    # Find first trade (entry)
    first_trade = trades[0]
    first_entry_time = first_trade.get('timestamp', 0)
    first_entry_outcome = first_trade.get('outcome', 'Unknown')
    first_entry_price = first_trade.get('price', 0)
    first_entry_usd = first_trade.get('usdValue', 0)
    
    print(f"First entry: {first_entry_outcome} at ${first_entry_price:.4f} (${first_entry_usd:.2f})")
    print(f"  Time: {first_trade.get('timestampConverted', 'N/A')}")
    
    # Find first trade on opposite side (hedge start)
    opposite_trades = [t for t in trades if t.get('outcome') != first_entry_outcome]
    if opposite_trades:
        hedge_trade = opposite_trades[0]
        hedge_time = hedge_trade.get('timestamp', 0)
        hedge_outcome = hedge_trade.get('outcome', 'Unknown')
        hedge_price = hedge_trade.get('price', 0)
        
        time_to_hedge = hedge_time - first_entry_time
        print(f"Hedge start: {hedge_outcome} at ${hedge_price:.4f}")
        print(f"  Time to hedge: {time_to_hedge} seconds ({time_to_hedge/60:.1f} min)")
    else:
        print("No hedge trades found (single-sided)")
    
    # Analyze price movement during trading
    print(f"\n--- Price Movement During Trading ---")
    
    # Get price at first trade time
    first_trade_ts_ms = first_entry_time * 1000
    prices_at_entry = [p for p in prices if p.get('ts', 0) >= first_trade_ts_ms]
    
    if prices_at_entry:
        entry_snapshot = prices_at_entry[0]
        outcomes = entry_snapshot.get('outcomes', [])
        print(f"Prices at first entry:")
        for o in outcomes:
            print(f"  {o.get('assetId', 'N/A')[:20]}...: bid={o.get('bid', 0):.4f}, ask={o.get('ask', 0):.4f}")
    
    # Find price range during trading
    all_prices = []
    for p in prices:
        for o in p.get('outcomes', []):
            all_prices.append(o.get('price', 0))
    
    if all_prices:
        print(f"Price range: ${min(all_prices):.4f} - ${max(all_prices):.4f}")
    
    # Analyze trading frequency and patterns
    print(f"\n--- Trading Patterns ---")
    
    # Group trades by outcome and time buckets
    time_buckets = defaultdict(lambda: {'Up': 0, 'Down': 0, 'Up_usd': 0, 'Down_usd': 0})
    
    for t in trades:
        bucket = (t.get('timestamp', 0) // 60)  # 1-minute buckets
        outcome = t.get('outcome', 'Unknown')
        time_buckets[bucket][outcome] += 1
        time_buckets[bucket][f'{outcome}_usd'] += t.get('usdValue', 0)
    
    # Find which minute had most trading
    busiest_bucket = max(time_buckets.items(), key=lambda x: x[1]['Up'] + x[1]['Down'])
    print(f"Busiest minute: bucket {busiest_bucket[0]}, Up={busiest_bucket[1]['Up']}, Down={busiest_bucket[1]['Down']}")
    
    # Check if there's position balancing (alternating sides)
    print(f"\n--- Position Building Pattern ---")
    
    # Track order of trades
    trade_sequence = []
    running_position = {'Up': 0, 'Down': 0}
    
    for i, t in enumerate(trades):
        outcome = t.get('outcome', 'Unknown')
        size = t.get('size', 0)
        running_position[outcome] += size
        
        # Determine if this is adding to existing position or switching
        if i == 0:
            action = "FIRST_ENTRY"
        elif outcome == trade_sequence[-1]['outcome']:
            action = "ADD_SAME"
        else:
            action = "ADD_OPPOSITE"
        
        trade_sequence.append({
            'index': i,
            'outcome': outcome,
            'size': size,
            'price': t.get('price', 0),
            'action': action,
            'position_after': dict(running_position)
        })
    
    # Count action types
    add_same_count = sum(1 for t in trade_sequence if t['action'] == 'ADD_SAME')
    add_opposite_count = sum(1 for t in trade_sequence if t['action'] == 'ADD_OPPOSITE')
    
    print(f"Add to same side: {add_same_count}")
    print(f"Add to opposite side (switch): {add_opposite_count}")
    
    # Show first 10 trades sequence
    print(f"\nFirst 10 trades sequence:")
    for t in trade_sequence[:10]:
        print(f"  {t['index']+1}. {t['outcome']:4} | size: {t['size']:8.2f} | price: ${t['price']:.4f} | {t['action']}")
    
    # Determine winner (final outcome)
    print(f"\n--- Final Market Outcome ---")
    last_price_snapshot = prices[-1]
    outcomes = last_price_snapshot.get('outcomes', [])
    
    # Determine winner based on price
    if len(outcomes) == 2:
        # Assuming first is one outcome, second is another
        winner = "Up" if outcomes[0].get('price', 0) > outcomes[1].get('price', 0) else "Down"
        print(f"Winner: {winner}")
        print(f"  Outcome 1: ${outcomes[0].get('price', 0):.4f}")
        print(f"  Outcome 2: ${outcomes[1].get('price', 0):.4f}")
    
    # Calculate hypothetical PnL if bot held to end
    print(f"\n--- Hypothetical PnL Analysis ---")
    
    # Find final prices for each outcome
    final_prices = {}
    for o in outcomes:
        asset = o.get('assetId', '')
        final_prices[asset] = o.get('price', 0)
    
    # Calculate PnL based on avg entry prices
    if up_trades and down_trades:
        # Total invested
        total_invested = sum(t.get('usdValue', 0) for t in trades)
        
        # Value at settlement (assuming 1 share = $1 at settlement)
        # If Up wins: Up shares worth $1, Down worth $0
        # If Down wins: Down worth $1, Up worth $0
        up_value_if_up_wins = up_total_shares * 1.0
        down_value_if_up_wins = 0
        
        up_value_if_down_wins = 0
        down_value_if_down_wins = down_total_shares * 1.0
        
        print(f"Total invested: ${total_invested:.2f}")
        print(f"If Up wins: value=${up_value_if_up_wins:.2f}, PnL=${up_value_if_up_wins - total_invested:.2f}")
        print(f"If Down wins: value=${down_value_if_down_wins:.2f}, PnL=${down_value_if_down_wins - total_invested:.2f}")
        
        pnl_if_up_wins = up_value_if_up_wins - total_invested
        pnl_if_down_wins = down_value_if_down_wins - total_invested
    elif up_trades:
        total_invested = sum(t.get('usdValue', 0) for t in up_trades)
        up_total_shares = sum(t.get('size', 0) for t in up_trades)
        print(f"Only Up trades: ${total_invested:.2f} invested")
        pnl_if_up_wins = up_total_shares - total_invested
        pnl_if_down_wins = -total_invested
    elif down_trades:
        total_invested = sum(t.get('usdValue', 0) for t in down_trades)
        down_total_shares = sum(t.get('size', 0) for t in down_trades)
        print(f"Only Down trades: ${total_invested:.2f} invested")
        pnl_if_up_wins = -total_invested
        pnl_if_down_wins = down_total_shares - total_invested
    else:
        total_invested = 0
        pnl_if_up_wins = 0
        pnl_if_down_wins = 0
    
    # Return result for aggregation
    result = {
        'market_id': market_id[:20],
        'total_trades': len(trades),
        'first_side': first_entry_outcome,
        'first_price': first_entry_price,
        'winner': winner,
        'won': winner == first_entry_outcome,
        'hedge_seconds': time_to_hedge if opposite_trades else None,
        'invested': total_invested,
        'both_sides': bool(up_trades and down_trades),
        'up_avg_price': up_avg_price if up_trades else 0,
        'down_avg_price': down_avg_price if down_trades else 0,
        'add_same': add_same_count,
        'add_opposite': add_opposite_count,
        'pnl_if_winner': pnl_if_up_wins if winner == "Up" else pnl_if_down_wins
    }
    
    return result

def main():
    """Analyze all markets."""
    print("="*60)
    print("POLYMARKET BOT STRATEGY ANALYZER")
    print("DETAILED PnL AND DECISION ANALYSIS")
    print("="*60)
    
    # Get all market files
    market_files = list(Path(MARKETS_DIR).glob('*.jsonl'))
    print(f"Found {len(market_files)} market files")
    
    # Analyze all markets with detailed step-by-step tracking
    all_results = []
    
    for mf in market_files:
        result = analyze_market_detailed(mf)
        if result:
            all_results.append(result)
    
    # Analyze decision patterns across all markets
    if all_results:
        analyze_decision_patterns(all_results)
    
    # Aggregate statistics
    print("\n" + "="*60)
    print("AGGREGATE STATISTICS ACROSS ALL MARKETS")
    print("="*60)
    
    if all_results:
        total_markets = len(all_results)
        wins = sum(1 for r in all_results if r['winner'] == 'Up' and r.get('final_pnl', 0) > 0 or r['winner'] == 'Down' and r.get('final_pnl', 0) > 0)
        
        # Count wins (final PnL > 0)
        positive_pnl = sum(1 for r in all_results if r.get('final_pnl', 0) > 0)
        negative_pnl = sum(1 for r in all_results if r.get('final_pnl', 0) <= 0)
        
        print(f"\n--- Overall Results ---")
        print(f"Total markets: {total_markets}")
        print(f"Profitable markets: {positive_pnl}")
        print(f"Losing markets: {negative_pnl}")
        
        total_pnl = sum(r.get('final_pnl', 0) for r in all_results)
        print(f"\nTotal PnL across all markets: ${total_pnl:.2f}")
        print(f"Average PnL per market: ${total_pnl/total_markets:.2f}")
    
    print("\n" + "="*60)
    print("ANALYSIS COMPLETE")
    print("="*60)
    
# Aggregate statistics
    print("\n" + "="*60)
    print("AGGREGATE STATISTICS ACROSS ALL MARKETS")
    print("="*60)
    
    if all_results:
        total_markets = len(all_results)
        wins = sum(1 for r in all_results if r['won'])
        win_rate = wins / total_markets * 100 if total_markets > 0 else 0
        
        print(f"\n--- Overall Performance ---")
        print(f"Total markets: {total_markets}")
        print(f"Wins (guessed correctly): {wins}")
        print(f"Win rate: {win_rate:.1f}%")
        
        # First side correlation
        first_side_wins = sum(1 for r in all_results if r['first_side'] == r['winner'])
        first_side_loses = sum(1 for r in all_results if r['first_side'] != r['winner'])
        
        print(f"\n--- First Side Correlation ---")
        print(f"First side = Winner: {first_side_wins}")
        print(f"First side != Winner: {first_side_loses}")
        print(f"If bot stuck with first side, accuracy: {first_side_wins/total_markets*100:.1f}%")
        
        # Hedge timing statistics
        hedge_times = [r['hedge_seconds'] for r in all_results if r.get('hedge_seconds')]
        if hedge_times:
            print(f"\n--- Hedge Timing ---")
            print(f"Avg time to hedge: {statistics.mean(hedge_times):.1f} seconds")
            print(f"Min: {min(hedge_times)}s, Max: {max(hedge_times)}s")
        
        # First entry price distribution
        first_prices = [r['first_price'] for r in all_results if r.get('first_price')]
        if first_prices:
            print(f"\n--- First Entry Price ---")
            print(f"Avg: ${statistics.mean(first_prices):.4f}")
            print(f"Range: ${min(first_prices):.4f} - ${max(first_prices):.4f}")
            
            # First entry price vs win rate
            low_price_wins = sum(1 for r in all_results if r.get('first_price', 1) < 0.45 and r['won'])
            mid_price_wins = sum(1 for r in all_results if 0.45 <= r.get('first_price', 0) <= 0.55 and r['won'])
            high_price_wins = sum(1 for r in all_results if r.get('first_price', 0) > 0.55 and r['won'])
            
            low_price_total = sum(1 for r in all_results if r.get('first_price', 1) < 0.45)
            mid_price_total = sum(1 for r in all_results if 0.45 <= r.get('first_price', 0) <= 0.55)
            high_price_total = sum(1 for r in all_results if r.get('first_price', 0) > 0.55)
            
            print(f"\n--- Entry Price vs Win Rate ---")
            print(f"Low price (<$0.45): {low_price_wins}/{low_price_total} = {low_price_wins/low_price_total*100:.1f}%" if low_price_total > 0 else "Low price (<$0.45): N/A")
            print(f"Mid price ($0.45-0.55): {mid_price_wins}/{mid_price_total} = {mid_price_wins/mid_price_total*100:.1f}%" if mid_price_total > 0 else "Mid price: N/A")
            print(f"High price (>$0.55): {high_price_wins}/{high_price_total} = {high_price_wins/high_price_total*100:.1f}%" if high_price_total > 0 else "High price: N/A")
        
        # PnL analysis
        invested_list = [r['invested'] for r in all_results]
        print(f"\n--- Investment Stats ---")
        print(f"Total invested: ${sum(invested_list):.2f}")
        print(f"Avg per market: ${statistics.mean(invested_list):.2f}")
        
        # Realized PnL
        total_pnl = sum(r['pnl_if_winner'] for r in all_results)
        print(f"Hypothetical total PnL (if held): ${total_pnl:.2f}")
        
        # Entry price spread analysis
        print(f"\n--- Entry Price Spread (avg per side) ---")
        up_avg_prices = [r.get('up_avg_price', 0) for r in all_results if r.get('up_avg_price')]
        down_avg_prices = [r.get('down_avg_price', 0) for r in all_results if r.get('down_avg_price')]
        
        if up_avg_prices:
            print(f"Up side avg price: ${statistics.mean(up_avg_prices):.4f}")
        if down_avg_prices:
            print(f"Down side avg price: ${statistics.mean(down_avg_prices):.4f}")
        
        # Trade frequency
        total_trades = sum(r['total_trades'] for r in all_results)
        print(f"\n--- Trade Frequency ---")
        print(f"Total trades: {total_trades}")
        print(f"Avg trades per market: {total_trades/total_markets:.1f}")
        
        # Single vs dual sided
        dual_sided = sum(1 for r in all_results if r.get('both_sides'))
        single_sided = total_markets - dual_sided
        print(f"\n--- Position Type ---")
        print(f"Dual-sided (both Up & Down): {dual_sided}")
        print(f"Single-sided (one side only): {single_sided}")
        
        # Size vs outcome analysis
        print(f"\n--- Position Size vs Outcome ---")
        for r in all_results:
            if r.get('both_sides'):
                # Calculate which side was larger
                # We'll estimate based on invested amount
                pass
        
        # Win/Loss distribution
        wins_list = [r['pnl_if_winner'] for r in all_results if r['won']]
        losses_list = [r['pnl_if_winner'] for r in all_results if not r['won']]
        
        print(f"\n--- PnL Distribution ---")
        print(f"Wins: {len(wins_list)}, Avg PnL: ${statistics.mean(wins_list):.2f}" if wins_list else "Wins: 0")
        print(f"Losses: {len(losses_list)}, Avg PnL: ${statistics.mean(losses_list):.2f}" if losses_list else "Losses: 0")
        
        # First side breakdown
        up_first_wins = sum(1 for r in all_results if r['first_side'] == 'Up' and r['won'])
        up_first_total = sum(1 for r in all_results if r['first_side'] == 'Up')
        down_first_wins = sum(1 for r in all_results if r['first_side'] == 'Down' and r['won'])
        down_first_total = sum(1 for r in all_results if r['first_side'] == 'Down')
        
        print(f"\n--- First Side Performance ---")
        print(f"Up first: {up_first_wins}/{up_first_total} = {up_first_wins/up_first_total*100:.1f}%" if up_first_total > 0 else "Up first: N/A")
        print(f"Down first: {down_first_wins}/{down_first_total} = {down_first_wins/down_first_total*100:.1f}%" if down_first_total > 0 else "Down first: N/A")
        
        # Hedge timing vs outcome
        hedge_fast_wins = sum(1 for r in all_results if r.get('hedge_seconds') and r.get('hedge_seconds', 999) < 60 and r['won'])
        hedge_fast_total = sum(1 for r in all_results if r.get('hedge_seconds') and r.get('hedge_seconds', 999) < 60)
        hedge_slow_wins = sum(1 for r in all_results if r.get('hedge_seconds') and r.get('hedge_seconds', 0) >= 60 and r['won'])
        hedge_slow_total = sum(1 for r in all_results if r.get('hedge_seconds') and r.get('hedge_seconds', 0) >= 60)
        
        print(f"\n--- Hedge Timing vs Win Rate ---")
        print(f"Fast hedge (<60s): {hedge_fast_wins}/{hedge_fast_total} = {hedge_fast_wins/hedge_fast_total*100:.1f}%" if hedge_fast_total > 0 else "Fast hedge: N/A")
        print(f"Slow hedge (>=60s): {hedge_slow_wins}/{hedge_slow_total} = {hedge_slow_wins/hedge_slow_total*100:.1f}%" if hedge_slow_total > 0 else "Slow hedge: N/A")
        
        # Price range during trading vs outcome
        print(f"\n--- Trading Duration vs Outcome ---")
        short_markets = [r for r in all_results if r['total_trades'] < 50]
        long_markets = [r for r in all_results if r['total_trades'] >= 100]
        
        short_wins = sum(1 for r in short_markets if r['won'])
        long_wins = sum(1 for r in long_markets if r['won'])
        
        print(f"Short duration (<50 trades): {short_wins}/{len(short_markets)} = {short_wins/len(short_markets)*100:.1f}%" if short_markets else "N/A")
        print(f"Long duration (>=100 trades): {long_wins}/{len(long_markets)} = {long_wins/len(long_markets)*100:.1f}%" if long_markets else "N/A")
        
        # Avg price spread correlation
        print(f"\n--- Avg Price Spread vs Outcome ---")
        wide_spread_wins = sum(1 for r in all_results if r.get('up_avg_price') and r.get('down_avg_price') and abs(r['up_avg_price'] - r['down_avg_price']) > 0.3 and r['won'])
        narrow_spread_wins = sum(1 for r in all_results if r.get('up_avg_price') and r.get('down_avg_price') and abs(r['up_avg_price'] - r['down_avg_price']) <= 0.3 and r['won'])
        
        wide_spread_total = sum(1 for r in all_results if r.get('up_avg_price') and r.get('down_avg_price') and abs(r['up_avg_price'] - r['down_avg_price']) > 0.3)
        narrow_spread_total = sum(1 for r in all_results if r.get('up_avg_price') and r.get('down_avg_price') and abs(r['up_avg_price'] - r['down_avg_price']) <= 0.3)
        
        print(f"Wide spread (>0.30): {wide_spread_wins}/{wide_spread_total} = {wide_spread_wins/wide_spread_total*100:.1f}%" if wide_spread_total > 0 else "Wide spread: N/A")
        print(f"Narrow spread (<=0.30): {narrow_spread_wins}/{narrow_spread_total} = {narrow_spread_wins/narrow_spread_total*100:.1f}%" if narrow_spread_total > 0 else "Narrow spread: N/A")
    
    print("\n" + "="*60)
    print("ANALYSIS COMPLETE")
    print("="*60)

if __name__ == "__main__":
    main()