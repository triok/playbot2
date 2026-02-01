// /services/utils.js
export const CRYPTO_KEYWORDS = [
  'bitcoin',
  'ethereum',
  // 'solana',
  // 'xrp',
  // 'temperature',
  'lol',
  'dota',
  'honor',
  'Counter-Strike',
  'cs2',
  'valorant'
];

export const TIME_WINDOWS = {
  // bitcoin: 860, база
  // bitcoin: 870, 11/15
  // bitcoin: 55, 1/1
  // bitcoin: 58, 6/1 лучший 86%
  // bitcoin: 57, плохо 50%
  // bitcoin: 59, 0/2 плохо  
  bitcoin: 58,
  // ethereum: 75, плохо
  // ethereum: 65, 2/2
  // ethereum: 55, 0/1
  // ethereum: 50, 1/1
  // ethereum: 46, хорошо 7/2 78%
  ethereum: 46, 
  // solana: 125, плохо
  // solana: 280, плохо
  // solana: 55, 1/1
  // solana: 50, 0/1
  // solana: 46, 4/2 хорошо
  // solana: 43, не знаю
  // solana: 47, 0/1 плохо
  solana: 46,
  // xrp: 280 плохо
  // xrp: 830 хорошо, 65%
  // xrp: 55 2,1
  // xrp: 48 лучший 8/1 89%
  xrp: 48
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

export function formatMoscowDateTime(utcTime) {
  const date = new Date(utcTime);
  
  return date.toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}