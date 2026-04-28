# PlayBot 2 - Agent Guidelines

## Project Overview

- **Type**: Polymarket trading bot (React frontend + Node.js backend)
- **Frontend**: React 19 + TypeScript, Vite bundler (port 14883)
- **Backend**: Node.js + Express, WebSocket (port 3002)
- **Purpose**: Automated arbitrage trading on Polymarket crypto markets

## Commands

```bash
# Backend only
npm start           # or: npm run backend
# Starts Express server on port 3002

# Frontend only
npm run dev         # or: npm run frontend
# Starts Vite dev server on port 14883

# Both servers
npm run start-all   # Runs backend + frontend with concurrently

# Production
npm run build       # Builds frontend for production
npm run preview     # Preview production build
```

## Code Style Guidelines

### File Naming

| Type | Extension | Example |
|------|-----------|---------|
| React components | `.tsx` | `App.tsx`, `Console.tsx` |
| TypeScript utilities | `.ts` | `types.ts`, `timeUtils.ts` |
| Backend services | `.js` | `autoBidBot.js`, `placeOrder.js` |

### Imports

```typescript
// ES modules required (type: module in package.json)
import { something } from './module.js';
import { something } from '@/services/module';  // path alias

// React imports
import React, { useState, useCallback, useEffect, useRef } from 'react';

// External libs
import { Activity } from 'lucide-react';
```

### TypeScript

```typescript
// Use interfaces from types.ts
import { Opportunity, LogEntry } from './types';

// Define component props interfaces
interface ConsoleProps {
  logs: LogEntry[];
}

// Avoid 'any' - use proper types
const [data, setData] = useState<Record<string, number>>({});

// Type narrowing for API responses
if (!response.ok) {
  throw new Error('Failed to fetch');
}
```

### React Components

```typescript
// Component file structure:
// 1. Imports
// 2. Interfaces (if needed)
// 3. Component function
// 4. Props destructuring
// 5. Hooks (useState, useEffect, useCallback, useMemo, useRef)
// 6. Helper functions
// 7. JSX return

export default function App() {
  const [state, setState] = useState<Type>(initialValue);
  const ref = useRef<Type>(null);
  
  const handleAction = useCallback((param: Type) => {
    // logic
  }, [dependency]);
  
  return <div>...</div>;
}
```

### Error Handling

```javascript
// Backend pattern (async functions)
try {
  const result = await someAsyncOperation();
  return { success: true, data: result };
} catch (error) {
  console.error("❌ Error description:", error);
  return { success: false, error: error.message };
}

// Frontend pattern (async handlers)
async function handleSubmit() {
  try {
    const res = await fetch('/api/endpoint', { method: 'POST' });
    if (!res.ok) throw new Error('Request failed');
    const data = await res.json();
    // success
  } catch (err) {
    console.error('Failed to submit', err);
    addLog('❌ Operation failed', 'error');
  }
}
```

### Styling

- **Use Tailwind CSS** for all styling
- Dark theme classes: `bg-slate-900`, `text-slate-200`, `border-slate-700`
- Utility classes: `flex`, `gap-4`, `p-4`, `rounded-lg`, `shadow-xl`
- Conditional classes: `className={condition ? 'bg-green' : 'bg-red'}`

## Architecture

### Server/Client Separation

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│  Node.js Server │◄─────────────────►│  React Frontend │
│   (port 3002)   │    JSON messages   │  (port 14883)   │
├─────────────────┤                    └─────────────────┤
│ - Business logic│                    │ - UI rendering   │
│ - Order placement│                   │ - State management│
│ - Market data   │                    │ - User controls   │
│ - Price caching  │                    │                  │
└─────────────────┘                    └─────────────────┘
```

### WebSocket Message Types

```typescript
// Client → Server
{ type: 'get_full_market_info', conditionId, slug }
{ type: 'get_order_book', assetId, slug }

// Server → Client
{ type: 'opportunities_snapshot', data: Opportunity[] }
{ type: 'price_change', data: { id, outcomes, bestOutcome } }
{ type: 'balance_snapshot', balance }
{ type: 'auto_bid_tracking', data: { id, text } }
{ type: 'order_book', data: { conditionId, orderBook } }
```

### State Management

- **Server**: `marketStates`, `marketCache`, `botState` modules
- **Client**: React `useState`, `useRef` for mutable values
- **Communication**: WebSocket + broadcast pattern

### Key Modules

| Module | Purpose |
|--------|---------|
| `services/autoBidBot.js` | Main trading logic, recalculate function |
| `services/marketCache.js` | Cached opportunities, market data |
| `services/placeOrder.js` | Order placement logic |
| `services/wsClientHandler.js` | WebSocket client management |
| `services/broadcast.js` | WebSocket broadcasting |
| `services/eventBus.js` | Internal event system |

## Common Tasks

### Adding a new API endpoint

1. Add route in `server.js`
2. Create handler function or import from service
3. Return consistent JSON: `{ success: boolean, data?: any, error?: string }`

### Adding a new WebSocket message type

1. Add handler in appropriate WebSocket module
2. Add type constant for consistency
3. Document in Architecture section above

### Modifying trading logic

- Core logic in `services/autoBidBot.js`
- Recalculate function handles position management
- Entry/exit parameters configurable via config object

## Optimized Bot Configuration

**File:** `bot_config_optimized.js`

**Backtest Results (v3 - with min 5 shares entry):**
- PnL: +$44.72
- Win Rate: 65.50%
- Total Invested: $19,561
- ROI: 0.23%

**Configuration Parameters:**
| Parameter | Value | Description |
|-----------|-------|-------------|
| entry_price | 0.50 | Entry price for initial orders |
| entry_bid_size | 5 | Initial bid size (minimum 5 shares) |
| budget_limit | 15 | Max budget per market |
| max_market_loss | 2 | Hard stop - max loss per market |
| rf_profit | 0.15 | Risk-free profit target (15%) |
| hedge50_profit | 0.20 | Hedge 50% profit target (20%) |
| arbitrage_profit | 0.40 | Arbitrage profit target (40%) |

**Usage:**
```javascript
import { OPTIMIZED_CONFIG } from './bot_config_optimized.js';

const bot = createAutoBidBot({
  // ... other params
  config: OPTIMIZED_CONFIG
});
```

**Usage:**
```javascript
import { OPTIMIZED_CONFIG } from './bot_config_optimized.js';

const bot = createAutoBidBot({
  // ... other params
  config: OPTIMIZED_CONFIG
});
```
