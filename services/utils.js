// /services/utils.js
export const CRYPTO_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'xrp',
  // 'temperature'
];

export const TIME_WINDOWS = {
  // bitcoin: 860, база
  // bitcoin: 870, 11/15
  bitcoin: 855,
  // ethereum: 75, плохо
  // ethereum: 65, 2/2
  ethereum: 55, 
  // solana: 125, плохо
  // solana: 280, плохо
  solana: 55, 
  // xrp: 280 плохо
  // xrp: 830 хорошо, 65%
  xrp: 55
};

export function nowTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function isCryptoMarket(opp) {
  const text = `${opp.title} ${opp.tooltipTitle || ''}`.toLowerCase();
  return CRYPTO_KEYWORDS.some(keyword => text.includes(keyword));
}