export interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

export interface PolymarketEvent {
  id: string;
  title: string;
  description: string;
  end_date: string; // ISO Date string
  volume: number;
  active: boolean;
  closed: boolean;
  markets: PolymarketMarket[];
}

export interface PolymarketMarket {
  id: string;
  question: string;
  condition_id: string;
  slug: string;
  end_date_iso: string;
  outcomes: string[]; // JSON string array
  outcomePrices: string[]; // JSON string array of numbers
  volume: number;
  active: boolean;
  closed: boolean;
}

// Internal type for the UI after processing
export interface Opportunity {
  uuid: string; 
  id: string;
  title: string;
  outcomeName: string;
  sportsMarketType: string;
  currentPrice: number;
  profitPotential: number; // percentage
  timeLeft: string;
  rawEndDate: Date;
  volume: number;
  slug: string;
  resolvedOutcome?: string;
  resultChecked?: boolean;  
  orderMinSize: number;
  orderPriceMinTickSize: number;
  negRisk: boolean;
  order?: number;
  keyword?: string; 
  marketType?: string; 
  live: boolean;
  startDate: string;
}

export interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export type ExecutedBid = {
  status: 'placing' | 'success' | 'failed';
  orderID?: string;
};

export type MarketResolution = {
  winningAssetId: string;
  winningOutcome: string;
  resolvedAt: number;
};

export type LockedAutoBid = {
  outcomeName: string;
  assetId: string;
  price: number;
  lockedAt: number;
};

export type DeferredBid = {
  stage: "waiting_price" | "armed";
  createdAt: number;
};

